import { createHash } from 'node:crypto';
import type { Prisma } from '@ozz/database';
import { OperationRequestError, pageLimit } from '../tasks/contracts.js';
import type { ServiceConfiguration } from '../services/contracts.js';
import { resourceId, validateServiceConfiguration } from '../services/validation.js';
import type {
  DatabaseEngine,
  TemplateId,
  TemplateParameter,
  TemplateParameters,
  TemplatePreview,
  TemplatePreviewInput,
  TemplateSelection,
  TemplateView,
} from '../databases/contracts.js';
import { templateImages } from './image-assets.js';

export const TEMPLATE_VERSION = '1.0.0';
const resources = {
  docker: {
    requests: { cpuMillis: 100, memoryMiB: 128 },
    limits: { cpuMillis: 500, memoryMiB: 256 },
  },
  'node-example': {
    requests: { cpuMillis: 100, memoryMiB: 64 },
    limits: { cpuMillis: 500, memoryMiB: 128 },
  },
  'static-example': {
    requests: { cpuMillis: 25, memoryMiB: 32 },
    limits: { cpuMillis: 250, memoryMiB: 64 },
  },
  postgresql: {
    requests: { cpuMillis: 100, memoryMiB: 256 },
    limits: { cpuMillis: 1000, memoryMiB: 768 },
  },
  redis: {
    requests: { cpuMillis: 100, memoryMiB: 64 },
    limits: { cpuMillis: 500, memoryMiB: 256 },
  },
};
const parameter = (
  name: TemplateParameter['name'],
  label: string,
  type: TemplateParameter['type'],
  defaultValue: string | number | null,
  description: string,
  required = false,
  minimum: number | null = null,
  maximum: number | null = null,
): TemplateParameter => ({
  name,
  label,
  type,
  defaultValue,
  description,
  required,
  minimum,
  maximum,
});
const storageParameter = (bytes: string) =>
  parameter(
    'requestedBytes',
    '申请容量',
    'bytes',
    bytes,
    'local-path 的申请容量不代表硬配额。使用量与节点可用空间需单独观察。',
  );
const definitions: Record<
  TemplateId,
  Pick<
    TemplateView,
    'name' | 'description' | 'category' | 'sourceUrl' | 'license' | 'parameters' | 'notes'
  >
> = {
  docker: {
    name: 'Docker 镜像',
    description: '从 OCI 镜像开始，保存草稿后显式发布。',
    category: 'application',
    sourceUrl: 'https://opencontainers.org/',
    license: '由所选镜像提供',
    parameters: [
      parameter('image', '镜像地址', 'string', null, '使用明确版本或 sha256 摘要。', true),
      parameter(
        'port',
        'HTTP 端口',
        'integer',
        8080,
        '容器实际监听的 HTTP 端口。',
        false,
        1,
        65535,
      ),
    ],
    notes: ['数据卷通过服务的存储设置独立创建与挂载。'],
  },
  'node-example': {
    name: 'Node.js 示例',
    description: '使用官方预构建 Node.js 运行时启动一个简单 HTTP 服务。',
    category: 'application',
    sourceUrl: 'https://github.com/nodejs/docker-node',
    license: 'Node.js MIT；基础镜像组件各自保留许可',
    parameters: [],
    notes: ['固定示例程序随模板运行；不需要源码构建。', '默认监听 8080，可在发布后配置域名。'],
  },
  'static-example': {
    name: '静态站点示例',
    description: '使用官方 Nginx 预构建镜像启动欢迎页面。',
    category: 'application',
    sourceUrl: 'https://github.com/nginx/docker-nginx',
    license: 'Nginx 2-clause BSD；基础镜像组件各自保留许可',
    parameters: [],
    notes: ['使用镜像内的静态页面；项目源码构建将在源码部署中提供。'],
  },
  postgresql: {
    name: 'PostgreSQL',
    description: '单实例 PostgreSQL，独立数据卷与自动生成的认证凭证。',
    category: 'database',
    sourceUrl: 'https://github.com/docker-library/postgres',
    license: 'PostgreSQL License；基础镜像组件各自保留许可',
    parameters: [
      parameter('username', '初始用户名', 'string', 'app', '数据库初始化后受数据身份保护。'),
      parameter(
        'databaseName',
        '数据库名称',
        'string',
        'app',
        '数据库初始化后不能通过普通配置重命名。',
      ),
      storageParameter('4294967296'),
    ],
    notes: ['仅创建集群内 TCP 服务。', '删除服务会保留数据卷和初始化凭证；备份需要独立完成。'],
  },
  redis: {
    name: 'Redis',
    description: '单实例 Redis，认证开启，AOF 每秒同步并保留独立数据卷。',
    category: 'database',
    sourceUrl: 'https://github.com/redis/redis/tree/7.4',
    license: 'RSALv2 / SSPLv1；基础镜像组件各自保留许可',
    parameters: [
      parameter(
        'redisDatabase',
        '默认数据库编号',
        'integer',
        0,
        '供同环境连接输出使用。',
        false,
        0,
        15,
      ),
      storageParameter('1073741824'),
    ],
    notes: [
      'AOF everysec 可能丢失最近约一秒的数据。',
      '仅创建集群内 TCP 服务，备份恢复使用 Redis 专用流程。',
    ],
  },
};
const versions: Record<Exclude<TemplateId, 'docker'>, string> = {
  postgresql: '17.11',
  redis: '7.4.11',
  'node-example': '24.22.1',
  'static-example': '1.28.3',
};
export function getTemplate(id: string, version = TEMPLATE_VERSION): TemplateView {
  if (!Object.hasOwn(definitions, id) || version !== TEMPLATE_VERSION)
    throw new OperationRequestError(404, 'TEMPLATE_VERSION_NOT_FOUND', '模板或固定版本不存在。');
  const key = id as TemplateId;
  const image = key === 'docker' ? null : templateImages[key];
  return {
    id: key,
    version,
    ...structuredClone(definitions[key]),
    image: image
      ? {
          reference: image.deployReference,
          digest: image.manifestDigest,
          version: versions[key as Exclude<TemplateId, 'docker'>],
          platforms: image.platformManifests.map((platform) => platform.architecture),
          verifiedAt: image.resolvedAt,
        }
      : null,
    resources: structuredClone(resources[key]),
    controller:
      key === 'postgresql' || key === 'redis'
        ? { kind: 'StatefulSet', strategy: 'RollingUpdate' }
        : { kind: 'Deployment', strategy: 'RollingUpdate' },
    persistent: key === 'postgresql' || key === 'redis',
  };
}
export function listTemplates(
  query: { limit?: number; cursor?: string; search?: string; category?: string } = {},
) {
  const limit = pageLimit(query.limit);
  let data = Object.keys(definitions).map((id) => getTemplate(id));
  if (query.category) {
    if (!['application', 'database'].includes(query.category))
      throw new OperationRequestError(422, 'TEMPLATE_FILTER_INVALID', '模板分类无效。');
    data = data.filter((item) => item.category === query.category);
  }
  if (query.search)
    data = data.filter((item) =>
      (item.name + item.description + item.id).toLowerCase().includes(query.search!.toLowerCase()),
    );
  if (query.cursor) {
    const index = data.findIndex(
      (item) => Buffer.from(item.id).toString('base64url') === query.cursor,
    );
    if (index < 0) throw new OperationRequestError(422, 'INVALID_CURSOR', '模板分页游标无效。');
    data = data.slice(index + 1);
  }
  const visible = data.slice(0, limit);
  return {
    data: visible,
    page: {
      hasMore: data.length > limit,
      nextCursor:
        data.length > limit ? Buffer.from(visible.at(-1)!.id).toString('base64url') : null,
    },
  };
}
function invalid(field: string): never {
  throw new OperationRequestError(
    422,
    'TEMPLATE_PARAMETERS_INVALID',
    `模板参数 ${field} 无效，请核对输入。`,
  );
}
function parameters(template: TemplateView, input: unknown): TemplateParameters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('parameters');
  const raw = input as Record<string, unknown>;
  // HTTP DTO instances retain optional class fields as undefined own properties.
  if (
    Object.entries(raw).some(
      ([key, value]) =>
        value !== undefined && !template.parameters.some((field) => field.name === key),
    )
  )
    invalid('parameters');
  const result: Record<string, string | number> = {};
  for (const field of template.parameters) {
    if (raw[field.name] === null) invalid(field.name);
    const value = raw[field.name] ?? field.defaultValue;
    if (value === null || value === undefined) {
      if (field.required) invalid(field.name);
      else continue;
    }
    if (field.type === 'integer') {
      if (
        !Number.isSafeInteger(value) ||
        Number(value) < field.minimum! ||
        Number(value) > field.maximum!
      )
        invalid(field.name);
    } else if (typeof value !== 'string') invalid(field.name);
    if (
      field.type === 'bytes' &&
      (typeof value !== 'string' ||
        !/^[1-9]\d{0,12}$/u.test(value) ||
        BigInt(value) < 1048576n ||
        BigInt(value) > 1099511627776n)
    )
      invalid(field.name);
    if (
      ['username', 'databaseName'].includes(field.name) &&
      (typeof value !== 'string' ||
        !/^[a-z][a-z0-9_]{0,62}$/u.test(value) ||
        value.startsWith('pg_'))
    )
      invalid(field.name);
    if (field.name === 'image' && (typeof value !== 'string' || value.length > 2048))
      invalid(field.name);
    result[field.name] = value as string | number;
  }
  return result;
}
export interface CompiledTemplate {
  template: TemplateView;
  parameters: TemplateParameters;
  configuration: ServiceConfiguration;
  volume: { requestedBytes: string; mountPath: string } | null;
  database: {
    engine: DatabaseEngine;
    majorVersion: number;
    exactVersion: string;
    dataLayout: string;
    username: string;
    databaseName: string | null;
    redisDatabase: number | null;
  } | null;
}
export function compileTemplate(selection: TemplateSelection): CompiledTemplate {
  if (
    !selection ||
    typeof selection !== 'object' ||
    Array.isArray(selection) ||
    typeof selection.id !== 'string' ||
    typeof selection.version !== 'string' ||
    Object.keys(selection).some((key) => !['id', 'version', 'parameters'].includes(key))
  )
    invalid('template');
  const template = getTemplate(selection.id, selection.version);
  const values = parameters(template, selection.parameters);
  const port =
    template.id === 'postgresql'
      ? 5432
      : template.id === 'redis'
        ? 6379
        : template.id === 'static-example'
          ? 80
          : (values.port ?? 8080);
  const protocol = template.persistent ? 'tcp' : 'http';
  const base = validateServiceConfiguration({
    image: template.image?.reference ?? values.image!,
    replicas: 1,
    resources: template.resources,
    ports: [{ name: protocol, protocol, containerPort: port, servicePort: port }],
    readiness: {
      type: protocol,
      port: protocol,
      ...(protocol === 'http' ? { path: '/' } : {}),
      initialDelaySeconds: 0,
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: 3,
    },
    startup: {
      type: protocol,
      port: protocol,
      ...(protocol === 'http' ? { path: '/' } : {}),
      initialDelaySeconds: 0,
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: template.persistent ? 60 : 24,
    },
    command: [],
    args: template.id === 'redis' ? ['redis-server', '/run/ozz/database/redis.conf'] : [],
    environment: [],
    healthTimeoutSeconds: 300,
  });
  if (template.id === 'node-example') {
    base.command = ['node'];
    base.args = [
      '-e',
      "require('node:http').createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify({message:'Hello from Ozz',runtime:process.version}));}).listen(8080,'0.0.0.0');",
    ];
  }
  return {
    template,
    parameters: values,
    configuration: base,
    volume: template.persistent
      ? {
          requestedBytes: values.requestedBytes!,
          mountPath: template.id === 'postgresql' ? '/var/lib/postgresql/data' : '/data',
        }
      : null,
    database:
      template.id === 'postgresql'
        ? {
            engine: 'postgresql',
            majorVersion: 17,
            exactVersion: versions.postgresql,
            dataLayout: 'postgresql-17-pgdata-v1',
            username: values.username!,
            databaseName: values.databaseName!,
            redisDatabase: null,
          }
        : template.id === 'redis'
          ? {
              engine: 'redis',
              majorVersion: 7,
              exactVersion: versions.redis,
              dataLayout: 'redis-7-rdb-aof-v1',
              username: 'default',
              databaseName: null,
              redisDatabase: values.redisDatabase!,
            }
          : null,
  };
}
export async function previewTemplate(
  tx: Prisma.TransactionClient,
  id: string,
  input: TemplatePreviewInput,
): Promise<TemplatePreview> {
  resourceId(input.environmentId);
  const compiled = compileTemplate({
    id: id as TemplateId,
    version: input.version,
    parameters: input.parameters,
  });
  const environment = await tx.environment.findUnique({
    where: { id: input.environmentId },
    include: { project: { include: { cluster: true } } },
  });
  if (!environment) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '目标环境不存在。');
  if (input.projectId && input.projectId !== environment.projectId)
    throw new OperationRequestError(422, 'SERVICE_ENVIRONMENT_MISMATCH', '环境不属于当前项目。');
  const cluster = environment.project.cluster;
  const issues: TemplatePreview['issues'] = [];
  if (!cluster.kubeSystemUid)
    issues.push({
      code: 'CLUSTER_NOT_CONNECTED',
      field: 'environmentId',
      blocks: 'both',
      message: '请先验证项目所属集群。',
    });
  if (
    compiled.volume &&
    (!cluster.storageCapabilitiesAt ||
      Date.now() - cluster.storageCapabilitiesAt.getTime() > 90_000 ||
      cluster.storageErrorCode)
  )
    issues.push({
      code: 'VOLUME_OBSERVATION_REQUIRED',
      field: 'template.parameters.requestedBytes',
      blocks: 'deploy',
      message: '发布前需要新鲜的存储能力观察；可以先保存模板草稿。',
    });
  const result = {
    template: { id: compiled.template.id, version: compiled.template.version },
    environmentId: environment.id,
    projectId: environment.projectId,
    clusterId: cluster.id,
    configuration: compiled.configuration,
    controller: compiled.template.controller,
    plannedVolumes: compiled.volume
      ? [
          {
            purpose: 'database_data' as const,
            requestedBytes: compiled.volume.requestedBytes,
            storageClassName: 'local-path' as const,
            mountPath: compiled.volume.mountPath,
            hardQuotaSupport: 'unsupported' as const,
          },
        ]
      : [],
    plannedCredentials: compiled.database
      ? [{ kind: 'database' as const, generated: true as const }]
      : [],
    issues,
  };
  return {
    ...result,
    previewDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  };
}
