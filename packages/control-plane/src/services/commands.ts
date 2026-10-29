import { Prisma } from '@ozz/database';
import { createHash, randomBytes } from 'node:crypto';
import { parseImageReference } from '@ozz/infrastructure/registry';
import { canonicalJson } from '@ozz/infrastructure/build';
import { withWritableControlPlane } from '../recovery.js';
import { SecretCipher } from '../secrets.js';
import {
  OperationRequestError,
  pageLimit,
  validateIdempotencyKey,
  type ServiceOperationInput,
} from '../tasks/contracts.js';
import {
  TaskRepository,
  type OperationActor,
  type PreparedDeployment,
} from '../tasks/repository.js';
import type {
  CreateServiceInput,
  DeployServiceInput,
  RetryDeploymentInput,
  ServiceAction,
  ServiceActionInput,
  ServiceConfiguration,
  RuntimeConfiguration,
  ServiceListQuery,
  ServiceSnapshot,
  ServiceTarget,
  ServiceView,
  UpdateServiceInput,
} from './contracts.js';
import {
  assertServiceTarget,
  currentTarget,
  json,
  lockService,
  registryAccess,
  requireIdle,
  requireServiceRevision,
  saveConfigurationRelations,
  serviceInclude,
  storeConfiguration,
  type ServiceRecord,
} from './persistence.js';
import {
  integer,
  record,
  resourceId,
  text,
  validateRuntimeConfiguration,
  validateServiceConfiguration,
} from './validation.js';
import { presentService } from './views.js';
import { readServiceSnapshot, snapshotVolumes, snapshotDatabaseBindings } from './snapshots.js';
import { saveGitSource, validateGitSourceInput } from '../git/persistence.js';
import { compileTemplate } from '../templates/catalog.js';
import { assertDatabaseSnapshot, databaseSnapshot } from '../databases/protection.js';
import { assertDatabaseConfiguration } from '../databases/runtime.js';
import { assertDatabaseVariableConfiguration } from '../databases/commands.js';
import {
  assertDatabaseBindingSnapshots,
  assertDatabaseHasNoConsumers,
  captureDatabaseBindings,
  saveDatabaseDeploymentReferences,
} from '../databases/persistence.js';
import {
  admitVolumeMutation,
  assertServiceVolumeConfiguration,
  captureVolumeReferences,
  insertInitialVolumeMount,
  lockVolumes,
  requireVolumeIdle,
  reserveVolume,
  serviceVolumeIds,
} from '../storage/persistence.js';

function optionalDescription(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value, 1000, '描述', true);
}

const CREATE_REQUEST_FINGERPRINT_PURPOSE = 'service-create.v1';

function booleanOption(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean')
    throw new OperationRequestError(422, 'SERVICE_CONFIGURATION_INVALID', '操作确认必须为布尔值。');
  return value === true;
}

function readSnapshot(value: unknown): ServiceSnapshot {
  return readServiceSnapshot(value);
}

function operationTarget(target: ServiceTarget): ServiceOperationInput['target'] {
  return {
    installationId: target.installationId,
    clusterId: target.clusterId,
    kubeSystemUid: target.kubeSystemUid,
    projectId: target.projectId,
    environmentId: target.environmentId,
    namespace: target.namespace,
    serviceName: target.serviceName,
  };
}

/** Admission only: all network, registry and workload effects run in the Worker. */
export class ServiceCommands {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
  ) {}

  async get(id: string): Promise<ServiceView> {
    const value = await this.repository.db.service.findUnique({
      where: { id: resourceId(id) },
      include: serviceInclude,
    });
    if (!value) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '服务不存在。');
    return presentService(value);
  }

  async list(query: ServiceListQuery = {}) {
    const limit = pageLimit(query.limit);
    let cursor: Prisma.ServiceWhereInput = {};
    if (query.cursor) {
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
          id: string;
          createdAt: string;
        };
        resourceId(value.id);
        const date = new Date(value.createdAt);
        if (!Number.isFinite(date.getTime())) throw new Error();
        cursor = { OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: value.id } }] };
      } catch {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '分页游标无效。');
      }
    }
    const rows = await this.repository.db.service.findMany({
      where: {
        AND: [
          cursor,
          query.environmentId ? { environmentId: resourceId(query.environmentId) } : {},
          query.projectId ? { environment: { projectId: resourceId(query.projectId) } } : {},
          query.clusterId
            ? { environment: { project: { clusterId: resourceId(query.clusterId) } } }
            : {},
          query.search
            ? {
                OR: [
                  { name: { contains: text(query.search, 120, '搜索词'), mode: 'insensitive' } },
                  { slug: { contains: query.search, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      include: serviceInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    return {
      data: data.map(presentService),
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

  async create(
    input: CreateServiceInput,
    actor?: OperationActor,
    key?: unknown,
  ): Promise<ServiceView> {
    record(
      input,
      [
        'environmentId',
        'projectId',
        'name',
        'slug',
        'description',
        'registryCredentialRefId',
        'configuration',
        'template',
        'source',
      ],
      '服务',
    );
    if (Boolean(input.configuration) === Boolean(input.template))
      throw new OperationRequestError(
        422,
        'SERVICE_SOURCE_REQUIRED',
        '请选择完整镜像配置或固定模板，两者不能同时提交。',
      );
    const template = input.template ? compileTemplate(input.template) : null;
    const gitSource = input.source?.kind === 'github' ? input.source : null;
    if (input.source && !gitSource) record(input.source, ['kind'], '镜像来源');
    if (input.source && !['image', 'github'].includes(input.source.kind))
      throw new OperationRequestError(422, 'SERVICE_SOURCE_INVALID', '服务来源类型无效。');
    if (gitSource && (template || input.registryCredentialRefId))
      throw new OperationRequestError(
        422,
        'SERVICE_SOURCE_INVALID',
        'Git 应用须使用来源中固定的镜像仓库，不能同时选择模板。',
      );
    const idempotencyKey = template || key !== undefined ? validateIdempotencyKey(key) : null;
    if (template && !actor?.id)
      throw new OperationRequestError(
        422,
        'TEMPLATE_ACTOR_REQUIRED',
        '创建模板需要有效的操作者和幂等键。',
      );
    if (idempotencyKey && !actor?.id)
      throw new OperationRequestError(
        422,
        'SERVICE_ACTOR_REQUIRED',
        '创建服务需要有效的操作者和幂等键。',
      );
    const environmentId = resourceId(input.environmentId);
    const name = text(input.name, 120, '服务名').trim();
    const slug = text(input.slug, 63, '服务标识');
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug))
      throw new OperationRequestError(
        422,
        'SERVICE_SLUG_INVALID',
        '服务标识须以字母开头，并只包含小写字母、数字和单个连字符。',
      );
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const serviceScope = `service-create:${actor?.id ?? ''}`;
      const templateScope = `template-create:${actor?.id ?? ''}`;
      const scope = template ? templateScope : serviceScope;
      const request = {
        environmentId,
        name,
        slug,
        description: optionalDescription(input.description),
        projectId: input.projectId ?? null,
        registryCredentialRefId: input.registryCredentialRefId ?? null,
        template: template
          ? {
              id: template.template.id,
              version: template.template.version,
              parameters: template.parameters,
            }
          : null,
      };
      const fingerprintPayload =
        !template && idempotencyKey
          ? canonicalJson({
              ...request,
              configuration: gitSource
                ? validateRuntimeConfiguration(input.configuration)
                : validateServiceConfiguration(input.configuration),
              source: gitSource ? validateGitSourceInput(gitSource) : { kind: 'image' },
            })
          : '';
      // Template parameters are public and preserve their existing receipt format.
      // Other sources can contain secret values, so a keyed fingerprint is required.
      const requestHash = template
        ? createHash('sha256').update(JSON.stringify(request)).digest('hex')
        : idempotencyKey
          ? this.cipher.requestFingerprint(CREATE_REQUEST_FINGERPRINT_PURPOSE, fingerprintPayload)
          : '';
      if (idempotencyKey) {
        // One key covers every source. Also take the existing template lock so
        // older template admissions cannot race a newly keyed image/Git request.
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${serviceScope}), hashtext(${idempotencyKey}))`,
        );
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${templateScope}), hashtext(${idempotencyKey}))`,
        );
        const receipt = await tx.commandReceipt.findFirst({
          where: { idempotencyKey, idempotencyScope: { in: [serviceScope, templateScope] } },
        });
        if (receipt) {
          const sameRequest = template
            ? receipt.requestHash === requestHash
            : this.cipher.matchesRequestFingerprint(
                CREATE_REQUEST_FINGERPRINT_PURPOSE,
                fingerprintPayload,
                receipt.requestHash,
              );
          if (receipt.idempotencyScope !== scope || !sameRequest)
            throw new OperationRequestError(
              409,
              'IDEMPOTENCY_CONFLICT',
              '该幂等键已经用于另一份服务创建请求。',
            );
          return receipt.resultJson as unknown as ServiceView;
        }
      }
      const environment = await tx.environment.findUnique({
        where: { id: environmentId },
        include: { project: { include: { cluster: true } } },
      });
      if (!environment)
        throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '目标环境不存在。');
      if (input.projectId && environment.projectId !== resourceId(input.projectId))
        throw new OperationRequestError(
          422,
          'SERVICE_ENVIRONMENT_MISMATCH',
          '环境不属于当前项目。',
        );
      if (!environment.project.cluster.kubeSystemUid)
        throw new OperationRequestError(
          409,
          'CLUSTER_NOT_CONNECTED',
          '请先验证项目的集群连接，再创建服务。',
        );
      const configuration =
        template?.configuration ??
        (await storeConfiguration(
          tx,
          this.cipher,
          input.configuration,
          gitSource ? 'github' : 'image',
        ));
      const reference =
        input.registryCredentialRefId == null ? null : resourceId(input.registryCredentialRefId);
      if (!gitSource)
        await this.checkRegistry(tx, reference, validateServiceConfiguration(configuration).image);
      const service = await tx.service.create({
        data: {
          name,
          slug,
          environmentId,
          description: optionalDescription(input.description),
          registryCredentialRefId: reference,
          configJson: json(configuration),
          kind: template?.database ? 'database' : 'application',
          templateId: template?.template.id,
          templateVersion: template?.template.version,
          sourceKind: gitSource ? 'github' : 'image',
        },
      });
      await saveConfigurationRelations(tx, service.id, configuration);
      if (gitSource) await saveGitSource(tx, this.cipher, service.id, gitSource);
      if (template?.database && template.volume) {
        const credential = await tx.secretReference.create({
          data: {
            name: `${name} 初始化凭证`.slice(0, 120),
            kind: 'database',
            ...this.cipher.encrypt('database', { password: randomBytes(32).toString('base64url') }),
          },
        });
        const volume = await reserveVolume(tx, {
          environmentId,
          name: `${name} 数据`.slice(0, 120),
          slug: `${slug.slice(0, 49)}-data-${service.id.slice(0, 8)}`,
          requestedBytes: template.volume.requestedBytes,
          storageClassName: 'local-path',
        });
        await tx.databaseInstance.create({
          data: {
            serviceId: service.id,
            dataVolumeId: volume.id,
            originalServiceJson: { id: service.id, name, slug },
            ...template.database,
            templateId: template.template.id,
            templateVersion: template.template.version,
            image: template.configuration.image,
            credentialRefId: credential.id,
            credentialContentRevision: credential.contentRevision,
          },
        });
        await insertInitialVolumeMount(tx, service, volume, {
          mountPath: template.volume.mountPath,
          readOnly: false,
        });
      }
      const view = presentService(
        await tx.service.findUniqueOrThrow({ where: { id: service.id }, include: serviceInclude }),
      );
      if (idempotencyKey)
        await tx.commandReceipt.create({
          data: { idempotencyScope: scope, idempotencyKey, requestHash, resultJson: json(view) },
        });
      return view;
    });
  }

  async update(id: string, input: UpdateServiceInput): Promise<ServiceView> {
    resourceId(id);
    const raw = record(
      input,
      [
        'revision',
        'environmentId',
        'projectId',
        'name',
        'description',
        'registryCredentialRefId',
        'configuration',
      ],
      '服务修改',
    );
    integer(input.revision, 1, 2147483647, '版本');
    if (!Object.keys(raw).some((key) => !['revision', 'projectId'].includes(key)))
      throw new OperationRequestError(422, 'NO_CHANGES', '请提供需要修改的字段。');
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const current = await lockService(tx, id);
      requireServiceRevision(current, input.revision);
      let environmentId = current.environmentId;
      if (input.projectId && input.projectId !== current.environment.projectId)
        throw new OperationRequestError(
          422,
          'SERVICE_ENVIRONMENT_MISMATCH',
          '服务不属于当前项目。',
        );
      if (input.environmentId && input.environmentId !== current.environmentId) {
        requireIdle(current);
        if (
          current.remoteCreatedAt ||
          current.database ||
          current.volumeMounts.length ||
          (await tx.databaseBinding.count({ where: { consumerServiceId: id, desired: true } }))
        )
          throw new OperationRequestError(
            409,
            'SERVICE_TARGET_LOCKED',
            '服务已创建远端资源，请通过复制新服务更换环境。',
          );
        const environment = await tx.environment.findUnique({
          where: { id: resourceId(input.environmentId) },
        });
        if (!environment || environment.projectId !== current.environment.projectId)
          throw new OperationRequestError(
            422,
            'SERVICE_ENVIRONMENT_MISMATCH',
            '只能选择同项目的环境。',
          );
        environmentId = environment.id;
      }
      const configuration = input.configuration
        ? await storeConfiguration(
            tx,
            this.cipher,
            input.configuration,
            current.sourceKind === 'github' ? 'github' : 'image',
          )
        : (current.configJson as unknown as ServiceConfiguration | RuntimeConfiguration);
      if (input.configuration) {
        if (current.sourceKind !== 'github')
          await assertDatabaseConfiguration(
            tx,
            current,
            validateServiceConfiguration(configuration),
          );
        await assertServiceVolumeConfiguration(tx, id, configuration);
        await assertDatabaseVariableConfiguration(
          tx,
          id,
          configuration.environment.map((variable) => variable.name),
        );
      }
      const reference =
        input.registryCredentialRefId === undefined
          ? current.registryCredentialRefId
          : input.registryCredentialRefId === null
            ? null
            : resourceId(input.registryCredentialRefId);
      if (current.sourceKind === 'github' && input.registryCredentialRefId != null)
        throw new OperationRequestError(
          422,
          'GIT_REGISTRY_FIXED',
          'Git 应用使用来源中固定的镜像仓库连接。',
        );
      if (
        current.sourceKind !== 'github' &&
        (input.registryCredentialRefId !== undefined || input.configuration)
      )
        await this.checkRegistry(tx, reference, validateServiceConfiguration(configuration).image);
      await tx.service.update({
        where: { id },
        data: {
          environmentId,
          ...(input.name !== undefined ? { name: text(input.name, 120, '服务名').trim() } : {}),
          ...(input.description !== undefined
            ? { description: optionalDescription(input.description) }
            : {}),
          registryCredentialRefId: reference,
          revision: { increment: 1 },
          ...(input.configuration
            ? { configRevision: { increment: 1 }, configJson: json(configuration) }
            : {}),
        },
      });
      if (input.configuration) await saveConfigurationRelations(tx, id, configuration);
      return presentService(
        await tx.service.findUniqueOrThrow({ where: { id }, include: serviceInclude }),
      );
    });
  }

  private async checkRegistry(
    tx: Prisma.TransactionClient,
    reference: string | null,
    image: string,
  ) {
    const access = await registryAccess(tx, this.cipher, reference);
    if (access && access.registry !== parseImageReference(image).registry)
      throw new OperationRequestError(
        422,
        'REGISTRY_ACCESS_MISMATCH',
        '拉取凭证与镜像仓库不匹配。',
      );
  }

  deploy(id: string, input: DeployServiceInput, actor: OperationActor, key: unknown) {
    record(input, ['revision', 'deployAndStart', 'allowConfigurationRepair'], '发布请求');
    resourceId(id);
    integer(input.revision, 1, 2147483647, '版本');
    const deployAndStart = booleanOption(input.deployAndStart);
    const allowConfigurationRepair = booleanOption(input.allowConfigurationRepair);
    return this.repository.enqueueDeployment(
      actor,
      key,
      { request: { id, ...input } },
      async (tx) => {
        const service = await lockService(tx, id);
        requireServiceRevision(service, input.revision);
        requireIdle(service);
        if (service.sourceKind === 'github')
          throw new OperationRequestError(
            409,
            'GIT_PREVIEW_REQUIRED',
            '请先预览 Git commit，并提交原预览身份。',
          );
        const target = await currentTarget(tx, service);
        const volumes = await captureVolumeReferences(tx, service);
        const snapshot: ServiceSnapshot = {
          version: 2,
          serviceId: id,
          serviceName: service.name,
          serviceSlug: service.slug,
          configRevision: service.configRevision,
          configuration: service.configJson as unknown as ServiceConfiguration,
          deployAndStart,
          allowConfigurationRepair,
          controller: service.database
            ? { kind: 'StatefulSet', strategy: 'RollingUpdate' }
            : {
                kind: 'Deployment',
                strategy: volumes.some((volume) => !volume.readOnly) ? 'Recreate' : 'RollingUpdate',
              },
          volumes,
          database: service.database ? databaseSnapshot(service.database) : null,
          databaseBindings: await captureDatabaseBindings(tx, service),
          template:
            service.templateId && service.templateVersion
              ? { id: service.templateId, version: service.templateVersion }
              : null,
        };
        return this.prepareDeployment(tx, service, target, snapshot);
      },
    );
  }

  async retryDeployment(
    id: string,
    input: RetryDeploymentInput,
    actor: OperationActor,
    key: unknown,
  ) {
    resourceId(id);
    record(input, ['revision', 'deployAndStart', 'allowConfigurationRepair'], '发布重试');
    integer(input.revision, 1, 2147483647, '版本');
    const initial = await this.repository.db.deployment.findUnique({
      where: { id },
      select: { kind: true },
    });
    if (!initial) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '原发布不存在。');
    return this.repository.enqueueDeployment(
      actor,
      key,
      {
        kind: initial.kind === 'git_deploy' ? 'git_deploy' : 'image_deploy',
        request: { id, ...input },
        retryOfId: id,
      },
      async (tx) => {
        const original = await tx.deployment.findUnique({ where: { id } });
        if (!original || !original.serviceId)
          throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '原发布或服务不存在。');
        const service = await lockService(tx, original.serviceId);
        requireServiceRevision(service, input.revision);
        requireIdle(service);
        if (!['failed', 'cancelled'].includes(original.status))
          throw new OperationRequestError(
            409,
            'DEPLOYMENT_NOT_RETRYABLE',
            '只能重试已失败或取消的发布。',
          );
        if (service.mutationRevision !== original.mutationRevision)
          throw new OperationRequestError(
            409,
            'SERVICE_TASK_SUPERSEDED',
            '此发布后已有新的服务操作，请从当前配置重新发布。',
          );
        const target = original.targetJson as unknown as ServiceTarget;
        await assertServiceTarget(tx, service, target);
        const snapshot: ServiceSnapshot = {
          ...readSnapshot(original.snapshotJson),
          deployAndStart: booleanOption(input.deployAndStart),
          allowConfigurationRepair: booleanOption(input.allowConfigurationRepair),
        };
        const prepared = await this.prepareDeployment(tx, service, target, snapshot);
        if (original.resolvedImageJson)
          prepared.resolvedImageJson = original.resolvedImageJson as Prisma.InputJsonValue;
        if (original.artifactId) prepared.reuseArtifactId = original.artifactId;
        return prepared;
      },
    );
  }

  async prepareDeployment(
    tx: Prisma.TransactionClient,
    service: ServiceRecord,
    target: ServiceTarget,
    snapshot: ServiceSnapshot,
  ): Promise<PreparedDeployment> {
    await assertDatabaseSnapshot(tx, service.id, snapshot.version === 2 ? snapshot.database : null);
    if (snapshot.version !== 3)
      await assertDatabaseConfiguration(tx, service, snapshot.configuration);
    const volumes = await captureVolumeReferences(tx, service, snapshotVolumes(snapshot));
    if (snapshot.version !== 1)
      await assertDatabaseBindingSnapshots(tx, service, snapshot.databaseBindings);
    if (service.desiredState === 'stopped' && !snapshot.deployAndStart)
      throw new OperationRequestError(
        409,
        'DEPLOY_AND_START_REQUIRED',
        '服务已停止，请明确选择部署并启动。',
      );
    if (
      ['partial', 'drifted', 'unknown'].includes(service.configurationState) &&
      !snapshot.allowConfigurationRepair
    )
      throw new OperationRequestError(
        409,
        'CONFIGURATION_REPAIR_REQUIRED',
        '当前配置不一致，请预览差异并明确确认完整重新发布。',
      );
    if (snapshot.version !== 3)
      await this.checkRegistry(tx, service.registryCredentialRefId, snapshot.configuration.image);
    const mutationRevision = service.mutationRevision + 1;
    await tx.service.update({
      where: { id: service.id },
      data: {
        mutationRevision,
        desiredState: 'running',
        revision: { increment: 1 },
        observationLeaseToken: null,
        observationLeaseExpiresAt: null,
      },
    });
    return {
      serviceId: service.id,
      input: { serviceId: service.id, mutationRevision },
      configRevision: snapshot.configRevision,
      mutationRevision,
      snapshotJson: json(snapshot),
      targetJson: json(target),
      ...(snapshot.version === 3 ? { sourceRevisionId: snapshot.source.revision.id } : {}),
      onAccepted: async (db, ref) => {
        const refs = [
          ...new Set(
            snapshot.configuration.environment.flatMap((variable) =>
              variable.secretRefId ? [variable.secretRefId] : [],
            ),
          ),
        ];
        if (snapshot.version !== 1) {
          if (snapshot.database) refs.push(snapshot.database.credentialRefId);
          refs.push(...snapshot.databaseBindings.map((binding) => binding.credentialRefId));
        }
        if (snapshot.version === 3)
          refs.push(...snapshot.source.revision.buildSecrets.map((secret) => secret.secretRefId));
        if (refs.length)
          await db.deploymentSecretReference.createMany({
            data: [...new Set(refs)].map((secretRefId) => ({ deploymentId: ref.id, secretRefId })),
          });
        await db.deploymentStage.createMany({
          data: [
            ...(snapshot.version === 3 ? ['checkout', 'building', 'exporting', 'pushing'] : []),
            'resolving',
            ...(volumes.length ? ['preparing_storage'] : []),
            'deploying',
            'waiting_healthy',
            ...(snapshot.version === 2 && snapshot.database ? ['verifying_database'] : []),
          ].map((name) => ({
            deploymentId: ref.id,
            name,
            attempt: 1,
            status: 'queued',
          })),
        });
        await admitVolumeMutation(db, volumes, ref);
        if (snapshot.version !== 1)
          await saveDatabaseDeploymentReferences(db, ref.id, snapshot.databaseBindings);
      },
    };
  }

  action(
    id: string,
    action: ServiceAction,
    input: ServiceActionInput,
    actor: OperationActor,
    key: unknown,
  ) {
    resourceId(id);
    record(input, ['revision'], '服务操作');
    integer(input.revision, 1, 2147483647, '版本');
    return this.repository.enqueue(
      actor,
      key,
      { kind: `service_${action}`, request: { id, action, revision: input.revision } },
      async (tx) => {
        const service = await lockService(tx, id);
        requireServiceRevision(service, input.revision);
        requireIdle(service);
        return this.prepareAction(
          tx,
          service,
          action,
          await currentTarget(tx, service),
          service.publishedDeploymentId,
        );
      },
    );
  }

  retryOperation(id: string, actor: OperationActor, key: unknown) {
    resourceId(id);
    return this.retryOperationInner(id, actor, key);
  }

  private async retryOperationInner(id: string, actor: OperationActor, key: unknown) {
    const original = await this.repository.db.operation.findUnique({ where: { id } });
    if (
      !original ||
      !['service_stop', 'service_resume', 'service_restart', 'service_delete'].includes(
        original.kind,
      )
    )
      throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '服务操作不存在。');
    const kind = original.kind as `service_${ServiceAction}`;
    return this.repository.enqueue(
      actor,
      key,
      { kind, request: { id }, retryOfId: id },
      async (tx) => {
        const current = await tx.operation.findUniqueOrThrow({ where: { id } });
        if (!current.serviceId || !['failed', 'cancelled'].includes(current.status))
          throw new OperationRequestError(
            409,
            'OPERATION_NOT_RETRYABLE',
            '只能重试已失败或取消且服务仍存在的操作。',
          );
        const prior = current.input as unknown as ServiceOperationInput;
        const service = await lockService(tx, current.serviceId);
        requireIdle(service);
        if (service.mutationRevision !== prior.mutationRevision)
          throw new OperationRequestError(
            409,
            'SERVICE_TASK_SUPERSEDED',
            '原操作后已有新的服务变更，请从当前服务重新操作。',
          );
        const target = { ...prior.target, serviceId: service.id };
        await assertServiceTarget(tx, service, target);
        return this.prepareAction(
          tx,
          service,
          kind.slice(8) as ServiceAction,
          target,
          prior.snapshotId,
        );
      },
    );
  }

  private async prepareAction(
    tx: Prisma.TransactionClient,
    service: ServiceRecord,
    action: ServiceAction,
    target: ServiceTarget,
    snapshotId: string | null,
  ) {
    if (!['restart', 'stop', 'resume', 'delete'].includes(action))
      throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '服务操作类型无效。');
    const snapshot = service.publishedDeployment?.snapshotJson
      ? readServiceSnapshot(service.publishedDeployment.snapshotJson)
      : null;
    const volumeIds = await serviceVolumeIds(tx, service.id);
    // First-data protection locks Volume before DatabaseInstance. Keep that order
    // after locking Service, including retained references from partial deletions.
    const volumes = await lockVolumes(tx, [
      ...volumeIds,
      ...(snapshot ? snapshotVolumes(snapshot).map((ref) => ref.volumeId) : []),
      ...(service.database ? [service.database.dataVolumeId] : []),
    ]);
    for (const volume of volumes) requireVolumeIdle(volume);
    if (action === 'delete') await assertDatabaseHasNoConsumers(tx, service.id);
    if (action === 'resume' || action === 'restart') {
      await assertDatabaseSnapshot(
        tx,
        service.id,
        snapshot?.version === 2 ? snapshot.database : null,
      );
      if (snapshot && snapshot.version !== 3)
        await assertDatabaseConfiguration(tx, service, snapshot.configuration);
      await captureVolumeReferences(tx, service, snapshot ? snapshotVolumes(snapshot) : []);
      if (snapshot)
        await assertDatabaseBindingSnapshots(tx, service, snapshotDatabaseBindings(snapshot));
    }
    if (action === 'resume' || action === 'restart') {
      if (
        !snapshotId ||
        snapshotId !== service.publishedDeploymentId ||
        service.configurationState !== 'consistent'
      )
        throw new OperationRequestError(
          409,
          'PUBLISHED_CONFIGURATION_REQUIRED',
          '需要可信的完整已发布配置，请先对账或完整重新发布。',
        );
      if (action === 'restart' && service.desiredState === 'stopped')
        throw new OperationRequestError(409, 'SERVICE_STOPPED', '服务已停止，请使用恢复服务。');
    }
    const mutationRevision = service.mutationRevision + 1;
    if (action === 'delete')
      await tx.domain.updateMany({
        where: { serviceId: service.id },
        data: {
          desiredState: 'deleting',
          revision: { increment: 1 },
          observationLeaseToken: null,
          observationLeaseExpiresAt: null,
        },
      });
    await tx.service.update({
      where: { id: service.id },
      data: {
        mutationRevision,
        revision: { increment: 1 },
        ...(action === 'stop' || action === 'delete'
          ? { desiredState: 'stopped' }
          : action === 'resume'
            ? { desiredState: 'running' }
            : {}),
        observationLeaseToken: null,
        observationLeaseExpiresAt: null,
      },
    });
    if (action === 'stop' || action === 'delete')
      await tx.webhookTarget.updateMany({
        where: { currentServiceId: service.id, state: 'waiting' },
        data: { manualRequired: true, state: 'pending', reason: 'service_stopped' },
      });
    return {
      serviceId: service.id,
      clusterId: target.clusterId,
      input: {
        serviceId: service.id,
        mutationRevision,
        snapshotId,
        target: operationTarget(target),
        ...(volumeIds.length ? { volumeIds } : {}),
      } satisfies ServiceOperationInput,
      onAccepted: async (
        db: Prisma.TransactionClient,
        ref: import('../tasks/contracts.js').OperationTaskRef,
      ) => {
        await admitVolumeMutation(db, snapshot ? snapshotVolumes(snapshot) : [], ref);
      },
    };
  }
}
