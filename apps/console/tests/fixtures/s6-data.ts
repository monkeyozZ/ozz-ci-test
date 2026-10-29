import type {
  Builder,
  BuildDetail,
  BuildRun,
  GitBranch,
  GitHubConnection,
  GitPreview,
  GitRepository,
  GitSource,
  RegistryConnection,
  WebhookDelivery,
  WebhookTarget,
} from '../../src/components/git/types';
import type { DeploymentDetail, Service } from '../../src/components/services/types';
import type { Cluster, Environment, Project, SecretReference } from '../../src/lib/types';

export const s6Ids = {
  connection: '66000000-0000-4000-8000-000000000001',
  repository: '66000000-0000-4000-8000-000000000002',
  source: '66000000-0000-4000-8000-000000000003',
  revision: '66000000-0000-4000-8000-000000000004',
  builder: '66000000-0000-4000-8000-000000000005',
  instance: '66000000-0000-4000-8000-000000000006',
  registry: '66000000-0000-4000-8000-000000000007',
  run: '66000000-0000-4000-8000-000000000008',
  artifact: '66000000-0000-4000-8000-000000000009',
  preview: '66000000-0000-4000-8000-000000000010',
  service: '66000000-0000-4000-8000-000000000011',
  project: '66000000-0000-4000-8000-000000000012',
  environment: '66000000-0000-4000-8000-000000000013',
  cluster: '66000000-0000-4000-8000-000000000014',
  installation: '66000000-0000-4000-8000-000000000015',
  deployment: '66000000-0000-4000-8000-000000000016',
  delivery: '66000000-0000-4000-8000-000000000017',
  target: '66000000-0000-4000-8000-000000000018',
  secret: '66000000-0000-4000-8000-000000000019',
  pushSecret: '66000000-0000-4000-8000-000000000020',
  pullSecret: '66000000-0000-4000-8000-000000000021',
  gitSecret: '66000000-0000-4000-8000-000000000022',
  webhookSecret: '66000000-0000-4000-8000-000000000023',
  builderSecret: '66000000-0000-4000-8000-000000000024',
  secondRepository: '66000000-0000-4000-8000-000000000025',
  secondTarget: '66000000-0000-4000-8000-000000000026',
  secondRun: '66000000-0000-4000-8000-000000000027',
  createdService: '66000000-0000-4000-8000-000000000028',
  publishedDeployment: '66000000-0000-4000-8000-000000000029',
};
export const s6Time = '2026-10-26T02:00:00.000Z';
export const s6Commit = '1234567890abcdef1234567890abcdef12345678';
export const s6Digest = 'sha256:' + 'a'.repeat(64);
export function makeGitSource(): GitSource {
  return {
    kind: 'github',
    sourceId: s6Ids.source,
    autoDeploy: true,
    policyRevision: 2,
    currentRevision: {
      version: 1,
      id: s6Ids.revision,
      sourceId: s6Ids.source,
      revision: 3,
      provider: 'github',
      githubConnectionId: s6Ids.connection,
      repository: {
        repositoryId: s6Ids.repository,
        githubRepositoryId: '12345',
        fullNameAtCapture: 'fixture-team/application',
      },
      branchRef: 'refs/heads/main',
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
      buildArgs: { APP_VERSION: 'reviewed-value' },
      buildSecrets: [
        {
          mountId: 'privatePackage',
          secretRefId: s6Ids.secret,
          secretKey: 'value',
          contentRevision: 4,
        },
      ],
      platforms: [{ os: 'linux', architecture: 'arm64', variant: 'v8' }],
      builder: {
        builderId: s6Ids.builder,
        instanceId: s6Ids.instance,
        profileRevision: 2,
        buildkitVersion: 'fixture-version',
        frontendDigest: s6Digest,
      },
      destination: {
        registryConnectionId: s6Ids.registry,
        authority: 'registry.example.test',
        repository: 'fixture-team/application',
      },
      recipeHash: 'b'.repeat(64),
      createdAt: s6Time,
    },
  };
}
export function makeRegistry(): RegistryConnection {
  const check = { state: 'verified' as const, checkedAt: s6Time, errorCode: null };
  return {
    id: s6Ids.registry,
    name: '受控镜像仓库',
    authority: 'registry.example.test',
    namespace: 'fixture-team',
    pushCredentialRefId: s6Ids.pushSecret,
    pullCredentialRefId: s6Ids.pullSecret,
    revision: 1,
    pushVerification: check,
    pullVerification: check,
    createdAt: s6Time,
    updatedAt: s6Time,
  };
}
export function makeBuildRun(overrides: Partial<BuildRun> = {}): BuildRun {
  return {
    id: s6Ids.run,
    runNumber: 1,
    builderId: s6Ids.builder,
    builderInstanceId: s6Ids.instance,
    specHash: 'c'.repeat(64),
    epoch: { generation: 1, ownershipEpoch: 1 },
    phase: 'pushing',
    executionState: 'ended',
    executionClosedAt: s6Time,
    closureReason: 'succeeded',
    submissionAttemptedAt: s6Time,
    cancelRequestedAt: null,
    observationState: 'reachable',
    lastObservedAt: s6Time,
    lastErrorCode: null,
    ledgerRevision: '9007199254740993',
    proofVerifiedAt: s6Time,
    logsTruncated: false,
    logsExpireAt: '2030-01-01T00:00:00.000Z',
    createdAt: s6Time,
    ...overrides,
  };
}
export function makeBuild(state: 'none' | 'oci' | 'registry' = 'registry'): BuildDetail {
  return {
    sourceRevisionId: s6Ids.revision,
    reuseArtifactId: state === 'none' ? null : s6Ids.artifact,
    runs: [makeBuildRun()],
    artifact:
      state === 'none'
        ? { state: 'none' }
        : {
            state,
            id: s6Ids.artifact,
            producedByRunId: s6Ids.run,
            sourceRevisionId: s6Ids.revision,
            commitSha: s6Commit,
            recipeHash: 'b'.repeat(64),
            rootDigest: s6Digest,
            rootMediaType: 'application/vnd.oci.image.manifest.v1+json',
            platforms: [
              {
                os: 'linux',
                architecture: 'arm64',
                variant: 'v8',
                manifestDigest: s6Digest,
                manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
                configDigest: 'sha256:' + 'd'.repeat(64),
              },
            ],
            archiveBytes: '65536',
            archiveExpiresAt: '2030-01-01T00:00:00.000Z',
            registryConnectionId: s6Ids.registry,
            destination: {
              authority: 'registry.example.test',
              repository: 'fixture-team/application',
            },
            image: null,
            pushedAt: state === 'registry' ? s6Time : null,
            lastVerifiedAt: null,
            availability: 'unknown',
          },
  };
}
export function makeGitPreview(overrides: Partial<GitPreview> = {}): GitPreview {
  const source = {
    kind: 'github' as const,
    revision: makeGitSource().currentRevision,
    commitSha: s6Commit,
  };
  const configuration = {
    replicas: 1,
    command: [],
    args: [],
    ports: [{ name: 'http', protocol: 'http' as const, containerPort: 8080, servicePort: 8080 }],
    resources: {
      requests: { cpuMillis: 50, memoryMiB: 64 },
      limits: { cpuMillis: 250, memoryMiB: 128 },
    },
    environment: [],
    readiness: null,
    startup: null,
    healthTimeoutSeconds: 120,
  };
  return {
    id: s6Ids.preview,
    serviceRevision: 7,
    configRevision: 3,
    policyRevision: 2,
    source,
    configuration,
    target: {
      installationId: s6Ids.installation,
      clusterId: s6Ids.cluster,
      kubeSystemUid: 'controlled-cluster-identity',
      projectId: s6Ids.project,
      environmentId: s6Ids.environment,
      namespace: 'controlled-s6',
      serviceName: 'git-application',
      serviceId: s6Ids.service,
    },
    snapshot: {
      version: 3,
      serviceId: s6Ids.service,
      serviceName: 'Git 服务样本',
      serviceSlug: 'git-application',
      configRevision: 3,
      configuration,
      source,
      deployAndStart: false,
      allowConfigurationRepair: false,
      controller: { kind: 'Deployment', strategy: 'RollingUpdate' },
      volumes: [],
      database: null,
      databaseBindings: [],
      template: null,
    },
    desiredState: 'stopped',
    webhookTargetId: s6Ids.target,
    issues: [{ code: 'DEPLOY_AND_START_REQUIRED', message: '停止中的服务需要明确发布并启动。' }],
    checkedAt: s6Time,
    expiresAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeGitHubConnection(): GitHubConnection {
  return {
    id: s6Ids.connection,
    name: '受控 GitHub 授权',
    authorization: 'fine_grained_pat',
    credentialRefId: s6Ids.gitSecret,
    revision: 2,
    verification: { state: 'verified', checkedAt: s6Time, errorCode: null },
    account: { id: '123', login: 'fixture-team' },
    createdAt: s6Time,
    updatedAt: s6Time,
  };
}

export function makeRepository(overrides: Partial<GitRepository> = {}): GitRepository {
  return {
    id: s6Ids.repository,
    githubConnectionId: s6Ids.connection,
    githubRepositoryId: '12345',
    fullName: 'fixture-team/application',
    defaultBranch: 'main',
    private: true,
    revision: 2,
    hook: {
      state: 'unregistered',
      hookId: null,
      callbackUrl: null,
      verifiedAt: null,
      errorCode: null,
      operationId: null,
    },
    lastVerifiedAt: s6Time,
    ...overrides,
  };
}

export const s6Branches: GitBranch[] = [
  { name: 'main', ref: 'refs/heads/main', commitSha: s6Commit },
  { name: 'release', ref: 'refs/heads/release', commitSha: 'e'.repeat(40) },
];

export function makeBuilder(overrides: Partial<Builder> = {}): Builder {
  return {
    id: s6Ids.builder,
    name: '受控独立 Builder',
    instanceId: s6Ids.instance,
    identityPublicKey: 'controlled-public-key',
    endpoint: 'https://builder.example.test',
    credentialRefId: s6Ids.builderSecret,
    revision: 2,
    profileRevision: 2,
    profile: {
      buildkitVersion: 'fixture-version',
      frontendDigest: s6Digest,
      instanceId: s6Ids.instance,
      profileRevision: 2,
    },
    verification: { state: 'verified', checkedAt: s6Time, errorCode: null },
    enabled: true,
    capabilities: {
      highGeneration: 4,
      controlPlaneGenerationAtCheck: 4,
      platform: { os: 'linux', architecture: 'arm64', variant: 'v8' },
      maxConcurrency: 1,
      checkedAt: s6Time,
    },
    createdAt: s6Time,
    updatedAt: s6Time,
    ...overrides,
  };
}

export const s6Secrets: SecretReference[] = [
  { id: s6Ids.gitSecret, kind: 'git', name: 'GitHub PAT 样本' },
  { id: s6Ids.webhookSecret, kind: 'webhook', name: 'Webhook 验签样本' },
  { id: s6Ids.pushSecret, kind: 'registry', name: 'Registry 推送样本' },
  { id: s6Ids.pullSecret, kind: 'registry', name: 'Registry 拉取样本' },
  { id: s6Ids.builderSecret, kind: 'builder', name: 'Builder mTLS 样本' },
  { id: s6Ids.secret, kind: 'generic', name: '显式构建秘密样本' },
].map((value) => ({
  ...value,
  kind: value.kind as SecretReference['kind'],
  revision: 1,
  keyVersion: 1,
  expiresAt: null,
  createdAt: s6Time,
  updatedAt: s6Time,
}));

export const s6Cluster: Cluster = {
  id: s6Ids.cluster,
  name: 'Git 隔离集群样本',
  slug: 'git-fixture-cluster',
  revision: 1,
  createdAt: s6Time,
  updatedAt: s6Time,
  description: null,
  region: null,
  apiEndpoint: 'https://192.0.2.66:6443',
  credentialRefId: null,
  connectionStatus: 'connected',
  lastObservedAt: s6Time,
  identity: null,
  observation: null,
  observationStale: false,
  nodeCount: 1,
  projectCount: 1,
  lastAttemptAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  lastOperationId: null,
};
export const s6Project: Project = {
  id: s6Ids.project,
  name: 'Git 界面契约样本',
  slug: 'git-fixture',
  revision: 1,
  createdAt: s6Time,
  updatedAt: s6Time,
  description: null,
  clusterId: s6Ids.cluster,
  cluster: s6Cluster,
};
export const s6Environment: Environment = {
  id: s6Ids.environment,
  name: '预发布',
  slug: 'staging',
  revision: 1,
  createdAt: s6Time,
  updatedAt: s6Time,
  description: null,
  projectId: s6Ids.project,
  clusterId: s6Ids.cluster,
  isDefault: false,
};

export function makeGitService(overrides: Partial<Service> = {}): Service {
  const preview = makeGitPreview();
  return {
    id: s6Ids.service,
    name: 'Git 服务样本',
    slug: 'git-application',
    description: '仅用于受控界面契约检查。',
    kind: 'application',
    controller: { kind: 'Deployment', strategy: 'RollingUpdate' },
    template: null,
    databaseInstanceId: null,
    projectId: s6Ids.project,
    environmentId: s6Ids.environment,
    clusterId: s6Ids.cluster,
    project: s6Project,
    environment: s6Environment,
    cluster: s6Cluster,
    revision: 7,
    configRevision: 3,
    mutationRevision: 1,
    configuration: preview.configuration,
    source: makeGitSource(),
    registryCredentialRefId: null,
    desiredState: 'stopped',
    configurationState: 'consistent',
    runtimeState: 'stopped',
    hasUnpublishedChanges: false,
    published: {
      deploymentId: s6Ids.publishedDeployment,
      configRevision: 3,
      configuration: preview.configuration,
      source: { ...preview.source, commitSha: '0'.repeat(40) },
      image: {
        version: 1,
        inputReference: 'registry.example.test/fixture-team/application@' + s6Digest,
        registry: 'registry.example.test',
        repository: 'fixture-team/application',
        tag: null,
        requestedDigest: s6Digest,
        manifestDigest: s6Digest,
        manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
        indexDigest: null,
        deployReference: 'registry.example.test/fixture-team/application@' + s6Digest,
        platformManifests: [],
        resolvedAt: s6Time,
      },
      appliedAt: s6Time,
    },
    lastSuccessfulDeploymentId: s6Ids.publishedDeployment,
    activeTask: null,
    observation: null,
    observationStale: true,
    remoteCreatedAt: s6Time,
    lastObservedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: s6Time,
    updatedAt: s6Time,
    ...overrides,
  };
}

export function makeGitDeployment(overrides: Partial<DeploymentDetail> = {}): DeploymentDetail {
  const preview = makeGitPreview();
  return {
    id: s6Ids.deployment,
    kind: 'git_deploy',
    scope: 'service',
    status: 'failed',
    phase: 'pushing',
    input: { serviceId: s6Ids.service, mutationRevision: 1 },
    serviceId: s6Ids.service,
    configRevision: 3,
    mutationRevision: 1,
    snapshot: preview.snapshot,
    sourceRevisionId: s6Ids.revision,
    reuseArtifactId: null,
    artifactId: s6Ids.artifact,
    initiatorKind: 'admin',
    webhookDeliveryId: null,
    webhookTargetId: null,
    target: preview.target,
    resolvedImage: null,
    appliedAt: null,
    result: null,
    failureObservation: null,
    createdAt: s6Time,
    updatedAt: s6Time,
    startedAt: s6Time,
    finishedAt: s6Time,
    attempts: 1,
    maxAttempts: 3,
    errorCode: 'REGISTRY_VERIFICATION_PENDING',
    errorMessage: '受控记录：推送完成后，镜像验证尚未确认。',
    retryOfId: null,
    cancelRequestedAt: null,
    pollUrl: '/api/deployments/' + s6Ids.deployment,
    stages: [],
    build: makeBuild('registry'),
    ...overrides,
  };
}

export function makeTarget(overrides: Partial<WebhookTarget> = {}): WebhookTarget {
  return {
    id: s6Ids.target,
    webhookDeliveryId: s6Ids.delivery,
    serviceId: s6Ids.service,
    currentServiceId: s6Ids.service,
    sourceRevisionId: s6Ids.revision,
    commitSha: s6Commit,
    configRevisionAtReceipt: 2,
    policyRevisionAtReceipt: 2,
    target: makeGitPreview().target,
    receiptSequence: '9007199254740993',
    manualRequired: true,
    state: 'pending',
    reason: 'service_stopped',
    deploymentId: null,
    admittedAt: null,
    canPreview: true,
    blockedReason: null,
    createdAt: s6Time,
    ...overrides,
  };
}

export function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: s6Ids.delivery,
    provider: 'github',
    externalDeliveryId: 'controlled-external-delivery',
    repositoryId: s6Ids.repository,
    githubRepositoryId: '12345',
    event: 'push',
    ref: 'refs/heads/main',
    afterSha: s6Commit,
    state: 'received',
    reason: null,
    duplicateCount: 1,
    createdAt: s6Time,
    lastReceivedAt: s6Time,
    ...overrides,
  };
}
