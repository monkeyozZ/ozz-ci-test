import type { Builder, GitHubConnection, GitRepository, RegistryConnection } from '@ozz/database';
import type { BuilderIdentity } from '@ozz/infrastructure/build';
import type {
  BuilderView,
  GitHubConnectionView,
  GitRepositoryView,
  RegistryConnectionView,
  VerificationState,
} from './contracts.js';
const iso = (value: Date | null) => value?.toISOString() ?? null;
export function githubConnectionView(row: GitHubConnection): GitHubConnectionView {
  return {
    id: row.id,
    name: row.name,
    authorization: 'fine_grained_pat',
    credentialRefId: row.credentialRefId,
    revision: row.revision,
    verification: {
      state: row.verificationState as VerificationState,
      checkedAt: iso(row.verifiedAt),
      errorCode: row.lastErrorCode,
    },
    account:
      row.accountId && row.accountLogin ? { id: row.accountId, login: row.accountLogin } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function gitRepositoryView(row: GitRepository, appOrigin: string): GitRepositoryView {
  return {
    id: row.id,
    githubConnectionId: row.githubConnectionId,
    githubRepositoryId: row.githubRepositoryId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    private: row.private,
    revision: row.revision,
    hook: {
      state: row.hookState,
      hookId: row.hookId,
      callbackUrl: row.hookCallbackId
        ? `${appOrigin}/api/webhooks/github/${row.id}/${row.hookCallbackId}`
        : null,
      verifiedAt: iso(row.hookVerifiedAt),
      errorCode: row.hookErrorCode,
      operationId: row.hookOperationId,
    },
    lastVerifiedAt: row.lastVerifiedAt.toISOString(),
  };
}
export function registryConnectionView(row: RegistryConnection): RegistryConnectionView {
  return {
    id: row.id,
    name: row.name,
    authority: row.authority,
    namespace: row.namespace,
    pushCredentialRefId: row.pushCredentialRefId,
    pullCredentialRefId: row.pullCredentialRefId,
    revision: row.revision,
    pushVerification: {
      state: row.pushVerificationState as VerificationState,
      checkedAt: iso(row.pushVerifiedAt),
      errorCode: row.pushErrorCode,
    },
    pullVerification: {
      state: row.pullVerificationState as VerificationState,
      checkedAt: iso(row.pullVerifiedAt),
      errorCode: row.pullErrorCode,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function builderView(row: Builder): BuilderView {
  const capabilities = row.capabilitiesJson as unknown as
    (BuilderIdentity & { controlPlaneGenerationAtCheck?: number }) | null;
  return {
    id: row.id,
    name: row.name,
    instanceId: row.instanceId,
    identityPublicKey: row.identityPublicKey,
    endpoint: row.endpoint,
    credentialRefId: row.credentialRefId,
    revision: row.revision,
    profileRevision: row.profileRevision,
    profile: row.profileJson as unknown as BuilderView['profile'],
    enabled: row.enabled,
    verification: {
      state: row.verificationState as VerificationState,
      checkedAt: iso(row.verifiedAt),
      errorCode: row.lastErrorCode,
    },
    capabilities:
      capabilities &&
      Number.isSafeInteger(capabilities.highGeneration) &&
      Number.isSafeInteger(capabilities.controlPlaneGenerationAtCheck)
        ? {
            platform: capabilities.platform,
            maxConcurrency: capabilities.maxConcurrency,
            highGeneration: capabilities.highGeneration,
            controlPlaneGenerationAtCheck: capabilities.controlPlaneGenerationAtCheck!,
            checkedAt: capabilities.checkedAt,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
