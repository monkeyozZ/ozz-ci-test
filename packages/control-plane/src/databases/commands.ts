import { Prisma } from '@ozz/database';
import { withWritableControlPlane } from '../recovery.js';
import {
  json,
  lockService,
  requireIdle,
  requireServiceRevision,
  serviceInclude,
  type ServiceRecord,
} from '../services/persistence.js';
import { integer, record, resourceId } from '../services/validation.js';
import { OperationRequestError, pageLimit } from '../tasks/contracts.js';
import { TaskRepository } from '../tasks/repository.js';
import {
  DATABASE_BINDING_LIMIT,
  type DatabaseBindingCollection,
  type DatabaseBindingInput,
  type DatabaseBindingPreview,
  type DatabaseListQuery,
  type DatabaseOutputKey,
  type DatabaseOutputMapping,
  type DataIssue,
  type ServiceDeletionPreview,
} from './contracts.js';
import {
  captureDatabaseBinding,
  databaseConsumers,
  databaseInclude,
  databaseObservation,
  requireDatabase,
} from './persistence.js';
import { presentDatabase } from './views.js';

const outputs = {
  postgresql: ['host', 'port', 'database', 'user', 'password'],
  redis: ['host', 'port', 'db', 'password'],
} as const;
function validateBinding(value: DatabaseBindingInput): DatabaseBindingInput {
  record(value, ['revision', 'databaseInstanceId', 'profile', 'mapping'], '数据库连接');
  integer(value.revision, 1, 2147483647, '版本');
  resourceId(value.databaseInstanceId);
  if (
    !['fields', 'url'].includes(value.profile) ||
    !value.mapping ||
    typeof value.mapping !== 'object' ||
    Array.isArray(value.mapping)
  )
    throw new OperationRequestError(
      422,
      'DATABASE_BINDING_INVALID',
      '连接输出模式或变量映射无效。',
    );
  // Optional output fields on transformed HTTP DTOs are present with undefined values.
  const entries = Object.entries(value.mapping).filter(([, name]) => name !== undefined);
  if (
    !entries.length ||
    entries.length > 6 ||
    entries.some(
      ([, name]) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name),
    ) ||
    new Set(entries.map(([, name]) => name)).size !== entries.length
  )
    throw new OperationRequestError(
      422,
      'DATABASE_BINDING_INVALID',
      '变量映射需要 1–6 个不同且有效的变量名。',
    );
  return { ...value, mapping: Object.fromEntries(entries) };
}
async function mappingIssues(
  tx: Prisma.TransactionClient,
  consumer: ServiceRecord,
  input: DatabaseBindingInput,
): Promise<DataIssue[]> {
  const provider = await requireDatabase(tx, input.databaseInstanceId);
  const valid =
    input.profile === 'url' ? ['url'] : outputs[provider.engine as 'postgresql' | 'redis'];
  const issues: DataIssue[] = [];
  for (const key of Object.keys(input.mapping))
    if (!(valid as readonly string[]).includes(key))
      issues.push({
        code: 'DATABASE_OUTPUT_INVALID',
        field: `mapping.${key}`,
        blocks: 'both',
        message: '所选数据库不提供此输出字段。',
      });
  const manual = consumer.configJson as { environment: { name: string }[] };
  const other = await tx.databaseBinding.findMany({
    where: {
      consumerServiceId: consumer.id,
      desired: true,
      databaseInstanceId: { not: provider.id },
    },
    select: { mappingJson: true },
  });
  const occupied = new Set([
    ...(manual.environment ?? []).map((entry) => entry.name),
    ...other.flatMap((entry) => Object.values(entry.mappingJson as DatabaseOutputMapping)),
  ]);
  for (const [key, name] of Object.entries(input.mapping))
    if (occupied.has(name))
      issues.push({
        code: 'DATABASE_VARIABLE_CONFLICT',
        field: `mapping.${key}`,
        blocks: 'both',
        message: `变量 ${name} 已由手工配置或其他数据库连接定义。`,
      });
  if (
    consumer.kind !== 'application' ||
    provider.service?.id === consumer.id ||
    consumer.environmentId !== provider.dataVolume.environmentId
  )
    issues.push({
      code: 'DATABASE_TARGET_MISMATCH',
      field: 'databaseInstanceId',
      blocks: 'both',
      message: '只能引用同环境中独立的数据库提供方。',
    });
  if (!provider.service || provider.service.activeMutation || !databaseObservation(provider).ready)
    issues.push({
      code: 'DATABASE_DEPENDENCY_NOT_READY',
      field: 'databaseInstanceId',
      blocks: 'both',
      message: '请等待数据库发布与认证检查就绪。',
    });
  return issues;
}

export async function assertDatabaseVariableConfiguration(
  tx: Prisma.TransactionClient,
  serviceId: string,
  names: readonly string[],
): Promise<void> {
  const bindings = await tx.databaseBinding.findMany({
    where: { consumerServiceId: serviceId, desired: true },
    select: { mappingJson: true },
  });
  const outputNames = new Set(
    bindings.flatMap((binding) => Object.values(binding.mappingJson as DatabaseOutputMapping)),
  );
  if (names.some((name) => outputNames.has(name)))
    throw new OperationRequestError(
      422,
      'DATABASE_VARIABLE_CONFLICT',
      '手工变量与数据库连接输出重名，请先修改连接映射。',
    );
}

export class DatabaseCommands {
  constructor(readonly repository: TaskRepository) {}
  async get(id: string) {
    return presentDatabase(
      this.repository.db,
      await requireDatabase(this.repository.db, resourceId(id)),
    );
  }
  async forService(serviceId: string) {
    const row = await this.repository.db.databaseInstance.findUnique({
      where: { serviceId: resourceId(serviceId) },
      include: databaseInclude,
    });
    if (!row) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '该服务没有数据库实例。');
    return presentDatabase(this.repository.db, row);
  }
  async list(query: DatabaseListQuery = {}) {
    const limit = pageLimit(query.limit);
    let cursor: Prisma.DatabaseInstanceWhereInput = {};
    if (query.cursor) {
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(query.cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
          id: string;
          createdAt: string;
        };
        resourceId(value.id);
        const date = new Date(value.createdAt);
        if (!Number.isFinite(date.getTime())) throw new Error();
        cursor = { OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: value.id } }] };
      } catch {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '数据库分页游标无效。');
      }
    }
    const filters: Prisma.DatabaseInstanceWhereInput[] = [cursor];
    if (query.serviceId) filters.push({ serviceId: resourceId(query.serviceId) });
    if (query.environmentId)
      filters.push({
        dataVolume: {
          targetJson: { path: ['environmentId'], equals: resourceId(query.environmentId) },
        },
      });
    if (query.clusterId)
      filters.push({
        dataVolume: { targetJson: { path: ['clusterId'], equals: resourceId(query.clusterId) } },
      });
    if (query.projectId)
      filters.push({
        dataVolume: { targetJson: { path: ['projectId'], equals: resourceId(query.projectId) } },
      });
    if (query.search)
      filters.push({
        OR: [
          { service: { name: { contains: query.search.slice(0, 120), mode: 'insensitive' } } },
          { dataVolume: { name: { contains: query.search.slice(0, 120), mode: 'insensitive' } } },
        ],
      });
    const rows = await this.repository.db.databaseInstance.findMany({
      where: { AND: filters },
      include: databaseInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const visible = rows.slice(0, limit),
      last = visible.at(-1);
    return {
      data: await Promise.all(visible.map((row) => presentDatabase(this.repository.db, row))),
      page: {
        hasMore: rows.length > limit,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() }),
              ).toString('base64url')
            : null,
      },
    };
  }
  private async collection(
    tx: Prisma.TransactionClient,
    service: ServiceRecord,
  ): Promise<DatabaseBindingCollection> {
    const rows = await tx.databaseBinding.findMany({
      where: {
        consumerServiceId: service.id,
        OR: [
          { desired: true },
          { deploymentReferences: { some: { deployment: { publishedBy: { id: service.id } } } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        database: { include: databaseInclude },
        deploymentReferences: {
          where: { deployment: { publishedBy: { id: service.id } } },
          select: { deploymentId: true },
        },
      },
    });
    if (rows.length > DATABASE_BINDING_LIMIT * 2)
      throw new OperationRequestError(
        409,
        'DATABASE_BINDING_INVENTORY_TOO_LARGE',
        '绑定集合超过可完整展示的范围，请先完成待发布解绑。',
      );
    return {
      data: rows.map((row) => ({
        id: row.id,
        databaseInstanceId: row.databaseInstanceId,
        revision: row.revision,
        profile: row.profile as 'fields' | 'url',
        mapping: row.mappingJson as DatabaseOutputMapping,
        desired: row.desired,
        provider: {
          serviceId: row.database.serviceId,
          name: row.database.service?.name ?? row.database.dataVolume.name,
          engine: row.database.engine as 'postgresql' | 'redis',
          ready: databaseObservation(row.database).ready,
        },
        published: row.deploymentReferences.length > 0,
        issues: !row.database.serviceId
          ? [
              {
                code: 'DATABASE_PROVIDER_REMOVED',
                field: 'databaseInstanceId',
                blocks: 'deploy' as const,
                message: '提供方服务已经移除，原数据身份仍保留。',
              },
            ]
          : [],
      })),
      serviceRevision: service.revision,
      configRevision: service.configRevision,
    };
  }
  async bindings(serviceId: string) {
    const service = await this.repository.db.service.findUnique({
      where: { id: resourceId(serviceId) },
      include: serviceInclude,
    });
    if (!service) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '消费者服务不存在。');
    return this.collection(this.repository.db, service);
  }
  async preview(serviceId: string, input: DatabaseBindingInput): Promise<DatabaseBindingPreview> {
    input = validateBinding(input);
    const service = await this.repository.db.service.findUnique({
      where: { id: resourceId(serviceId) },
      include: serviceInclude,
    });
    if (!service) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '消费者服务不存在。');
    requireServiceRevision(service, input.revision);
    const prior = await this.repository.db.databaseBinding.findUnique({
      where: {
        consumerServiceId_databaseInstanceId: {
          consumerServiceId: service.id,
          databaseInstanceId: input.databaseInstanceId,
        },
      },
    });
    return {
      databaseInstanceId: input.databaseInstanceId,
      profile: input.profile,
      mapping: input.mapping,
      variables: Object.entries(input.mapping).map(([output, name]) => ({
        name: name!,
        output: output as DatabaseOutputKey,
        secret: output === 'password' || output === 'url',
        change: prior?.desired ? 'replace' : 'add',
      })),
      issues: await mappingIssues(this.repository.db, service, input),
      serviceRevision: service.revision,
    };
  }
  save(serviceId: string, input: DatabaseBindingInput) {
    resourceId(serviceId);
    input = validateBinding(input);
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, serviceId);
      requireServiceRevision(service, input.revision);
      requireIdle(service);
      await requireDatabase(tx, input.databaseInstanceId, true);
      const issues = await mappingIssues(tx, service, input);
      if (issues.length)
        throw new OperationRequestError(
          issues[0]!.code === 'DATABASE_DEPENDENCY_NOT_READY' ? 409 : 422,
          issues[0]!.code,
          issues[0]!.message,
        );
      const prior = await tx.databaseBinding.findUnique({
        where: {
          consumerServiceId_databaseInstanceId: {
            consumerServiceId: serviceId,
            databaseInstanceId: input.databaseInstanceId,
          },
        },
      });
      if (
        !prior?.desired &&
        (await tx.databaseBinding.count({
          where: { consumerServiceId: serviceId, desired: true },
        })) >= DATABASE_BINDING_LIMIT
      )
        throw new OperationRequestError(
          422,
          'DATABASE_BINDING_LIMIT',
          '单服务最多引用 8 个数据库。',
        );
      const binding = await tx.databaseBinding.upsert({
        where: {
          consumerServiceId_databaseInstanceId: {
            consumerServiceId: serviceId,
            databaseInstanceId: input.databaseInstanceId,
          },
        },
        create: {
          consumerServiceId: serviceId,
          databaseInstanceId: input.databaseInstanceId,
          profile: input.profile,
          mappingJson: json(input.mapping),
        },
        update: {
          desired: true,
          profile: input.profile,
          mappingJson: json(input.mapping),
          revision: { increment: 1 },
        },
      });
      await captureDatabaseBinding(tx, service, binding);
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: { revision: { increment: 1 }, configRevision: { increment: 1 } },
        include: serviceInclude,
      });
      return this.collection(tx, updated);
    });
  }
  remove(serviceId: string, bindingId: string, revision: number) {
    resourceId(serviceId);
    resourceId(bindingId);
    integer(revision, 1, 2147483647, '版本');
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, serviceId);
      requireServiceRevision(service, revision);
      requireIdle(service);
      const changed = await tx.databaseBinding.updateMany({
        where: { id: bindingId, consumerServiceId: serviceId, desired: true },
        data: { desired: false, revision: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '连接草稿不存在或已经解除。');
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: { revision: { increment: 1 }, configRevision: { increment: 1 } },
        include: serviceInclude,
      });
      return this.collection(tx, updated);
    });
  }
  async deletionPreview(serviceId: string, revision: number): Promise<ServiceDeletionPreview> {
    resourceId(serviceId);
    integer(revision, 1, 2147483647, '版本');
    const service = await this.repository.db.service.findUnique({
      where: { id: serviceId },
      include: serviceInclude,
    });
    if (!service) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '服务不存在。');
    requireServiceRevision(service, revision);
    const mounts = await this.repository.db.volumeMount.findMany({
      where: { serviceId, detachedAt: null },
      include: { volume: { include: { database: { select: { id: true } } } } },
    });
    const consumers = service.database
      ? await databaseConsumers(this.repository.db, service.database.id)
      : { consumers: [], truncated: false };
    return {
      serviceId,
      revision,
      retainedVolumes: mounts.map(({ volume }) => ({
        id: volume.id,
        name: volume.name,
        pvcUid: volume.pvcUid,
        databaseInstanceId: volume.database?.id ?? null,
      })),
      databaseConsumers: consumers.consumers,
      blockers: [
        ...(service.activeMutation
          ? [
              {
                code: 'SERVICE_OPERATION_ACTIVE',
                field: null,
                blocks: 'both' as const,
                message: '请先等待当前服务任务结束。',
              },
            ]
          : []),
        ...(consumers.consumers.length || consumers.truncated
          ? [
              {
                code: 'DATABASE_DEPENDENCY_IN_USE',
                field: null,
                blocks: 'both' as const,
                message: '仍有消费者依赖此数据库，需先解除并发布消费者配置。',
              },
            ]
          : []),
      ],
      dataRetentionMessage:
        '服务删除会停止工作负载并保留所有数据卷与数据库初始化凭证。PV 的回收策略仅在单独销毁卷时适用。',
    };
  }
}
