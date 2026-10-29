import type { ImagePlatform } from '@ozz/infrastructure/registry';
import type {
  RuntimeConfiguration,
  ServiceSnapshotV3,
  ServiceTarget,
} from '../services/contracts.js';

export interface FixedBuildSecret {
  mountId: string;
  secretRefId: string;
  secretKey: string;
  contentRevision: number;
}

export interface GitSourceRevision {
  version: 1;
  id: string;
  sourceId: string;
  revision: number;
  provider: 'github';
  githubConnectionId: string;
  repository: { repositoryId: string; githubRepositoryId: string; fullNameAtCapture: string };
  branchRef: string;
  dockerfilePath: string;
  contextPath: string;
  buildArgs: Record<string, string>;
  buildSecrets: FixedBuildSecret[];
  platforms: ImagePlatform[];
  builder: {
    builderId: string;
    instanceId: string;
    profileRevision: number;
    buildkitVersion: string;
    frontendDigest: string;
  };
  destination: { registryConnectionId: string; authority: string; repository: string };
  recipeHash: string;
  createdAt: string;
}

export interface GitSourceInput {
  kind: 'github';
  repositoryId: string;
  branchRef: string;
  dockerfilePath: string;
  contextPath: string;
  buildArgs?: Record<string, string>;
  buildSecrets?: Array<{ mountId: string; secretRefId: string; secretKey?: string }>;
  platforms: ImagePlatform[];
  builderId: string;
  registryConnectionId: string;
  imageRepository: string;
  autoDeploy?: boolean;
}

export interface GitSourceSnapshot {
  kind: 'github';
  revision: GitSourceRevision;
  commitSha: string;
}

export type ServiceSourceView =
  | { kind: 'image' }
  | {
      kind: 'github';
      sourceId: string;
      currentRevision: GitSourceRevision;
      autoDeploy: boolean;
      policyRevision: number;
    };

export type GitPreviewSelection =
  | { kind: 'branch_head' }
  | { kind: 'commit'; commitSha: string }
  | { kind: 'pending_target'; webhookTargetId: string };

export interface GitPreviewInput {
  revision: number;
  selection: GitPreviewSelection;
}

export interface GitPublicationPreview {
  id: string;
  serviceRevision: number;
  configRevision: number;
  policyRevision: number;
  source: GitSourceSnapshot;
  target: ServiceTarget;
  configuration: RuntimeConfiguration;
  snapshot: ServiceSnapshotV3;
  desiredState: 'running' | 'stopped';
  webhookTargetId: string | null;
  issues: Array<{ code: string; field?: string; message: string }>;
  checkedAt: string;
  expiresAt: string;
}

export interface DeployGitInput {
  revision: number;
  previewId: string;
  deployAndStart?: boolean;
  allowConfigurationRepair?: boolean;
}

export interface WebhookTargetView {
  id: string;
  webhookDeliveryId: string;
  serviceId: string;
  currentServiceId: string | null;
  sourceRevisionId: string;
  commitSha: string;
  configRevisionAtReceipt: number;
  policyRevisionAtReceipt: number;
  target: ServiceTarget;
  receiptSequence: string;
  manualRequired: boolean;
  state: 'waiting' | 'pending' | 'ignored' | 'orphaned' | 'enqueued';
  reason: string;
  deploymentId: string | null;
  admittedAt: string | null;
  canPreview: boolean;
  blockedReason: string | null;
  createdAt: string;
}

export interface WebhookDeliveryView {
  id: string;
  provider: 'github';
  externalDeliveryId: string;
  repositoryId: string;
  githubRepositoryId: string;
  event: string;
  ref: string | null;
  afterSha: string | null;
  state: string;
  reason: string | null;
  duplicateCount: number;
  createdAt: string;
  lastReceivedAt: string;
}
