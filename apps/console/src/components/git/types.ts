import type { components } from '@ozz/api-client';

type Schema = components['schemas'];
export type GitHubConnection = Schema['GitHubConnectionDto'];
export type GitHubConnectionInput = Schema['GitHubConnectionCreateDto'];
export type GitHubConnectionUpdate = Schema['GitHubConnectionUpdateDto'];
export type GitRepository = Schema['GitRepositoryDto'];
export type GitBranch = Schema['GitBranchDto'];
export type RegistryConnection = Schema['RegistryConnectionDto'];
export type RegistryConnectionInput = Schema['RegistryConnectionCreateDto'];
export type RegistryConnectionUpdate = Schema['RegistryConnectionUpdateDto'];
export type Builder = Schema['BuilderDto'];
export type BuilderInput = Schema['BuilderCreateDto'];
export type BuilderUpdate = Schema['BuilderUpdateDto'];
export type IntegrationCheck = Schema['IntegrationCheckDto'];
export type RegisterWebhookInput = Schema['RegisterWebhookDto'];
export type GitSource = Schema['GitSourceDto'];
export type GitSourceInput = Schema['GitSourceInputDto'];
export type GitSourceUpdate = Schema['GitSourceUpdateDto'];
export type GitPolicyUpdate = Schema['GitPolicyUpdateDto'];
export type GitSourceRevision = Schema['GitSourceRevisionDto'];
export type GitSourceSnapshot = Schema['GitSourceSnapshotDto'];
export type GitPreviewInput = Schema['GitPreviewRequestDto'];
export type GitPreview = Schema['GitPublicationPreviewDto'];
export type WebhookTarget = Schema['WebhookTargetDto'];
export type WebhookDelivery = Schema['WebhookDeliveryDto'];
export type WebhookDeliveryDetail = Schema['WebhookDeliveryDetailDto'];
export type WebhookRejections = Schema['WebhookRejectionListDto'];
export type BuildDetail = Schema['BuildDetailDto'];
export type BuildRun = Schema['BuildRunDto'];
export type BuildLogPage = Schema['BuildLogPageDto'];
export type BuildLogChunk = Schema['BuildLogChunkDto'];

// Form-only state. Public requests and responses always use the generated DTOs above.
export interface GitSourceDraft {
  connectionId: string;
  repositoryId: string;
  branchRef: string;
  dockerfilePath: string;
  contextPath: string;
  builderId: string;
  registryConnectionId: string;
  imageRepository: string;
  architectures: Array<'amd64' | 'arm64'>;
  variants: Partial<Record<'amd64' | 'arm64', 'v1' | 'v8'>>;
  buildArgs: Array<{ rowId: string; name: string; value: string }>;
  buildSecrets: Array<{ rowId: string; mountId: string; secretRefId: string; secretKey: string }>;
  autoDeploy: boolean;
}
