/** Public observations contain no SSH credentials or Kubernetes credentials. */
export interface SshEndpoint {
  host: string;
  port: number;
}

export interface SshTarget extends SshEndpoint {
  username: string;
  /** OpenSSH SHA256 fingerprint, confirmed through an independent trusted source. */
  hostKeyFingerprint: string;
}

export type SshCredential =
  | { privateKey: string; passphrase?: string; password?: never }
  | { password: string; privateKey?: never; passphrase?: never };

export interface SshHostKey {
  fingerprint: string;
  algorithm: string;
  observedAt: string;
}

export type SshArchitecture = 'arm64' | 'amd64' | 'unsupported';
export type SecretEncryptionObservation = 'enabled' | 'disabled' | 'unknown';

export interface SshPreflight {
  observedAt: string;
  machineId: string;
  hostname: string;
  os: string;
  osVersion: string;
  architecture: SshArchitecture;
  kernel: string;
  init: string;
  cpuCount: number;
  memoryBytes: number;
  memoryAvailableBytes: number;
  rootDiskBytes: number;
  rootDiskAvailableBytes: number;
  dataDiskBytes: number;
  dataDiskAvailableBytes: number;
  privileged: boolean;
  memoryCgroupAvailable: boolean;
  systemdAvailable: boolean;
  ports: { protocol: 'tcp' | 'udp'; port: number; listening: boolean }[];
  firewall: 'active' | 'inactive' | 'unknown';
  k3s: {
    installed: boolean;
    version: string | null;
    installationId: string | null;
    installationPhase: 'prepared' | 'installed' | 'ready' | null;
    secretsEncryption: SecretEncryptionObservation;
  };
  /** Machine requirements only. Any existing installation still requires identity checks. */
  blockers: SshPreflightBlocker[];
  warnings: SshPreflightWarning[];
}

export type SshPreflightBlocker =
  | 'unsupported_os'
  | 'unsupported_architecture'
  | 'systemd_required'
  | 'privilege_required'
  | 'memory_cgroup_required'
  | 'insufficient_cpu'
  | 'insufficient_memory'
  | 'insufficient_disk'
  | 'ports_in_use';

export type SshPreflightWarning =
  | 'low_memory_headroom'
  | 'low_disk_headroom'
  | 'firewall_requires_review'
  | 'cloud_firewall_unknown'
  | 'existing_k3s';

export type SshProgressStage =
  | 'connecting'
  | 'preflight'
  | 'downloading'
  | 'installing'
  | 'starting'
  | 'waiting_ready'
  | 'verifying_encryption'
  | 'storing_credential'
  | 'completed';

export interface SshProgress {
  stage: SshProgressStage;
}

export interface SshCallOptions {
  signal?: AbortSignal;
}

export interface SshInitializeOptions extends SshCallOptions {
  /** Persist this ID in the immutable operation input; reuse it when resuming that installation. */
  installationId: string;
  /** Required prior observation: replacing the machine is never treated as a retry. */
  expectedMachineId: string;
  apiEndpoint: string;
  nodeName: string;
  onProgress?: (progress: SshProgress) => void | Promise<void>;
  /** Encrypt immediately in the Worker. Never pass this value to logs or an Operation result. */
  onCredential: (kubeconfig: string) => void | Promise<void>;
}

export interface SshInitialization {
  observedAt: string;
  installationId: string;
  machineId: string;
  architecture: Exclude<SshArchitecture, 'unsupported'>;
  version: string;
  nodeName: string;
  apiEndpoint: string;
  secretsEncryption: 'enabled';
  /** The host was already owned by the same immutable installation intent. */
  resumed: boolean;
}

export interface SshAdapterOptions {
  connectTimeoutMs?: number;
  preflightTimeoutMs?: number;
  initializeTimeoutMs?: number;
  maxOutputBytes?: number;
}

export type SshErrorCode =
  | 'SSH_INVALID_TARGET'
  | 'SSH_INVALID_CREDENTIAL'
  | 'SSH_INVALID_INSTALLATION'
  | 'SSH_CONNECTION_FAILED'
  | 'SSH_AUTH_FAILED'
  | 'SSH_FINGERPRINT_MISMATCH'
  | 'SSH_TIMEOUT'
  | 'SSH_CANCELLED'
  | 'SSH_OUTPUT_LIMIT'
  | 'SSH_REMOTE_FAILED'
  | 'SSH_INVALID_RESPONSE'
  | 'SSH_PREFLIGHT_BLOCKED'
  | 'SSH_PRIVILEGE_REQUIRED'
  | 'SSH_IDENTITY_CHANGED'
  | 'SSH_K3S_ALREADY_INSTALLED'
  | 'SSH_INSTALLATION_CONFLICT'
  | 'SSH_INSTALL_BUSY'
  | 'SSH_ASSET_DOWNLOAD_FAILED'
  | 'SSH_ASSET_VERIFY_FAILED'
  | 'SSH_INSTALL_VERIFY_FAILED'
  | 'SSH_NOT_READY'
  | 'SSH_ENCRYPTION_NOT_ENABLED'
  | 'SSH_CREDENTIAL_STORE_FAILED'
  | 'SSH_PROGRESS_FAILED';

const messages: Record<SshErrorCode, string> = {
  SSH_INVALID_TARGET: 'SSH 主机、端口、用户名或可信指纹格式无效。',
  SSH_INVALID_CREDENTIAL: 'SSH 凭证格式无效，请使用一种认证方式。',
  SSH_INVALID_INSTALLATION: '初始化标识、机器身份、节点名或 API 地址无效。',
  SSH_CONNECTION_FAILED: '无法建立 SSH 连接，请检查地址、端口和网络。',
  SSH_AUTH_FAILED: 'SSH 认证失败，请检查凭证和远端登录权限。',
  SSH_FINGERPRINT_MISMATCH: 'SSH 主机指纹与已确认的可信指纹不同，操作已停止。',
  SSH_TIMEOUT: 'SSH 操作超过时限，请检查任务阶段和远端状态后重试。',
  SSH_CANCELLED: 'SSH 操作已取消；已启动的集群和已发生的变更会保留。',
  SSH_OUTPUT_LIMIT: '远端响应超过大小限制，操作已停止。',
  SSH_REMOTE_FAILED: '远端检查或初始化执行失败，请检查系统依赖与权限。',
  SSH_INVALID_RESPONSE: '远端返回的数据不符合预期，未接受观察结果。',
  SSH_PREFLIGHT_BLOCKED: '服务器未通过初始化预检，请先解决所列阻断项。',
  SSH_PRIVILEGE_REQUIRED: '初始化需要 root 或免密码 sudo 权限。',
  SSH_IDENTITY_CHANGED: '服务器机器身份发生变化，不能继续原初始化任务。',
  SSH_K3S_ALREADY_INSTALLED: '发现已有 Kubernetes 或 K3s 安装，请使用已有集群接入。',
  SSH_INSTALLATION_CONFLICT: '远端安装标记、版本或配置与本次任务不一致，未覆盖已有内容。',
  SSH_INSTALL_BUSY: '另一项远端初始化正在执行，请等待其完成。',
  SSH_ASSET_DOWNLOAD_FAILED: '固定版本安装资源下载失败，请检查服务器出站连接。',
  SSH_ASSET_VERIFY_FAILED: '固定版本安装资源校验失败，未执行安装资源。',
  SSH_INSTALL_VERIFY_FAILED: 'K3s 安装文件或系统服务校验失败。',
  SSH_NOT_READY: 'K3s API 或节点未在时限内就绪，已有安装已保留。',
  SSH_ENCRYPTION_NOT_ENABLED: '未验证 Kubernetes Secret 静态加密已启用。',
  SSH_CREDENTIAL_STORE_FAILED: '初始集群凭证未能安全保存，请重试同一初始化任务。',
  SSH_PROGRESS_FAILED: '初始化进度未能持久保存，操作已停止。',
};

/** Safe to persist. Remote stderr, exception causes and credential material are never attached. */
export class SshAdapterError extends Error {
  constructor(
    public readonly code: SshErrorCode,
    public readonly sideEffects: 'none' | 'may_have_changed' = 'none',
  ) {
    super(messages[code]);
    this.name = 'SshAdapterError';
  }
}

export function isSshErrorCode(value: unknown): value is SshErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}
