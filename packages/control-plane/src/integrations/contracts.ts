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
export type VerificationState = 'unverified' | 'verified' | 'failed';
export interface GitHubConnectionInput {
  name: string;
  credentialRefId: string;
}
export interface RegistryConnectionInput {
  name: string;
  authority: string;
  namespace: string;
  pushCredentialRefId: string;
  pullCredentialRefId: string;
}
export interface BuilderInput {
  name: string;
  instanceId: string;
  identityPublicKey: string;
  endpoint: string;
  credentialRefId: string;
  profile: { buildkitVersion: string; frontendDigest: string };
}
export interface ConnectionCheck {
  state: VerificationState;
  checkedAt: string | null;
  errorCode: string | null;
}
export interface GitHubConnectionView {
  id: string;
  name: string;
  authorization: 'fine_grained_pat';
  credentialRefId: string;
  revision: number;
  verification: ConnectionCheck;
  account: { id: string; login: string } | null;
  createdAt: string;
  updatedAt: string;
}
export interface GitRepositoryView {
  id: string;
  githubConnectionId: string;
  githubRepositoryId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  revision: number;
  hook: {
    state: string;
    hookId: string | null;
    callbackUrl: string | null;
    verifiedAt: string | null;
    errorCode: string | null;
    operationId: string | null;
  };
  lastVerifiedAt: string;
}
export interface RegistryConnectionView {
  id: string;
  name: string;
  authority: string;
  namespace: string;
  pushCredentialRefId: string;
  pullCredentialRefId: string;
  revision: number;
  pushVerification: ConnectionCheck;
  pullVerification: ConnectionCheck;
  createdAt: string;
  updatedAt: string;
}
export interface BuilderView {
  id: string;
  name: string;
  instanceId: string;
  identityPublicKey: string;
  endpoint: string;
  credentialRefId: string;
  revision: number;
  profileRevision: number;
  profile: {
    instanceId: string;
    profileRevision: number;
    buildkitVersion: string;
    frontendDigest: string;
  };
  verification: ConnectionCheck;
  enabled: boolean;
  capabilities: {
    platform: { os: 'linux'; architecture: 'amd64' | 'arm64'; variant?: string };
    maxConcurrency: number;
    highGeneration: number;
    controlPlaneGenerationAtCheck: number;
    checkedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}
