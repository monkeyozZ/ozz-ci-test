import type {
  ConfigurationInput,
  RuntimeConfiguration,
  RuntimeConfigurationInput,
  Service,
  ServiceDraft,
  Variable,
  VariableDraft,
} from './types';
import { ApiError } from '../../lib/api';
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export const stageLabels: Record<string, string> = {
  queued: '等待执行',
  checkout: '检出固定提交',
  building: '构建镜像',
  exporting: '保存 OCI 产物',
  pushing: '推送镜像',
  resolving: '解析镜像',
  preparing_storage: '准备存储',
  deploying: '应用配置',
  waiting_healthy: '等待健康检查',
  verifying_database: '验证数据库连接',
  succeeded: '发布完成',
  failed: '发布失败',
  cancelled: '已取消',
};
export const configurationLabels: Record<string, string> = {
  unpublished: '尚未发布',
  consistent: '已完整应用',
  partial: '配置部分应用',
  drifted: '配置存在漂移',
  unknown: '配置待核对',
};
export function serviceLocation(
  service: Pick<Service, 'id' | 'projectId' | 'environment'>,
  tab?: string,
) {
  return {
    path: `/projects/${service.projectId}/services/${service.id}`,
    query: { environment: service.environment.slug, ...(tab ? { tab } : {}) },
  };
}
export function taskLocation(task: { type: 'operation' | 'deployment'; id: string }) {
  return `/${task.type === 'deployment' ? 'deployments' : 'operations'}/${task.id}`;
}
export function activeTaskLocation(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.problem.code !== 'SERVICE_OPERATION_ACTIVE')
    return null;
  const errors = error.problem.errors;
  if (!errors || typeof errors !== 'object' || !('activeTask' in errors)) return null;
  const values = errors.activeTask;
  if (!Array.isArray(values) || typeof values[0] !== 'string') return null;
  return /^\/(?:operations|deployments)\/[0-9a-f-]{36}$/.test(values[0]) ? values[0] : null;
}
export function variableDraft(variable?: Variable): VariableDraft {
  return {
    rowId: crypto.randomUUID(),
    name: variable?.name ?? '',
    mode: variable?.secretRefId ? 'reference' : 'plain',
    value: variable?.value ?? '',
    secretRefId: variable?.secretRefId ?? '',
    secretKey: variable?.secretKey ?? '',
  };
}
export function serviceDraft(service?: Service): ServiceDraft {
  const configuration = service?.configuration;
  return {
    name: service?.name ?? '',
    slug: service?.slug ?? '',
    description: service?.description ?? '',
    revision: service?.revision ?? 1,
    registryCredentialRefId: service?.registryCredentialRefId ?? '',
    image: configuration && 'image' in configuration ? configuration.image : '',
    replicas: configuration?.replicas ?? 1,
    commandText: JSON.stringify(configuration?.command ?? [], null, 2),
    argsText: JSON.stringify(configuration?.args ?? [], null, 2),
    ports: copy(
      configuration?.ports ?? [
        { name: 'http', protocol: 'http', containerPort: 3000, servicePort: 80 },
      ],
    ),
    resources: copy(
      configuration?.resources ?? {
        requests: { cpuMillis: 100, memoryMiB: 128 },
        limits: { cpuMillis: 500, memoryMiB: 512 },
      },
    ),
    variables: (configuration?.environment ?? []).map(variableDraft),
    readiness: copy(configuration?.readiness ?? null),
    startup: copy(configuration?.startup ?? null),
    healthTimeoutSeconds: configuration?.healthTimeoutSeconds ?? 300,
  };
}
function commandArray(text: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} 需要 JSON 字符串数组，例如 ["node", "server.js"]。`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 64 ||
    parsed.some((value) => typeof value !== 'string')
  )
    throw new Error(`${label} 最多包含 64 个字符串。`);
  return parsed as string[];
}
export function draftConfiguration(form: ServiceDraft): ConfigurationInput {
  return { image: form.image.trim(), ...draftRuntimeConfiguration(form) };
}
export function draftRuntimeConfiguration(form: ServiceDraft): RuntimeConfigurationInput {
  if (
    form.resources.requests.cpuMillis > form.resources.limits.cpuMillis ||
    form.resources.requests.memoryMiB > form.resources.limits.memoryMiB
  )
    throw new Error('每副本的资源请求不能超过资源上限。');
  const names = new Set<string>();
  for (const variable of form.variables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name))
      throw new Error('变量名使用字母、数字和下划线，不能以数字开头。');
    if (names.has(variable.name)) throw new Error(`变量 ${variable.name} 重复，请合并后保存。`);
    names.add(variable.name);
  }
  return {
    replicas: form.replicas,
    command: commandArray(form.commandText, '启动命令'),
    args: commandArray(form.argsText, '启动参数'),
    ports: copy(form.ports),
    resources: copy(form.resources),
    environment: form.variables.map((variable) =>
      variable.mode === 'reference'
        ? { name: variable.name, secretRefId: variable.secretRefId, secretKey: variable.secretKey }
        : {
            name: variable.name,
            value: variable.value,
            ...(variable.mode === 'secret' ? { secret: true } : {}),
          },
    ),
    readiness: copy(form.readiness),
    startup: copy(form.startup),
    healthTimeoutSeconds: form.healthTimeoutSeconds,
  };
}

export interface ConfigurationChange {
  key: string;
  label: string;
  before: string;
  after: string;
}
function configurationJson(value: unknown): string | undefined {
  // PostgreSQL JSONB and API responses can return the same keys in another order.
  // Array order remains significant, especially for command and argument lists.
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}
export function configurationChanges(
  before: Service['configuration'] | null,
  after: Service['configuration'],
): ConfigurationChange[] {
  const changes: ConfigurationChange[] = [];
  const fields: Array<{ key: keyof RuntimeConfiguration; label: string }> = [
    { key: 'replicas', label: '副本数' },
    { key: 'command', label: '启动命令' },
    { key: 'args', label: '启动参数' },
    { key: 'ports', label: '具名端口' },
    { key: 'resources', label: '每副本资源' },
    { key: 'readiness', label: '就绪探针' },
    { key: 'startup', label: '启动探针' },
    { key: 'healthTimeoutSeconds', label: '健康等待上限（秒）' },
  ];
  const display = (value: unknown) =>
    value === undefined
      ? '尚未发布'
      : value === null
        ? '未配置'
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
  const beforeImage = before && 'image' in before ? before.image : undefined;
  const afterImage = 'image' in after ? after.image : undefined;
  if (beforeImage !== afterImage)
    changes.push({
      key: 'image',
      label: '镜像',
      before: display(beforeImage),
      after: display(afterImage),
    });
  for (const field of fields)
    if (configurationJson(before?.[field.key]) !== configurationJson(after[field.key]))
      changes.push({
        key: field.key,
        label: field.label,
        before: display(before?.[field.key]),
        after: display(after[field.key]),
      });
  const oldVariables = new Map(
    (before?.environment ?? []).map((variable) => [variable.name, variable]),
  );
  const newVariables = new Map(after.environment.map((variable) => [variable.name, variable]));
  const variableText = (variable?: Variable) =>
    !variable ? '无此变量' : variable.secretRefId ? '已加密的秘密引用' : (variable.value ?? '');
  for (const name of new Set([...oldVariables.keys(), ...newVariables.keys()])) {
    const old = oldVariables.get(name);
    const current = newVariables.get(name);
    if (configurationJson(old) !== configurationJson(current))
      changes.push({
        key: `environment.${name}`,
        label: `变量 ${name}`,
        before: variableText(old),
        after: variableText(current),
      });
  }
  return changes;
}
