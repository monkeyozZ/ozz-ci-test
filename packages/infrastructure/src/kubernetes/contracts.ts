export type KubernetesErrorCode =
  | 'KUBECONFIG_INVALID'
  | 'KUBECONFIG_UNSUPPORTED'
  | 'KUBERNETES_CREDENTIAL_EXPIRED'
  | 'KUBERNETES_CREDENTIAL_NOT_YET_VALID'
  | 'KUBERNETES_TLS_INVALID'
  | 'KUBERNETES_UNAUTHENTICATED'
  | 'KUBERNETES_FORBIDDEN'
  | 'KUBERNETES_API_NOT_FOUND'
  | 'KUBERNETES_TIMEOUT'
  | 'KUBERNETES_UNREACHABLE'
  | 'KUBERNETES_RATE_LIMITED'
  | 'KUBERNETES_RESOURCE_VERSION_EXPIRED'
  | 'KUBERNETES_API_UNAVAILABLE'
  | 'KUBERNETES_INVALID_RESPONSE'
  | 'KUBERNETES_RESPONSE_TOO_LARGE'
  | 'KUBERNETES_REDIRECT_REJECTED'
  | 'KUBERNETES_CLUSTER_IDENTITY_MISMATCH'
  | 'KUBERNETES_CA_MISMATCH'
  | 'KUBERNETES_CANCELLED';

const errorMessages: Record<KubernetesErrorCode, string> = {
  KUBECONFIG_INVALID: 'kubeconfig 格式或嵌入的凭证无效。',
  KUBECONFIG_UNSUPPORTED:
    '仅支持嵌入式 CA 与客户端证书/私钥或 Token；不支持认证插件、文件引用、代理或跳过 TLS 校验。',
  KUBERNETES_CREDENTIAL_EXPIRED: 'Kubernetes 凭证或 CA 已过期，请更新后重试。',
  KUBERNETES_CREDENTIAL_NOT_YET_VALID: 'Kubernetes 凭证或 CA 尚未生效，请检查时间与凭证。',
  KUBERNETES_TLS_INVALID: 'Kubernetes API 的 CA、证书有效期或主机名校验失败。',
  KUBERNETES_UNAUTHENTICATED: 'Kubernetes API 未接受此凭证。',
  KUBERNETES_FORBIDDEN: '此 Kubernetes 凭证没有完成当前检查所需的权限。',
  KUBERNETES_API_NOT_FOUND: '目标 Kubernetes API 或资源不存在。',
  KUBERNETES_TIMEOUT: 'Kubernetes API 请求超时。',
  KUBERNETES_UNREACHABLE: '无法连接 Kubernetes API。',
  KUBERNETES_RATE_LIMITED: 'Kubernetes API 暂时限制了请求速率，请稍后重试。',
  KUBERNETES_RESOURCE_VERSION_EXPIRED: 'Kubernetes 观察版本已过期，需要重新读取资源。',
  KUBERNETES_API_UNAVAILABLE: 'Kubernetes API 暂时不可用。',
  KUBERNETES_INVALID_RESPONSE: 'Kubernetes API 返回了无法验证的响应。',
  KUBERNETES_RESPONSE_TOO_LARGE: 'Kubernetes API 响应超过当前检查的资源或字节上限。',
  KUBERNETES_REDIRECT_REJECTED: 'Kubernetes API 返回重定向，连接已停止以保护凭证。',
  KUBERNETES_CLUSTER_IDENTITY_MISMATCH: '目标不是已登记的 Kubernetes 集群，请另行登记。',
  KUBERNETES_CA_MISMATCH: '目标 Kubernetes CA 与已登记的指纹不一致。',
  KUBERNETES_CANCELLED: 'Kubernetes 检查已取消。',
};

/** Errors crossing this Interface never retain a raw server body, URL or SDK error. */
export class KubernetesAdapterError extends Error {
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    public readonly code: KubernetesErrorCode,
    public readonly retryable = false,
    details: { httpStatus?: number; retryAfterMs?: number } = {},
  ) {
    super(errorMessages[code]);
    this.name = 'KubernetesAdapterError';
    this.httpStatus = details.httpStatus ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

export interface CertificateSummary {
  /** SHA-256 of the DER certificate; uppercase prefix and lowercase hexadecimal digest. */
  fingerprint: string;
  notBefore: string;
  expiresAt: string;
}

export interface KubernetesCredentialSummary {
  authentication: 'client_certificate' | 'token';
  clientCertificate: CertificateSummary | null;
  caCertificates: readonly CertificateSummary[];
  expiresAt: string | null;
  /** JWT expiry is an unverified claim until the API authenticates the token. */
  expirationSource: 'client_certificate' | 'token_claim' | 'unknown';
  notBefore: string | null;
}

/**
 * Only parseKubeconfig can construct a usable connection. This value is safe to
 * serialize: authentication material is held privately by the Module. Parse the
 * protected kubeconfig again in another process instead of persisting this object.
 */
export interface ParsedKubernetesConnection {
  readonly endpoint: string;
  readonly caFingerprint: string;
  readonly credential: Readonly<KubernetesCredentialSummary>;
}

export interface ParseKubeconfigOptions {
  /** Explicit remote address substitution; the new hostname must pass CA/SAN validation. */
  endpointOverride?: string;
}

export interface KubernetesClusterIdentity {
  kubeSystemUid: string;
  caFingerprint: string;
}

export interface KubernetesResourceValues {
  cpuCores: number | null;
  memoryBytes: number | null;
  ephemeralStorageBytes: number | null;
  pods: number | null;
}

export type KubernetesConditionState = 'true' | 'false' | 'unknown';

export interface KubernetesNodeMetrics {
  state: 'available' | 'unknown';
  cpuCores: number | null;
  memoryBytes: number | null;
  observedAt: string | null;
  windowSeconds: number | null;
}

export interface KubernetesNodeSnapshot {
  uid: string;
  name: string;
  resourceVersion: string | null;
  createdAt: string | null;
  architecture: string | null;
  operatingSystem: string | null;
  osImage: string | null;
  kubeletVersion: string | null;
  containerRuntimeVersion: string | null;
  machineId: string | null;
  systemUuid: string | null;
  roles: string[];
  addresses: { type: 'InternalIP' | 'ExternalIP' | 'Hostname'; address: string }[];
  unschedulable: boolean;
  conditions: {
    ready: KubernetesConditionState;
    diskPressure: KubernetesConditionState;
    memoryPressure: KubernetesConditionState;
    pidPressure: KubernetesConditionState;
    networkUnavailable: KubernetesConditionState;
  };
  capacity: KubernetesResourceValues;
  allocatable: KubernetesResourceValues;
  metrics: KubernetesNodeMetrics;
}

export interface KubernetesPermissionCheck {
  apiGroup: string;
  resource: string;
  verb: string;
  resourceName: string | null;
  /** null means a cluster-scoped/all-namespaces request, not one project namespace. */
  namespace: string | null;
  allowed: boolean | null;
  evidence: 'successful_request' | 'self_subject_access_review' | 'unknown';
  errorCode: KubernetesErrorCode | null;
}

export type KubernetesCapabilityState = 'available' | 'unavailable' | 'forbidden' | 'unknown';

export interface KubernetesMetricsCapability {
  state: KubernetesCapabilityState;
  errorCode: KubernetesErrorCode | null;
  observedAt: string | null;
}

export interface KubernetesCapabilities {
  /** Discovery of a class does not prove that public routing works. */
  ingress: {
    state: KubernetesCapabilityState;
    classes: { name: string; controller: string; isDefault: boolean }[];
    errorCode: KubernetesErrorCode | null;
  };
  /** Reads only this standard K3s Deployment; other installations remain outside this check. */
  traefik: {
    state: KubernetesCapabilityState;
    namespace: 'kube-system';
    deployment: 'traefik';
    ready: boolean | null;
    desiredReplicas: number | null;
    readyReplicas: number | null;
    availableReplicas: number | null;
    errorCode: KubernetesErrorCode | null;
  };
  /** StorageClass discovery does not create a PVC or attest to volume durability. */
  storage: {
    state: KubernetesCapabilityState;
    classes: {
      name: string;
      provisioner: string;
      isDefault: boolean;
      volumeBindingMode: 'Immediate' | 'WaitForFirstConsumer' | null;
      reclaimPolicy: 'Delete' | 'Retain' | null;
      allowVolumeExpansion: boolean | null;
    }[];
    errorCode: KubernetesErrorCode | null;
  };
  metrics: KubernetesMetricsCapability;
}

export type KubernetesWorkloadKind =
  'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob' | 'Pod';

export interface KubernetesWorkloadSnapshot {
  kind: KubernetesWorkloadKind;
  namespace: string;
  name: string;
  uid: string;
  status:
    | 'ready'
    | 'not_ready'
    | 'scaled_to_zero'
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'scheduled'
    | 'suspended'
    | 'terminating'
    | 'unknown';
  ready: boolean | null;
  desiredReplicas: number | null;
  readyReplicas: number | null;
  /** An observed label, not proof of ownership. Confirm platform IDs against durable metadata. */
  managedBy: string | null;
}

export interface KubernetesWorkloadObservation {
  state: 'available' | 'partial' | 'unknown';
  items: KubernetesWorkloadSnapshot[];
  collections: {
    kind: KubernetesWorkloadKind;
    state: KubernetesCapabilityState;
    /** Count of the bounded preview, not the total when truncated is true. */
    listedCount: number | null;
    truncated: boolean;
    errorCode: KubernetesErrorCode | null;
  }[];
  observedAt: string;
}

export interface KubernetesInspection {
  endpoint: string;
  version: string;
  identity: KubernetesClusterIdentity;
  credential: Readonly<KubernetesCredentialSummary>;
  permissions: {
    /** A wildcard SSAR; true must be presented as broad privileges, not least privilege. */
    clusterWideAdmin: boolean | null;
    checks: KubernetesPermissionCheck[];
  };
  nodes: KubernetesNodeSnapshot[];
  nodesResourceVersion: string | null;
  metrics: KubernetesMetricsCapability;
  capabilities: KubernetesCapabilities;
  workloads: KubernetesWorkloadObservation;
  /** A standard Kubernetes connection cannot attest to data-at-rest encryption. */
  secretsEncryption: { state: 'unknown'; evidence: 'not_available_via_standard_api' };
  observedAt: string;
}

export interface KubernetesInspectOptions {
  signal?: AbortSignal;
  /** Compare the UID and, when provided, the pinned CA. Neither is silently replaced. */
  expectedIdentity?: { kubeSystemUid: string; caFingerprint?: string };
}

export interface KubernetesAdapterOptions {
  /** Defaults to 15 seconds; applies to connect, TLS, headers and the complete body. */
  requestTimeoutMs?: number;
  /** Defaults to 60 seconds, including optional capability checks. */
  inspectionTimeoutMs?: number;
  /** Defaults to 4 MiB per response and 16 MiB for the whole inspection. */
  maxResponseBytes?: number;
  maxInspectionBytes?: number;
  /** Personal-control-plane bound. Large clusters fail explicitly without partial Node replacement. */
  maxNodes?: number;
  now?: () => Date;
}

export interface KubernetesConnectionInspector {
  inspect(
    connection: ParsedKubernetesConnection,
    options?: KubernetesInspectOptions,
  ): Promise<KubernetesInspection>;
}
