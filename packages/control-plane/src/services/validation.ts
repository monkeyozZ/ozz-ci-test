import { parseImageReference } from '@ozz/infrastructure/registry';
import { OperationRequestError } from '../tasks/contracts.js';
import {
  SERVICE_CONFIG_MAX_BYTES,
  type ServiceConfiguration,
  type ServiceVariableInput,
} from './contracts.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const portName = /^(?=.*[a-z])[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?$/;
const maxVariables = 128;
const maxVariableBytes = 16 * 1024;

export function invalid(code: string, message: string): never {
  throw new OperationRequestError(422, code, message);
}

export function record(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('SERVICE_CONFIGURATION_INVALID', `${label}格式无效。`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    return invalid('SERVICE_CONFIGURATION_INVALID', `${label}包含不支持的字段。`);
  return result;
}

export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value))
    return invalid('SERVICE_TARGET_INVALID', '资源标识无效。');
  return value;
}

export function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    return invalid('SERVICE_CONFIGURATION_INVALID', `${label}须为 ${min}–${max} 范围内的整数。`);
  return value as number;
}

export function text(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > max ||
    value.includes('\0')
  )
    return invalid('SERVICE_CONFIGURATION_INVALID', `${label}内容或长度无效。`);
  return value;
}

function argv(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 64)
    return invalid('SERVICE_CONFIGURATION_INVALID', `${label}须为最多 64 项的参数数组。`);
  return Array.from(value, (part) => {
    const argument = text(part, 4096, label, true);
    if (Buffer.byteLength(argument, 'utf8') > 4096)
      return invalid('SERVICE_CONFIGURATION_INVALID', `${label}每项最多 4 KiB。`);
    return argument;
  });
}

function environment(value: unknown): ServiceVariableInput[] {
  if (!Array.isArray(value) || value.length > maxVariables)
    return invalid('SERVICE_VARIABLES_INVALID', '环境变量最多 128 项。');
  const names = new Map<string, number>();
  return Array.from(value, (item, index) => {
    const raw = record(item, ['name', 'value', 'secret', 'secretRefId', 'secretKey'], '环境变量');
    const name = text(raw.name, 128, `第 ${index + 1} 项变量名`);
    if (!variableName.test(name))
      return invalid('SERVICE_VARIABLES_INVALID', `第 ${index + 1} 项变量名格式无效。`);
    const previous = names.get(name);
    if (previous !== undefined)
      return invalid(
        'SERVICE_VARIABLES_INVALID',
        `第 ${index + 1} 项变量与第 ${previous} 项重名，请保留一个定义。`,
      );
    names.set(name, index + 1);
    if (raw.secret !== undefined && typeof raw.secret !== 'boolean')
      return invalid('SERVICE_VARIABLES_INVALID', '变量秘密标记无效。');
    if (raw.secretRefId !== undefined) {
      if (raw.value !== undefined || raw.secret === false)
        return invalid('SERVICE_VARIABLES_INVALID', '秘密引用不能同时提交普通值。');
      return {
        name,
        secretRefId: resourceId(raw.secretRefId),
        secretKey: text(raw.secretKey === undefined ? 'value' : raw.secretKey, 128, '秘密字段名'),
      };
    }
    if (raw.secretKey !== undefined)
      return invalid('SERVICE_VARIABLES_INVALID', '秘密字段需要对应的秘密引用。');
    const plaintext = text(raw.value, maxVariableBytes, `第 ${index + 1} 项变量值`, true);
    if (Buffer.byteLength(plaintext, 'utf8') > maxVariableBytes)
      return invalid('SERVICE_VARIABLES_INVALID', `第 ${index + 1} 项变量值最多 16 KiB。`);
    return { name, value: plaintext, secret: raw.secret === true };
  });
}

function configurationSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalid('SERVICE_CONFIGURATION_INVALID', '服务配置须为有效的 JSON 数据。');
  }
  if (serialized === undefined)
    return invalid('SERVICE_CONFIGURATION_INVALID', '服务配置须为有效的 JSON 数据。');
  if (Buffer.byteLength(serialized, 'utf8') > SERVICE_CONFIG_MAX_BYTES)
    return invalid(
      'SERVICE_CONFIGURATION_TOO_LARGE',
      '完整服务配置最多 24 KiB，请精简变量与启动参数。',
    );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export interface ValidatedServiceConfiguration extends Omit<ServiceConfiguration, 'environment'> {
  environment: ServiceVariableInput[];
}

/** Shared by API admission, stored snapshots and the Worker; does not contact any registry. */
export function validateRuntimeConfiguration(
  value: unknown,
): Omit<ValidatedServiceConfiguration, 'image'> {
  const raw = record(
    value,
    [
      'replicas',
      'command',
      'args',
      'ports',
      'resources',
      'environment',
      'readiness',
      'startup',
      'healthTimeoutSeconds',
    ],
    '服务配置',
  );
  configurationSize(raw);
  const rawPorts = raw.ports === undefined ? [] : raw.ports;
  if (!Array.isArray(rawPorts) || rawPorts.length > 16)
    return invalid('SERVICE_PORT_INVALID', '服务端口最多 16 个。');
  const names = new Set<string>();
  const numbers = new Set<number>();
  const ports = Array.from(rawPorts, (item) => {
    const value = record(item, ['name', 'protocol', 'containerPort', 'servicePort'], '端口');
    const name = text(value.name, 15, '端口名称');
    if (
      !portName.test(name) ||
      name.includes('--') ||
      names.has(name) ||
      (value.protocol !== 'http' && value.protocol !== 'tcp')
    )
      return invalid(
        'SERVICE_PORT_INVALID',
        '端口名称须为唯一的 Kubernetes 具名端口，类型为 HTTP 或 TCP。',
      );
    names.add(name);
    const containerPort = integer(value.containerPort, 1, 65535, '容器端口');
    const servicePort = integer(
      value.servicePort === undefined ? containerPort : value.servicePort,
      1,
      65535,
      '内部服务端口',
    );
    if (numbers.has(servicePort)) return invalid('SERVICE_PORT_INVALID', '内部服务端口不能重复。');
    numbers.add(servicePort);
    return { name, protocol: value.protocol as 'http' | 'tcp', containerPort, servicePort };
  });
  const resources = record(
    raw.resources === undefined
      ? { requests: { cpuMillis: 100, memoryMiB: 128 }, limits: { cpuMillis: 500, memoryMiB: 512 } }
      : raw.resources,
    ['requests', 'limits'],
    '资源配置',
  );
  const quantity = (value: unknown) => {
    const item = record(value, ['cpuMillis', 'memoryMiB'], 'CPU 与内存');
    return {
      cpuMillis: integer(item.cpuMillis, 1, 64000, 'CPU（m）'),
      memoryMiB: integer(item.memoryMiB, 16, 262144, '内存（MiB）'),
    };
  };
  const requests = quantity(resources.requests);
  const limits = quantity(resources.limits);
  if (requests.cpuMillis > limits.cpuMillis || requests.memoryMiB > limits.memoryMiB)
    return invalid('SERVICE_RESOURCE_INVALID', '资源请求不能高于资源上限。');
  const probe = (input: unknown): ServiceConfiguration['readiness'] => {
    if (input === undefined || input === null) return null;
    const value = record(
      input,
      [
        'type',
        'port',
        'path',
        'initialDelaySeconds',
        'periodSeconds',
        'timeoutSeconds',
        'failureThreshold',
      ],
      '健康探针',
    );
    if (
      (value.type !== 'http' && value.type !== 'tcp') ||
      typeof value.port !== 'string' ||
      !names.has(value.port)
    )
      return invalid('SERVICE_PROBE_INVALID', '健康探针须引用已声明的具名端口。');
    const path =
      value.type === 'http'
        ? text(value.path === undefined ? '/' : value.path, 2048, '探测路径')
        : undefined;
    if (
      (path && (!path.startsWith('/') || hasControlCharacters(path))) ||
      (value.type === 'tcp' && value.path !== undefined)
    )
      return invalid('SERVICE_PROBE_INVALID', 'HTTP 探针须使用绝对路径，TCP 探针不接受路径。');
    return {
      type: value.type,
      port: value.port,
      ...(path ? { path } : {}),
      initialDelaySeconds: integer(
        value.initialDelaySeconds === undefined ? 0 : value.initialDelaySeconds,
        0,
        600,
        '启动等待秒数',
      ),
      periodSeconds: integer(
        value.periodSeconds === undefined ? 5 : value.periodSeconds,
        1,
        60,
        '探测间隔秒数',
      ),
      timeoutSeconds: integer(
        value.timeoutSeconds === undefined ? 2 : value.timeoutSeconds,
        1,
        30,
        '探测超时秒数',
      ),
      failureThreshold: integer(
        value.failureThreshold === undefined ? 3 : value.failureThreshold,
        1,
        120,
        '失败阈值',
      ),
    };
  };
  const configuration = {
    replicas: integer(raw.replicas === undefined ? 1 : raw.replicas, 1, 20, '副本数'),
    command: argv(raw.command === undefined ? [] : raw.command, '启动命令'),
    args: argv(raw.args === undefined ? [] : raw.args, '启动参数'),
    ports,
    resources: { requests, limits },
    environment: environment(raw.environment === undefined ? [] : raw.environment),
    readiness: probe(raw.readiness),
    startup: probe(raw.startup),
    healthTimeoutSeconds: integer(
      raw.healthTimeoutSeconds === undefined ? 300 : raw.healthTimeoutSeconds,
      10,
      900,
      '健康等待秒数',
    ),
  };
  // Persisted snapshots are validated again by the Worker, including defaults.
  configurationSize(configuration);
  return configuration;
}

export function validateServiceConfiguration(value: unknown): ValidatedServiceConfiguration {
  const raw = record(
    value,
    [
      'image',
      'replicas',
      'command',
      'args',
      'ports',
      'resources',
      'environment',
      'readiness',
      'startup',
      'healthTimeoutSeconds',
    ],
    '服务配置',
  );
  configurationSize(raw);
  const image = text(raw.image, 1024, '镜像引用');
  parseImageReference(image);
  const runtime = { ...raw };
  delete runtime.image;
  const configuration = { image, ...validateRuntimeConfiguration(runtime) };
  configurationSize(configuration);
  return configuration;
}

type EnvImportIssueCode =
  | 'INVALID_ASSIGNMENT'
  | 'INVALID_QUOTE'
  | 'DUPLICATE_NAME'
  | 'NAME_TOO_LONG'
  | 'VALUE_TOO_LARGE'
  | 'TOO_MANY_VARIABLES';

export interface EnvImportResult {
  variables: Array<{ name: string; value: string; secret: boolean; line: number }>;
  issues: Array<{ line: number; code: EnvImportIssueCode; message: string }>;
}

/** Literal dotenv import: no shell execution or interpolation; diagnostics never repeat values. */
export function parseEnvironmentFile(source: unknown): EnvImportResult {
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source, 'utf8') > SERVICE_CONFIG_MAX_BYTES ||
    source.includes('\0')
  )
    return invalid('SERVICE_ENV_IMPORT_INVALID', '.env 文本最多 24 KiB 且不能包含空字符。');
  const lines = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const result: EnvImportResult = { variables: [], issues: [] };
  const names = new Map<string, number>();
  let limitReported = false;
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const raw = lines[index]!.trimStart();
    if (!raw || raw.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(raw);
    if (!match) {
      result.issues.push({ line, code: 'INVALID_ASSIGNMENT', message: '使用 NAME=value 格式。' });
      continue;
    }
    const name = match[1]!;
    let value = match[2]!;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const parts: string[] = [];
      let segment = value.slice(1);
      let closed = false;
      for (;;) {
        let escaped = false;
        let closing = -1;
        for (let pos = 0; pos < segment.length; pos++) {
          const character = segment[pos];
          if (quote === '"' && character === '\\') {
            escaped = !escaped;
            continue;
          }
          if (character === quote && !escaped) {
            closing = pos;
            break;
          }
          escaped = false;
        }
        if (closing !== -1) {
          closed = /^\s*(?:#[\s\S]*)?$/.test(segment.slice(closing + 1));
          parts.push(segment.slice(0, closing));
          break;
        }
        parts.push(segment);
        if (index + 1 >= lines.length) break;
        // Scan each physical line once; a newline resets backslash parity.
        segment = lines[++index]!;
      }
      if (!closed) {
        result.issues.push({
          line,
          code: 'INVALID_QUOTE',
          message: '引号未闭合或引号后有多余内容。',
        });
        continue;
      }
      value = parts.join('\n');
      if (quote === '"')
        value = value.replace(
          /\\([nrt"\\])/g,
          (_, escaped: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[escaped]!,
        );
    } else value = value.split('#', 1)[0]!.trim();
    if (name.length > 128) {
      result.issues.push({ line, code: 'NAME_TOO_LONG', message: '变量名最多 128 个字符。' });
      continue;
    }
    const previous = names.get(name);
    if (previous !== undefined) {
      result.issues.push({
        line,
        code: 'DUPLICATE_NAME',
        message: `此变量已在第 ${previous} 行定义，请保留一个定义。`,
      });
      continue;
    }
    names.set(name, line);
    if (Buffer.byteLength(value, 'utf8') > maxVariableBytes) {
      result.issues.push({ line, code: 'VALUE_TOO_LARGE', message: '变量值最多 16 KiB。' });
      continue;
    }
    if (result.variables.length >= maxVariables) {
      if (!limitReported)
        result.issues.push({
          line,
          code: 'TOO_MANY_VARIABLES',
          message: '环境变量最多 128 项，超出部分未导入。',
        });
      limitReported = true;
      continue;
    }
    result.variables.push({
      name,
      value,
      secret: /(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY)/i.test(name),
      line,
    });
  }
  return result;
}
