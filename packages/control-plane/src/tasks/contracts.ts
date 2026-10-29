import {
  parseVolumeOperationInput,
  volumeOperationKinds,
  type VolumeOperationInput,
  type VolumeOperationKind,
} from '../storage/contracts.js';

export { volumeOperationKinds } from '../storage/contracts.js';
export type { VolumeOperationInput, VolumeOperationKind } from '../storage/contracts.js';

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskLogLevel = 'info' | 'warn' | 'error';

export interface OperationTaskRef {
  type: 'operation';
  id: string;
}

export interface DeploymentTaskRef {
  type: 'deployment';
  id: string;
}

export type TaskRef = OperationTaskRef | DeploymentTaskRef;

export interface ServiceTaskTarget {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  projectId: string;
  environmentId: string;
  namespace: string;
  serviceName: string;
}

export interface ServiceOperationInput {
  serviceId: string;
  mutationRevision: number;
  snapshotId: string | null;
  target: ServiceTaskTarget;
  /** Fixed data locks, including mounts being removed from the next publication. */
  volumeIds?: string[];
}

export interface DeploymentInput {
  serviceId: string;
  mutationRevision: number;
}

export interface DiagnosticInput {
  durationMs: number;
}

export const infrastructureKinds = [
  'ssh_discover',
  'server_preflight',
  'server_initialize',
  'cluster_connect',
  'cluster_sync',
] as const;
export type InfrastructureKind = (typeof infrastructureKinds)[number];
export const serviceOperationKinds = [
  'service_restart',
  'service_stop',
  'service_resume',
  'service_delete',
] as const;
export type ServiceOperationKind = (typeof serviceOperationKinds)[number];
export const domainOperationKinds = [
  'domain_bind',
  'domain_sync',
  'domain_reconcile',
  'domain_unbind',
  'domain_production',
] as const;
export type DomainOperationKind = (typeof domainOperationKinds)[number];
export const clusterNetworkingKinds = [
  'cluster_network_check',
  'cluster_cert_manager_install',
] as const;
export type ClusterNetworkingKind = (typeof clusterNetworkingKinds)[number];
export const integrationOperationKinds = ['github_webhook_register', 'registry_validate'] as const;
export type IntegrationOperationKind = (typeof integrationOperationKinds)[number];
export interface IntegrationOperationInput {
  integrationId: string;
  revision: number;
  action: 'register_webhook' | 'validate_registry';
  hookSecretRefId?: string;
  callbackUrl?: string;
  probeRepository?: string;
}
export type TaskKind =
  | 'diagnostic'
  | IntegrationOperationKind
  | InfrastructureKind
  | ServiceOperationKind
  | DomainOperationKind
  | ClusterNetworkingKind
  | VolumeOperationKind;

export interface DomainOperationInput {
  domainId: string;
  hostname: string;
  serviceId: string;
  serviceMutationRevision: number;
  domainRevision: number;
  platformRevision: number;
  networkRevision: number;
  certificateEnvironment: 'staging' | 'production';
  /** Original staging gate is retained across production retries, independent of later observations. */
  stagingVerification?: {
    authority: 'letsencrypt' | 'local_test';
    certificateObservedAt: string;
    certificateNotAfter: string;
    dnsObservedAt: string;
  };
  target: ServiceTaskTarget & {
    serviceId: string;
    serviceUid: string;
    domainId: string;
    hostname: string;
    portId: string;
    portName: string;
  };
}

export interface ClusterNetworkingOperationInput {
  clusterId: string;
  installationId: string;
  kubeSystemUid: string;
  clusterConnectionRevision: number;
  networkRevision: number;
}

/** Immutable, non-secret execution intent. Authentication is resolved at execution time. */
export interface InfrastructureInput {
  targetId: string;
  connectionRevision: number;
  host?: string;
  port?: number;
  username?: string;
  hostKeyFingerprint?: string;
  expectedMachineId?: string | null;
  clusterId?: string;
  clusterConnectionRevision?: number;
  installationId?: string;
  bootstrapCredentialRefId?: string;
  nodeName?: string;
  apiEndpoint?: string;
  candidateCredentialRefId?: string;
  expectedKubeSystemUid?: string | null;
  expectedCaFingerprint?: string | null;
  acceptedCaFingerprint?: string;
}

export type TaskInput =
  | IntegrationOperationInput
  | DiagnosticInput
  | InfrastructureInput
  | ServiceOperationInput
  | DomainOperationInput
  | ClusterNetworkingOperationInput
  | VolumeOperationInput;

export function integrationOperationInput(
  kind: IntegrationOperationKind,
  value: unknown,
): IntegrationOperationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '集成任务参数无效。');
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          'integrationId',
          'revision',
          'action',
          'hookSecretRefId',
          'callbackUrl',
          'probeRepository',
        ].includes(key),
    ) ||
    typeof raw.integrationId !== 'string' ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 1 ||
    raw.action !== (kind === 'github_webhook_register' ? 'register_webhook' : 'validate_registry')
  )
    throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '集成任务身份或动作无效。');
  validateOperationId(raw.integrationId);
  if (kind === 'github_webhook_register') {
    if (
      typeof raw.hookSecretRefId !== 'string' ||
      typeof raw.callbackUrl !== 'string' ||
      raw.probeRepository !== undefined
    )
      throw new OperationRequestError(
        422,
        'INVALID_OPERATION_INPUT',
        'Webhook 任务缺少固定回调及验签凭证。',
      );
    validateOperationId(raw.hookSecretRefId);
    let url: URL;
    try {
      url = new URL(raw.callbackUrl);
    } catch {
      throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', 'Webhook 回调地址无效。');
    }
    if (
      raw.callbackUrl.length > 2048 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', 'Webhook 回调地址无效。');
  } else if (
    typeof raw.probeRepository !== 'string' ||
    !/^[a-z0-9][a-z0-9._/-]{0,254}$/u.test(raw.probeRepository) ||
    raw.hookSecretRefId !== undefined ||
    raw.callbackUrl !== undefined
  )
    throw new OperationRequestError(
      422,
      'INVALID_OPERATION_INPUT',
      'Registry 检查缺少限定探针仓库。',
    );
  return raw as unknown as IntegrationOperationInput;
}

export function taskInput(kind: string, value: unknown): TaskInput {
  if (kind === 'diagnostic') return diagnosticInput(value);
  if ((integrationOperationKinds as readonly string[]).includes(kind))
    return integrationOperationInput(kind as IntegrationOperationKind, value);
  if ((volumeOperationKinds as readonly string[]).includes(kind))
    return parseVolumeOperationInput(value);
  if ((domainOperationKinds as readonly string[]).includes(kind)) {
    const input = domainOperationInput(value);
    if (kind === 'domain_production' && !input.stagingVerification)
      throw new OperationRequestError(
        422,
        'INVALID_OPERATION_INPUT',
        '生产签发任务缺少原 staging 验证记录。',
      );
    return input;
  }
  if ((clusterNetworkingKinds as readonly string[]).includes(kind))
    return clusterNetworkingOperationInput(value);
  if ((serviceOperationKinds as readonly string[]).includes(kind))
    return serviceOperationInput(kind as ServiceOperationKind, value);
  if (
    !(infrastructureKinds as readonly string[]).includes(kind) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '任务类型或持久参数无效。');
  }
  const raw = value as Record<string, unknown>;
  const allowed = [
    'targetId',
    'connectionRevision',
    'host',
    'port',
    'username',
    'hostKeyFingerprint',
    'expectedMachineId',
    'clusterId',
    'clusterConnectionRevision',
    'installationId',
    'bootstrapCredentialRefId',
    'nodeName',
    'apiEndpoint',
    'candidateCredentialRefId',
    'expectedKubeSystemUid',
    'expectedCaFingerprint',
    'acceptedCaFingerprint',
  ];
  if (
    Object.keys(raw).some((key) => !allowed.includes(key)) ||
    typeof raw.targetId !== 'string' ||
    !Number.isSafeInteger(raw.connectionRevision) ||
    Number(raw.connectionRevision) < 1
  ) {
    throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '任务目标或持久参数无效。');
  }
  validateOperationId(raw.targetId);
  for (const [key, field] of Object.entries(raw)) {
    if (['connectionRevision', 'port', 'clusterConnectionRevision'].includes(key)) {
      if (!Number.isSafeInteger(field) || Number(field) < 1)
        throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '任务整数参数无效。');
    } else if (field !== null && (typeof field !== 'string' || field.length > 2048)) {
      throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '任务字符串参数无效。');
    }
  }
  const required = kind.startsWith('cluster_')
    ? ['apiEndpoint']
    : ['host', 'port', 'username', ...(kind === 'ssh_discover' ? [] : ['hostKeyFingerprint'])];
  if (kind === 'server_initialize')
    required.push(
      'expectedMachineId',
      'clusterId',
      'clusterConnectionRevision',
      'installationId',
      'bootstrapCredentialRefId',
      'nodeName',
      'apiEndpoint',
    );
  if (required.some((key) => raw[key] === undefined || raw[key] === null || raw[key] === '')) {
    throw new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '任务缺少固定执行目标。');
  }
  return raw as unknown as InfrastructureInput;
}

export function domainOperationInput(value: unknown): DomainOperationInput {
  const code = 'INVALID_OPERATION_INPUT';
  const allowed = [
    'domainId',
    'hostname',
    'serviceId',
    'serviceMutationRevision',
    'domainRevision',
    'platformRevision',
    'networkRevision',
    'certificateEnvironment',
    'stagingVerification',
    'target',
  ];
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new OperationRequestError(422, code, '域名任务参数无效。');
  for (const key of ['domainId', 'serviceId']) requireInputId(value[key], code);
  for (const key of [
    'serviceMutationRevision',
    'domainRevision',
    'platformRevision',
    'networkRevision',
  ])
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1)
      throw new OperationRequestError(422, code, '域名任务版本无效。');
  if (!['staging', 'production'].includes(String(value.certificateEnvironment)))
    throw new OperationRequestError(422, code, '证书签发环境无效。');
  if (value.stagingVerification !== undefined) {
    const evidence = value.stagingVerification;
    const fields = ['certificateObservedAt', 'certificateNotAfter', 'dnsObservedAt'];
    if (
      !isRecord(evidence) ||
      !['letsencrypt', 'local_test'].includes(String(evidence.authority)) ||
      Object.keys(evidence).some((key) => ![...fields, 'authority'].includes(key)) ||
      fields.some(
        (key) =>
          typeof evidence[key] !== 'string' ||
          evidence[key].length > 40 ||
          !Number.isFinite(Date.parse(evidence[key])),
      )
    )
      throw new OperationRequestError(422, code, '原 staging 验证记录无效。');
  }
  if (
    typeof value.hostname !== 'string' ||
    value.hostname.length > 253 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value.hostname)
  )
    throw new OperationRequestError(422, code, '固定的域名无效。');
  const target = value.target;
  const keys = [
    'installationId',
    'clusterId',
    'kubeSystemUid',
    'projectId',
    'environmentId',
    'namespace',
    'serviceName',
    'serviceId',
    'serviceUid',
    'domainId',
    'hostname',
    'portId',
    'portName',
  ];
  if (!isRecord(target) || Object.keys(target).some((key) => !keys.includes(key)))
    throw new OperationRequestError(422, code, '域名任务缺少固定目标。');
  for (const key of [
    'installationId',
    'clusterId',
    'projectId',
    'environmentId',
    'serviceId',
    'domainId',
    'portId',
  ])
    requireInputId(target[key], code);
  for (const key of ['kubeSystemUid', 'serviceUid'])
    if (typeof target[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(target[key]))
      throw new OperationRequestError(422, code, '域名目标资源 UID 无效。');
  for (const key of ['namespace', 'serviceName', 'portName'])
    if (
      typeof target[key] !== 'string' ||
      target[key].length > (key === 'portName' ? 15 : 63) ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(target[key])
    )
      throw new OperationRequestError(422, code, '域名目标资源名称无效。');
  if (
    target.serviceId !== value.serviceId ||
    target.domainId !== value.domainId ||
    target.hostname !== value.hostname
  )
    throw new OperationRequestError(422, code, '域名任务身份不一致。');
  return value as unknown as DomainOperationInput;
}

export function clusterNetworkingOperationInput(value: unknown): ClusterNetworkingOperationInput {
  const code = 'INVALID_OPERATION_INPUT';
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'clusterId',
          'installationId',
          'kubeSystemUid',
          'clusterConnectionRevision',
          'networkRevision',
        ].includes(key),
    )
  )
    throw new OperationRequestError(422, code, '集群网络任务参数无效。');
  requireInputId(value.clusterId, code);
  requireInputId(value.installationId, code);
  if (
    typeof value.kubeSystemUid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.kubeSystemUid)
  )
    throw new OperationRequestError(422, code, '集群身份无效。');
  if (
    !Number.isSafeInteger(value.clusterConnectionRevision) ||
    Number(value.clusterConnectionRevision) < 1 ||
    !Number.isSafeInteger(value.networkRevision) ||
    Number(value.networkRevision) < 0
  )
    throw new OperationRequestError(422, code, '集群网络任务版本无效。');
  return value as unknown as ClusterNetworkingOperationInput;
}

export function deploymentInput(value: unknown): DeploymentInput {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['serviceId', 'mutationRevision'].includes(key))
  )
    throw new OperationRequestError(422, 'INVALID_DEPLOYMENT_INPUT', '发布任务参数无效。');
  requireInputId(value.serviceId, 'INVALID_DEPLOYMENT_INPUT');
  if (!Number.isSafeInteger(value.mutationRevision) || Number(value.mutationRevision) < 1)
    throw new OperationRequestError(422, 'INVALID_DEPLOYMENT_INPUT', '发布任务变更版本无效。');
  return value as unknown as DeploymentInput;
}

export function serviceOperationInput(
  kind: ServiceOperationKind,
  value: unknown,
): ServiceOperationInput {
  const code = 'INVALID_OPERATION_INPUT';
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !['serviceId', 'mutationRevision', 'snapshotId', 'target', 'volumeIds'].includes(key),
    )
  )
    throw new OperationRequestError(422, code, '服务操作参数无效。');
  requireInputId(value.serviceId, code);
  if (!Number.isSafeInteger(value.mutationRevision) || Number(value.mutationRevision) < 1)
    throw new OperationRequestError(422, code, '服务操作变更版本无效。');
  if (value.snapshotId !== null) requireInputId(value.snapshotId, code);
  if (value.volumeIds !== undefined) {
    if (
      !Array.isArray(value.volumeIds) ||
      value.volumeIds.length > 16 ||
      new Set(value.volumeIds).size !== value.volumeIds.length
    )
      throw new OperationRequestError(422, code, '服务操作的固定卷集合无效。');
    for (const id of value.volumeIds) requireInputId(id, code);
  }
  if (['service_restart', 'service_resume'].includes(kind) && value.snapshotId === null)
    throw new OperationRequestError(422, code, '重启和恢复需要固定的已发布快照。');
  const target = value.target;
  const keys = [
    'installationId',
    'clusterId',
    'kubeSystemUid',
    'projectId',
    'environmentId',
    'namespace',
    'serviceName',
  ];
  if (!isRecord(target) || Object.keys(target).some((key) => !keys.includes(key)))
    throw new OperationRequestError(422, code, '服务操作缺少固定执行目标。');
  for (const key of ['installationId', 'clusterId', 'projectId', 'environmentId'])
    requireInputId(target[key], code);
  if (
    typeof target.kubeSystemUid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(target.kubeSystemUid)
  )
    throw new OperationRequestError(422, code, '集群身份无效。');
  for (const key of ['namespace', 'serviceName']) {
    if (
      typeof target[key] !== 'string' ||
      target[key].length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(target[key])
    )
      throw new OperationRequestError(422, code, '固定的 Kubernetes 资源名称无效。');
  }
  return value as unknown as ServiceOperationInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireInputId(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string')
    throw new OperationRequestError(422, code, '持久任务资源 ID 无效。');
  try {
    validateOperationId(value);
  } catch {
    throw new OperationRequestError(422, code, '持久任务资源 ID 无效。');
  }
}

export interface OperationView {
  id: string;
  kind: string;
  scope: string;
  status: OperationStatus;
  input: TaskInput;
  serverId: string | null;
  clusterId: string | null;
  serviceId: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryOfId: string | null;
  cancelRequestedAt: string | null;
  pollUrl: string;
}

export interface DeploymentTaskView {
  id: string;
  kind: 'image_deploy' | 'git_deploy';
  scope: 'service';
  status: OperationStatus;
  phase: string;
  input: DeploymentInput;
  serviceId: string | null;
  configRevision: number;
  mutationRevision: number;
  sourceRevisionId: string | null;
  reuseArtifactId: string | null;
  artifactId: string | null;
  initiatorKind: string;
  webhookDeliveryId: string | null;
  webhookTargetId: string | null;
  snapshotJson: unknown;
  targetJson: unknown;
  resolvedImageJson: unknown;
  appliedAt: string | null;
  result: unknown;
  /** Evidence from a failed attempt, independent of the nullable complete application result. */
  failureObservation: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryOfId: string | null;
  cancelRequestedAt: string | null;
  pollUrl: string;
}

export class TaskExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'TaskExecutionError';
  }
}

export interface TaskLogLine {
  sequence: number;
  timestamp: string;
  level: TaskLogLevel;
  message: string;
  attempt: number;
  code?: string;
}

export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

export interface OperationLogPage extends Page<TaskLogLine> {
  source: 'operation';
  truncated: boolean;
  available: boolean;
  unavailableReason: 'not_started' | 'expired' | 'not_available' | null;
}

export interface DeploymentLogPage extends Omit<OperationLogPage, 'source'> {
  source: 'deployment';
}

export type TaskLogPage = OperationLogPage | DeploymentLogPage;

export interface TaskingOptions {
  leaseMs: number;
  leaseRenewMs: number;
  relayLeaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  recoveryAfterMs: number;
  heartbeatTtlMs: number;
  logRetentionMs: number;
  logMaxBytes: number;
  retainedLogOperations: number;
  maxPendingOperations: number;
}

export const defaultTaskingOptions: Readonly<TaskingOptions> = {
  leaseMs: 15_000,
  leaseRenewMs: 4_000,
  relayLeaseMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  recoveryAfterMs: 15_000,
  heartbeatTtlMs: 20_000,
  logRetentionMs: 14 * 24 * 60 * 60 * 1_000,
  logMaxBytes: 16 * 1024,
  retainedLogOperations: 1_000,
  maxPendingOperations: 1_000,
};

export class OperationRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OperationRequestError';
  }
}

export function diagnosticInput(value: unknown): DiagnosticInput {
  if (value === undefined || value === null) return { durationMs: 250 };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationRequestError(422, 'INVALID_DIAGNOSTIC_INPUT', '诊断参数必须是对象。');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'durationMs')) {
    throw new OperationRequestError(
      422,
      'INVALID_DIAGNOSTIC_INPUT',
      '诊断任务仅接受 durationMs 参数。',
    );
  }
  const durationMs = input.durationMs ?? 250;
  if (
    !Number.isInteger(durationMs) ||
    (durationMs as number) < 0 ||
    (durationMs as number) > 5_000
  ) {
    throw new OperationRequestError(
      422,
      'INVALID_DIAGNOSTIC_INPUT',
      '诊断时长必须是 0 至 5000 毫秒的整数。',
    );
  }
  return { durationMs: durationMs as number };
}

export function pageLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    throw new OperationRequestError(422, 'INVALID_PAGE_LIMIT', 'limit 必须是 1 至 100 的整数。');
  }
  return number;
}

export function validateOperationId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new OperationRequestError(404, 'OPERATION_NOT_FOUND', '操作记录不存在。');
  }
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{8,128}$/.test(value)) {
    throw new OperationRequestError(
      422,
      'IDEMPOTENCY_KEY_REQUIRED',
      '请提供 8 至 128 个字符的 Idempotency-Key，重试同一请求时保留此值。',
    );
  }
  return value;
}
