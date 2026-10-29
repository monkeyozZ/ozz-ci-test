import type { Database, Template, TemplateId, Volume } from '../../src/components/storage/types';
import type { Service, DeploymentDetail, Configuration } from '../../src/components/services/types';

/** Controlled interface data only. These identities never target a real cluster. */
export const s5Ids = {
  project: '51000000-0000-4000-8000-000000000001',
  environment: '51000000-0000-4000-8000-000000000002',
  cluster: '51000000-0000-4000-8000-000000000003',
  service: '51000000-0000-4000-8000-000000000004',
  volume: '51000000-0000-4000-8000-000000000005',
  database: '51000000-0000-4000-8000-000000000006',
  databaseService: '51000000-0000-4000-8000-000000000007',
  databaseVolume: '51000000-0000-4000-8000-000000000008',
  credential: '51000000-0000-4000-8000-000000000009',
  installation: '51000000-0000-4000-8000-000000000010',
  createdService: '51000000-0000-4000-8000-000000000011',
  createdVolume: '51000000-0000-4000-8000-000000000012',
  orphan: '51000000-0000-4000-8000-000000000013',
  mount: '51000000-0000-4000-8000-000000000014',
  binding: '51000000-0000-4000-8000-000000000015',
};
export const s5Project = { id: s5Ids.project, name: '数据界面契约样本', slug: 'data-fixture' };
export const s5Environment = { id: s5Ids.environment, name: '预发布', slug: 'staging' };
export const s5Cluster = { id: s5Ids.cluster, name: '隔离集群样本', slug: 'fixture-cluster' };
export const timestamp = () => new Date().toISOString();
export const s5Namespace = `ozz-e-${s5Ids.environment.replaceAll('-', '')}`;

export function makeVolume(overrides: Partial<Volume> = {}): Volume {
  return {
    id: s5Ids.volume,
    name: '上传文件样本',
    slug: 'uploads-fixture',
    revision: 3,
    project: s5Project,
    environment: s5Environment,
    cluster: s5Cluster,
    namespace: s5Namespace,
    requestedBytes: '1073741824',
    storageClassName: 'local-path',
    storageClassUid: 'fixture-storage-class-uid',
    storageClass: {
      name: 'local-path',
      uid: 'fixture-storage-class-uid',
      provisioner: 'rancher.io/local-path',
      bindingMode: 'WaitForFirstConsumer',
      reclaimPolicy: 'Delete',
      default: true,
      supported: true,
      code: null,
      message: '受控能力观察：支持本地卷。',
      hardQuotaSupport: 'unsupported',
      allowVolumeExpansion: false,
    },
    hardQuotaSupport: 'unsupported',
    desiredState: 'active',
    retained: false,
    destroyedAt: null,
    pvc: {
      name: 'ozz-volume-fixture',
      uid: 'fixture-pvc-uid',
      resourceVersion: '11',
      phase: 'Pending',
      deleting: false,
    },
    pv: null,
    locality: 'waiting_for_consumer',
    nodes: [],
    usage: { usedBytes: null, nodeAvailableBytes: null, observedAt: null },
    mounts: { desired: [], published: [], actual: [], truncated: false },
    observation: {
      state: 'pending',
      observedAt: timestamp(),
      stale: false,
      code: null,
      message: '等待第一个消费者后绑定 PV 与节点。',
    },
    maintenance: null,
    activeTask: null,
    deletionBlockers: [],
    retainedDatabase: null,
    manualDataIdentity: {
      installationId: s5Ids.installation,
      clusterId: s5Ids.cluster,
      kubeSystemUid: 'fixture-kube-system-uid',
      environmentId: s5Ids.environment,
      volumeId: s5Ids.volume,
      pvcUid: 'fixture-pvc-uid',
    },
    lastManualBackupRecord: null,
    lastAttemptAt: timestamp(),
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  };
}
export function makeDatabase(overrides: Partial<Database> = {}): Database {
  const service = { id: s5Ids.databaseService, name: '应用数据库样本', slug: 'database-fixture' };
  return {
    id: s5Ids.database,
    revision: 4,
    engine: 'postgresql',
    majorVersion: 17,
    exactVersion: '17.11',
    template: { id: 'postgresql', version: '1.0.0' },
    service,
    originalService: service,
    projectId: s5Ids.project,
    environmentId: s5Ids.environment,
    clusterId: s5Ids.cluster,
    dataVolume: {
      id: s5Ids.databaseVolume,
      name: '数据库数据样本',
      namespace: s5Namespace,
      pvcName: 'ozz-database-fixture',
      pvcUid: 'fixture-database-pvc-uid',
      requestedBytes: '4294967296',
      destroyedAt: null,
    },
    protection: {
      active: true,
      revision: 1,
      fencedAt: timestamp(),
      lockedFields: ['image', 'credentialRefId', 'dataVolumeId', 'dataLayout'],
      reason: '已建立首次写入保护，初始化身份与数据目录保持固定。',
    },
    initialization: {
      state: 'initialized',
      initializedAt: timestamp(),
      pvcUid: 'fixture-database-pvc-uid',
    },
    credential: { refId: s5Ids.credential, contentRevision: 1 },
    connection: {
      host: `ozz-database-fixture.${s5Namespace}.svc.cluster.local`,
      port: 5432,
      username: 'app',
      database: 'app',
      redisDatabase: null,
      visibility: 'cluster_private',
    },
    databaseReady: true,
    observation: {
      state: 'ready',
      authenticated: true,
      engineVersion: '17.11',
      persistence: 'postgres_wal',
      podUid: 'fixture-db-pod-uid',
      pvcUid: 'fixture-database-pvc-uid',
      observedAt: timestamp(),
      code: null,
      message: '受控样本：认证与引擎检查通过。',
    },
    observationStale: false,
    consumers: [],
    consumersTruncated: false,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  };
}
export function makeTemplate(id: TemplateId = 'postgresql'): Template {
  const database = id === 'postgresql' || id === 'redis';
  const names = {
    docker: 'Docker 镜像',
    'node-example': 'Node.js 示例',
    'static-example': '静态站点示例',
    postgresql: 'PostgreSQL',
    redis: 'Redis',
  };
  const parameters: Template['parameters'] =
    id === 'docker'
      ? [
          {
            name: 'image',
            label: '镜像地址',
            description: '使用明确版本或摘要。',
            type: 'string',
            required: true,
            defaultValue: null,
            minimum: null,
            maximum: null,
          },
          {
            name: 'port',
            label: 'HTTP 端口',
            description: '容器监听端口。',
            type: 'integer',
            required: false,
            defaultValue: 8080,
            minimum: 1,
            maximum: 65535,
          },
        ]
      : database
        ? [
            ...(id === 'postgresql'
              ? [
                  {
                    name: 'username' as const,
                    label: '初始用户名',
                    description: '首次写入后受保护。',
                    type: 'string' as const,
                    required: false,
                    defaultValue: 'app',
                    minimum: null,
                    maximum: null,
                  },
                  {
                    name: 'databaseName' as const,
                    label: '数据库名称',
                    description: '固定初始化数据库名。',
                    type: 'string' as const,
                    required: false,
                    defaultValue: 'app',
                    minimum: null,
                    maximum: null,
                  },
                ]
              : [
                  {
                    name: 'redisDatabase' as const,
                    label: '默认数据库编号',
                    description: '连接输出的逻辑库编号。',
                    type: 'integer' as const,
                    required: false,
                    defaultValue: 0,
                    minimum: 0,
                    maximum: 15,
                  },
                ]),
            {
              name: 'requestedBytes',
              label: '申请容量',
              description: '本地卷申请量。',
              type: 'bytes',
              required: false,
              defaultValue: '1073741824',
              minimum: null,
              maximum: null,
            },
          ]
        : [];
  return {
    id,
    version: '1.0.0',
    name: names[id],
    description: `${names[id]} 的受控界面契约样本。`,
    category: database ? 'database' : 'application',
    sourceUrl: 'https://example.test/template-fixture',
    license: '受控测试资料',
    image:
      id === 'docker'
        ? null
        : {
            reference: `example.test/fixture/${id}@sha256:${'a'.repeat(64)}`,
            digest: `sha256:${'a'.repeat(64)}`,
            version: id === 'postgresql' ? '17.11' : id === 'redis' ? '7.4.11' : '1.0',
            platforms: ['arm64', 'amd64'],
            verifiedAt: timestamp(),
          },
    parameters,
    resources: {
      requests: { cpuMillis: 100, memoryMiB: 128 },
      limits: { cpuMillis: 500, memoryMiB: 512 },
    },
    controller: { kind: database ? 'StatefulSet' : 'Deployment', strategy: 'RollingUpdate' },
    persistent: database,
    notes: database
      ? ['单实例，默认私有连接。', '由服务端生成数据库凭证。']
      : ['预构建镜像，无源码构建任务。'],
  };
}
export type S5Service = Service & {
  source: { kind: 'image' };
  configuration: Configuration;
  controller: { kind: 'Deployment' | 'StatefulSet'; strategy: string };
  template: { id: string; version: string } | null;
  databaseInstanceId: string | null;
};
export function makeService(overrides: Partial<S5Service> = {}): S5Service {
  const configuration = {
    image: 'example.test/fixture/app:1.0',
    replicas: 1,
    command: [],
    args: [],
    ports: [{ name: 'http', protocol: 'http' as const, containerPort: 8080, servicePort: 8080 }],
    resources: {
      requests: { cpuMillis: 100, memoryMiB: 64 },
      limits: { cpuMillis: 500, memoryMiB: 256 },
    },
    environment: [],
    readiness: null,
    startup: null,
    healthTimeoutSeconds: 120,
  };
  return {
    id: s5Ids.service,
    name: '应用服务样本',
    slug: 'application-fixture',
    description: '受控界面验证，未连接真实基础设施。',
    kind: 'application',
    source: { kind: 'image' },
    projectId: s5Ids.project,
    environmentId: s5Ids.environment,
    clusterId: s5Ids.cluster,
    project: s5Project,
    environment: s5Environment,
    cluster: { ...s5Cluster, connectionStatus: 'connected', lastObservedAt: timestamp() },
    revision: 7,
    configRevision: 3,
    mutationRevision: 1,
    configuration,
    registryCredentialRefId: null,
    desiredState: 'running',
    configurationState: 'consistent',
    runtimeState: 'running',
    hasUnpublishedChanges: false,
    published: {
      deploymentId: '52000000-0000-4000-8000-000000000001',
      configRevision: 3,
      configuration,
      source: { kind: 'image' },
      image: null,
      appliedAt: timestamp(),
    },
    lastSuccessfulDeploymentId: '52000000-0000-4000-8000-000000000001',
    activeTask: null,
    observation: null,
    observationStale: true,
    remoteCreatedAt: timestamp(),
    lastObservedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    controller: { kind: 'Deployment', strategy: 'RollingUpdate' },
    template: null,
    databaseInstanceId: null,
    ...overrides,
  };
}

type S5Deployment = Omit<DeploymentDetail, 'snapshot'> & {
  snapshot: Extract<DeploymentDetail['snapshot'], { version: 1 | 2 }>;
};
export function makeDeployment(overrides: Partial<S5Deployment> = {}): S5Deployment {
  const service = makeService();
  const volume = makeVolume();
  const database = makeDatabase();
  const target = {
    installationId: s5Ids.installation,
    clusterId: s5Ids.cluster,
    kubeSystemUid: 'fixture-kube-system-uid',
    projectId: s5Ids.project,
    environmentId: s5Ids.environment,
    namespace: s5Namespace,
    serviceName: 'fixture-service',
    serviceId: s5Ids.service,
  };
  return {
    id: '52000000-0000-4000-8000-000000000001',
    kind: 'image_deploy',
    scope: 'service',
    status: 'failed',
    phase: 'waiting_healthy',
    input: { serviceId: s5Ids.service, mutationRevision: 1 },
    serviceId: s5Ids.service,
    configRevision: 3,
    mutationRevision: 1,
    sourceRevisionId: null,
    reuseArtifactId: null,
    artifactId: null,
    initiatorKind: 'admin',
    webhookDeliveryId: null,
    webhookTargetId: null,
    build: null,
    snapshot: {
      version: 2,
      serviceId: service.id,
      serviceName: service.name,
      serviceSlug: service.slug,
      configRevision: 3,
      configuration: service.configuration,
      deployAndStart: false,
      allowConfigurationRepair: false,
      controller: { kind: 'Deployment', strategy: 'Recreate' },
      template: { id: 'node-example', version: '1.0.0' },
      database: null,
      volumes: [
        {
          volumeId: volume.id,
          mountId: s5Ids.mount,
          volumeRevision: volume.revision,
          target: {
            installationId: target.installationId,
            clusterId: target.clusterId,
            kubeSystemUid: target.kubeSystemUid,
            projectId: target.projectId,
            environmentId: target.environmentId,
            namespace: target.namespace,
            volumeId: volume.id,
          },
          pvcName: volume.pvc.name,
          pvcUid: volume.pvc.uid,
          creationNonce: 'fixture-creation-nonce',
          storageClassName: volume.storageClassName,
          storageClassUid: volume.storageClassUid,
          requestedBytes: volume.requestedBytes,
          mountPath: '/original-data',
          readOnly: false,
        },
      ],
      databaseBindings: [
        {
          version: 1,
          bindingId: s5Ids.binding,
          databaseInstanceId: database.id,
          providerServiceId: s5Ids.databaseService,
          providerDeploymentId: '52000000-0000-4000-8000-000000000002',
          providerServiceUid: 'fixture-original-provider-service-uid',
          clusterId: s5Ids.cluster,
          environmentId: s5Ids.environment,
          namespace: s5Namespace,
          host: database.connection.host!,
          port: database.connection.port,
          engine: database.engine,
          databaseName: database.connection.database,
          redisDatabase: null,
          username: database.connection.username,
          credentialRefId: database.credential.refId,
          credentialContentRevision: 1,
          profile: 'url',
          mapping: { url: 'ORIGINAL_DATABASE_URL' },
        },
      ],
    },
    target,
    resolvedImage: null,
    appliedAt: timestamp(),
    result: null,
    failureObservation: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    startedAt: timestamp(),
    finishedAt: timestamp(),
    attempts: 1,
    maxAttempts: 3,
    errorCode: 'FIXTURE_HEALTH_TIMEOUT',
    errorMessage: '受控失败记录，用于验证原快照重试。',
    retryOfId: null,
    cancelRequestedAt: null,
    pollUrl: '/api/deployments/52000000-0000-4000-8000-000000000001',
    stages: [],
    ...overrides,
  };
}
