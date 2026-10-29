export const registryManifestMediaTypes = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
] as const;
export const registryIndexMediaTypes = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
] as const;
export type RegistryManifestMediaType = (typeof registryManifestMediaTypes)[number];
export type RegistryIndexMediaType = (typeof registryIndexMediaTypes)[number];
export type RegistryMediaType = RegistryManifestMediaType | RegistryIndexMediaType;

export interface ImagePlatform {
  os: 'linux';
  architecture: 'amd64' | 'arm64';
  /** Without a variant, select the architecture baseline (amd64/v1 or arm64/v8). */
  variant?: string;
}

export interface ParsedImageReference {
  readonly input: string;
  /** Pull authority, normalized to docker.io for Docker Hub aliases. */
  readonly registry: string;
  /** HTTPS API origin; Docker Hub uses registry-1.docker.io. */
  readonly apiOrigin: string;
  readonly repository: string;
  readonly tag: string | null;
  readonly digest: string | null;
  readonly reference: string;
}

/**
 * Non-secret handle. Only parseRegistryAccess can construct a usable value.
 * Credentials and additional CA material remain in an operation-local WeakMap.
 */
export interface RegistryAccess {
  readonly registry: string;
  readonly authentication: 'none' | 'basic';
  readonly caFingerprint: string | null;
}

export interface RegistryAccessInput {
  registry: string;
  username?: string;
  password?: string;
  /** Additional CA trust for resolver HTTPS only, never a containerd configuration. */
  caCertificate?: string;
  /** Exact, explicitly trusted HTTPS origins for a cross-origin token service. */
  tokenServiceOrigins?: string[];
  /** Explicit private HTTPS blob origins; ordinary public redirects need no allowlist. */
  blobServiceOrigins?: string[];
}

export interface ResolvedImagePlatform extends ImagePlatform {
  manifestDigest: string;
  manifestMediaType: RegistryManifestMediaType;
  configDigest: string;
}

/** Serializable image identity only. Contains neither auth headers nor image config/env. */
export interface ResolvedImage {
  version: 1;
  inputReference: string;
  registry: string;
  repository: string;
  tag: string | null;
  requestedDigest: string | null;
  /** Root manifest or index digest, computed from the exact response bytes. */
  manifestDigest: string;
  manifestMediaType: RegistryMediaType;
  indexDigest: string | null;
  /** Kubernetes must pull this immutable reference, including for mixed-architecture nodes. */
  deployReference: string;
  /** Each selected platform is checked against its actual config blob. */
  platformManifests: ResolvedImagePlatform[];
  resolvedAt: string;
  verifiedAt?: string;
}

export interface RegistryResolveOptions {
  platforms: readonly ImagePlatform[];
  access?: RegistryAccess;
  signal?: AbortSignal;
}

export interface RegistryAdapterOptions {
  /** Explicit transport proxy for approved registry/token/private-blob origins only. */
  httpProxy?: string;
  /** Exact approved blob origins for this proxy; other redirects retain direct public-IP pinning. */
  proxyBlobOrigins?: string[];
  requestTimeoutMs?: number;
  resolutionTimeoutMs?: number;
  maxResponseBytes?: number;
  maxResolutionBytes?: number;
  maxRequests?: number;
  maxDescriptors?: number;
}

export interface RegistryImageResolver {
  resolve(image: string, options: RegistryResolveOptions): Promise<ResolvedImage>;
  /** Re-fetches the stored digest; the original tag is never resolved again. */
  verify(image: ResolvedImage, options: RegistryResolveOptions): Promise<ResolvedImage>;
}

export type RegistryErrorCode =
  | 'REGISTRY_REFERENCE_INVALID'
  | 'REGISTRY_ACCESS_INVALID'
  | 'REGISTRY_ACCESS_MISMATCH'
  | 'REGISTRY_AUTH_REQUIRED'
  | 'REGISTRY_UNAUTHENTICATED'
  | 'REGISTRY_FORBIDDEN'
  | 'REGISTRY_AUTH_CHALLENGE_INVALID'
  | 'REGISTRY_TOKEN_ORIGIN_REJECTED'
  | 'REGISTRY_REDIRECT_REJECTED'
  | 'REGISTRY_TLS_INVALID'
  | 'REGISTRY_UNREACHABLE'
  | 'REGISTRY_TIMEOUT'
  | 'REGISTRY_CANCELLED'
  | 'REGISTRY_RATE_LIMITED'
  | 'REGISTRY_UNAVAILABLE'
  | 'REGISTRY_IMAGE_NOT_FOUND'
  | 'REGISTRY_INVALID_RESPONSE'
  | 'REGISTRY_RESPONSE_TOO_LARGE'
  | 'REGISTRY_REQUEST_LIMIT'
  | 'REGISTRY_DIGEST_MISMATCH'
  | 'REGISTRY_MANIFEST_UNSUPPORTED'
  | 'REGISTRY_PLATFORM_UNSUPPORTED'
  | 'REGISTRY_PLATFORM_MISMATCH'
  | 'REGISTRY_PLATFORM_AMBIGUOUS'
  | 'REGISTRY_SNAPSHOT_INVALID'
  | 'REGISTRY_PULL_CREDENTIAL_CAN_PUSH';

const messages: Record<RegistryErrorCode, string> = {
  REGISTRY_PULL_CREDENTIAL_CAN_PUSH: '运行期拉取身份仍拥有推送权限，请配置仓库的实际权限隔离。',
  REGISTRY_REFERENCE_INVALID: '镜像引用无效，请使用仓库/镜像:版本或完整 sha256 摘要。',
  REGISTRY_ACCESS_INVALID: '镜像仓库凭证或专用 HTTPS 信任配置无效。',
  REGISTRY_ACCESS_MISMATCH: '所选凭证不属于此镜像仓库。',
  REGISTRY_AUTH_REQUIRED: '此镜像仓库需要独立的拉取凭证。',
  REGISTRY_UNAUTHENTICATED: '镜像仓库未接受当前拉取凭证。',
  REGISTRY_FORBIDDEN: '当前镜像仓库凭证没有读取此镜像的权限。',
  REGISTRY_AUTH_CHALLENGE_INVALID: '镜像仓库返回了不支持或无效的认证要求。',
  REGISTRY_TOKEN_ORIGIN_REJECTED: '镜像仓库的认证服务地址未在专用信任配置中授权。',
  REGISTRY_REDIRECT_REJECTED: '镜像仓库返回了未授权的重定向。',
  REGISTRY_TLS_INVALID: '镜像仓库 HTTPS 证书、主机名或信任链校验失败。',
  REGISTRY_UNREACHABLE: '暂时无法连接镜像仓库。',
  REGISTRY_TIMEOUT: '镜像解析超过了有界等待时间。',
  REGISTRY_CANCELLED: '镜像解析已取消。',
  REGISTRY_RATE_LIMITED: '镜像仓库限制了请求速率，请稍后重试。',
  REGISTRY_UNAVAILABLE: '镜像仓库暂时不可用。',
  REGISTRY_IMAGE_NOT_FOUND: '所选镜像或已固定的产物摘要在仓库中不存在。',
  REGISTRY_INVALID_RESPONSE: '镜像仓库返回了无效的协议响应。',
  REGISTRY_RESPONSE_TOO_LARGE: '镜像元数据超过了允许的响应大小。',
  REGISTRY_REQUEST_LIMIT: '镜像清单展开超过了允许的请求或条目数量。',
  REGISTRY_DIGEST_MISMATCH: '镜像清单或配置内容与其摘要不一致。',
  REGISTRY_MANIFEST_UNSUPPORTED: '镜像不是受支持的 OCI 或 Docker v2 容器镜像。',
  REGISTRY_PLATFORM_UNSUPPORTED: '此镜像不包含目标节点所需的平台。',
  REGISTRY_PLATFORM_MISMATCH: '镜像平台描述与实际配置不一致。',
  REGISTRY_PLATFORM_AMBIGUOUS: '镜像索引对目标平台提供了多个无法唯一选择的产物。',
  REGISTRY_SNAPSHOT_INVALID: '原部署的固定镜像记录无效，不能改用当前标签替代。',
};

/** Never retains raw URLs, server responses, headers, credentials or the original error. */
export class RegistryAdapterError extends Error {
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: RegistryErrorCode,
    readonly retryable = false,
    details: { httpStatus?: number; retryAfterMs?: number } = {},
  ) {
    super(messages[code]);
    this.name = 'RegistryAdapterError';
    this.httpStatus = details.httpStatus;
    this.retryAfterMs = details.retryAfterMs;
  }
}
