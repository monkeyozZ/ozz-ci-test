import type { Page, Route } from '@playwright/test';
import type { components } from '@ozz/api-client';

type Schema = components['schemas'];
type Domain = Schema['DomainDto'];
type Operation = Schema['OperationDto'];

export const ids = {
  project: '10000000-0000-4000-8000-000000000001',
  environment: '10000000-0000-4000-8000-000000000002',
  cluster: '10000000-0000-4000-8000-000000000003',
  service: '10000000-0000-4000-8000-000000000004',
  port: '10000000-0000-4000-8000-000000000005',
  domain: '10000000-0000-4000-8000-000000000006',
};
export const servicePath = `/projects/${ids.project}/services/${ids.service}?environment=staging&tab=network`;
const timestamp = () => new Date().toISOString();
const project = { id: ids.project, name: '网络交互样本', slug: 'network-fixture' };
const environment = { id: ids.environment, name: '预发布', slug: 'staging' };
const cluster = { id: ids.cluster, name: '隔离集群样本', slug: 'fixture-cluster' };
const eligiblePort: Schema['EligibleHttpPortDto'] = {
  id: ids.port,
  name: 'web',
  protocol: 'http',
  containerPort: 3000,
  servicePort: 80,
  publishedConfigRevision: 7,
};
const configuration: Schema['ServiceConfigurationDto'] = {
  replicas: 1,
  image: 'example.test/fixture/web:published',
  command: [],
  args: [],
  ports: [{ name: 'web', protocol: 'http', containerPort: 3000, servicePort: 80 }],
  resources: {
    requests: { cpuMillis: 50, memoryMiB: 64 },
    limits: { cpuMillis: 250, memoryMiB: 256 },
  },
  environment: [],
  readiness: null,
  startup: null,
  healthTimeoutSeconds: 120,
};
const service: Schema['ServiceResponseDto'] = {
  id: ids.service,
  name: '长名称网络服务样本',
  slug: 'network-web',
  description: '用于前端契约验证的受控数据。',
  kind: 'image',
  projectId: ids.project,
  environmentId: ids.environment,
  clusterId: ids.cluster,
  project,
  environment,
  cluster: { ...cluster, connectionStatus: 'connected', lastObservedAt: timestamp() },
  revision: 12,
  configRevision: 8,
  mutationRevision: 4,
  configuration: {
    ...configuration,
    ports: [{ name: 'web', protocol: 'http', containerPort: 9000, servicePort: 9999 }],
  },
  registryCredentialRefId: null,
  desiredState: 'running',
  configurationState: 'consistent',
  runtimeState: 'running',
  hasUnpublishedChanges: true,
  published: {
    deploymentId: '10000000-0000-4000-8000-000000000007',
    configRevision: 7,
    configuration,
    image: null,
    appliedAt: timestamp(),
  },
  lastSuccessfulDeploymentId: '10000000-0000-4000-8000-000000000007',
  activeTask: null,
  observation: null,
  observationStale: true,
  remoteCreatedAt: timestamp(),
  lastObservedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: timestamp(),
  updatedAt: timestamp(),
};
const clusterResource: Schema['ClusterResponseDto'] = {
  ...cluster,
  revision: 4,
  createdAt: timestamp(),
  updatedAt: timestamp(),
  identity: null,
  observation: null,
  observationStale: false,
  nodeCount: 1,
  lastAttemptAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  lastOperationId: null,
  description: null,
  region: null,
  apiEndpoint: 'https://192.0.2.10:6443',
  credentialRefId: null,
  connectionStatus: 'connected',
  lastObservedAt: timestamp(),
  projectCount: 1,
};
const projectResource: Schema['ProjectResponseDto'] = {
  ...project,
  revision: 1,
  createdAt: timestamp(),
  updatedAt: timestamp(),
  description: null,
  clusterId: ids.cluster,
  cluster: { ...cluster, connectionStatus: 'connected', lastObservedAt: timestamp() },
};
const environmentResource: Schema['EnvironmentResponseDto'] = {
  ...environment,
  revision: 1,
  createdAt: timestamp(),
  updatedAt: timestamp(),
  description: null,
  projectId: ids.project,
  clusterId: ids.cluster,
  isDefault: false,
};

export function makeDomain(): Domain {
  return {
    id: ids.domain,
    hostname: 'network-web-a1b2c3.fixture.apps.example.test',
    kind: 'default',
    serviceId: ids.service,
    serviceName: service.name,
    servicePort: eligiblePort,
    project,
    environment,
    cluster,
    revision: 1,
    desiredState: 'active',
    certificateEnvironment: 'staging',
    dns: null,
    route: null,
    certificate: null,
    observationStale: false,
    activeTask: null,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

export function setReadyObservations(domain: Domain, mode: 'staging' | 'production' = 'staging') {
  domain.dns = {
    state: 'matched',
    observedAt: timestamp(),
    addresses: ['192.0.2.10'],
    expectedAddresses: ['192.0.2.10'],
    cnameChain: [],
    expectedCname: null,
    code: null,
    message: '本次 A 记录与配置的入口地址一致。',
  };
  domain.route = {
    state: 'ready',
    observedAt: timestamp(),
    ingressNames: ['ozz-domain-fixture'],
    backendServiceName: 'ozz-s-network-fixture',
    portName: 'web',
    readyEndpoints: 1,
    code: null,
    message: '受管路由指向已发布的具名 HTTP 端口。',
  };
  domain.certificateEnvironment = mode;
  domain.certificate = {
    state: mode === 'staging' ? 'staging_ready' : 'ready',
    environment: mode,
    authority: 'letsencrypt',
    observedAt: timestamp(),
    certificateName: 'ozz-domain-fixture',
    issuerName: `ozz-${mode}`,
    notBefore: new Date(Date.now() - 86_400_000).toISOString(),
    notAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    renewalTime: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    code: null,
    message:
      mode === 'staging'
        ? 'staging 测试证书已签发，不受浏览器信任。'
        : '受控 production 状态样本。',
  };
}

export async function installS4Fixture(page: Page) {
  const state = {
    source:
      'controlled-interface-fixture; no backend networking calls or real infrastructure effects',
    platform: {
      revision: 1,
      appsDomainSuffix: 'apps.example.test',
      acmeEmail: 'acme@example.test',
      updatedAt: timestamp(),
    } as Schema['PlatformSettingsDto'],
    networking: {
      clusterId: ids.cluster,
      revision: 1,
      subdomain: 'fixture',
      entryAddresses: ['192.0.2.10'],
      cnameTarget: null,
      domainSuffix: 'fixture.apps.example.test',
      ingressClassName: 'traefik',
      capabilities: null,
      capabilitiesStale: false,
      updatedAt: timestamp(),
    } as Schema['ClusterNetworkingDto'],
    domains: [] as Domain[],
    operations: [] as Operation[],
    restoreMode: false,
    platformConflict: false,
    reconcileConflict: false,
    beforePlatformReply: undefined as undefined | (() => Promise<void>),
    writes: [] as { method: string; path: string; body: unknown; key: string | null }[],
    reads: [] as { path: string; query: Record<string, string> }[],
    unexpected: [] as string[],
  };
  let operationSequence = 0;
  function operation(kind: Operation['kind'], domain?: Domain): Operation {
    const domainInput: Schema['DomainOperationInputDto'] | undefined = domain
      ? {
          domainId: domain.id,
          hostname: domain.hostname,
          serviceId: domain.serviceId,
          serviceMutationRevision: 4,
          domainRevision: domain.revision,
          platformRevision: state.platform.revision,
          networkRevision: state.networking.revision,
          certificateEnvironment: domain.certificateEnvironment,
          target: {
            installationId: '10000000-0000-4000-8000-000000000010',
            clusterId: ids.cluster,
            kubeSystemUid: '10000000-0000-4000-8000-000000000011',
            projectId: ids.project,
            environmentId: ids.environment,
            namespace: 'ozz-e-network-fixture',
            serviceName: 'ozz-s-network-fixture',
            serviceId: ids.service,
            serviceUid: '10000000-0000-4000-8000-000000000012',
            domainId: domain.id,
            hostname: domain.hostname,
            portId: ids.port,
            portName: 'web',
          },
        }
      : undefined;
    const value: Operation = {
      id: `20000000-0000-4000-8000-${String(++operationSequence).padStart(12, '0')}`,
      kind,
      scope: domain ? 'service' : 'cluster',
      serverId: null,
      clusterId: ids.cluster,
      serviceId: domain?.serviceId ?? null,
      status: 'queued',
      input: domainInput ?? {
        clusterId: ids.cluster,
        installationId: '10000000-0000-4000-8000-000000000010',
        kubeSystemUid: '10000000-0000-4000-8000-000000000011',
        clusterConnectionRevision: 4,
        networkRevision: state.networking.revision,
      },
      result: null,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      retryOfId: null,
      cancelRequestedAt: null,
      pollUrl: `/api/operations/20000000-0000-4000-8000-${String(operationSequence).padStart(12, '0')}`,
    };
    state.operations.unshift(value);
    if (domain)
      domain.activeTask = {
        type: 'operation',
        id: value.id,
        kind: value.kind,
        status: value.status,
      };
    return value;
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const list = (route: Route, data: unknown[], url: URL) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 50);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const next = offset + limit;
    return json(route, {
      data: data.slice(offset, next),
      page: { hasMore: next < data.length, nextCursor: next < data.length ? String(next) : null },
    });
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    const method = request.method();
    const body = method === 'GET' ? undefined : request.postDataJSON();
    const key = request.headers()['idempotency-key'] ?? null;
    if (method === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    else state.writes.push({ method, path, body, key });
    if (path === '/auth/me')
      return json(route, {
        data: {
          user: { id: '30000000-0000-4000-8000-000000000001', username: '界面契约测试' },
          csrfToken: 'fixture-only-not-authenticated',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          restoreMode: state.restoreMode,
        },
      });
    if (path === '/platform-settings') {
      if (method === 'GET') return json(route, { data: state.platform });
      if (method === 'PATCH') {
        if (state.platformConflict)
          return json(
            route,
            {
              status: 409,
              code: 'NETWORK_SETTINGS_IN_USE',
              detail: `入口已被 ${makeDomain().hostname} 引用。`,
              requestId: 'fixture-conflict',
            },
            409,
          );
        state.platform = { ...body, revision: body.revision + 1, updatedAt: timestamp() };
        if (state.beforePlatformReply) await state.beforePlatformReply();
        return json(route, { data: state.platform });
      }
    }
    if (path === `/clusters/${ids.cluster}/networking`) {
      if (method === 'GET') return json(route, { data: state.networking });
      if (method === 'PATCH') {
        state.networking = {
          ...state.networking,
          ...body,
          revision: body.revision + 1,
          domainSuffix: `${body.subdomain}.${state.platform.appsDomainSuffix}`,
          updatedAt: timestamp(),
        };
        return json(route, { data: state.networking });
      }
    }
    if (path === `/clusters/${ids.cluster}/networking/check` && method === 'POST')
      return json(route, { data: operation('cluster_network_check') }, 202);
    if (path === `/clusters/${ids.cluster}/networking/install-cert-manager` && method === 'POST')
      return json(route, { data: operation('cluster_cert_manager_install') }, 202);
    if (path === `/services/${ids.service}/networking`) {
      const domains = state.domains.filter((domain) => domain.serviceId === ids.service);
      const blockers: { code: string; message: string }[] = [];
      if (!state.platform.appsDomainSuffix)
        blockers.push({ code: 'FIXTURE_SUFFIX_MISSING', message: '请先配置默认应用后缀。' });
      if (!state.networking.domainSuffix)
        blockers.push({ code: 'FIXTURE_ENTRY_MISSING', message: '请先配置该集群的应用入口。' });
      const data: Schema['ServiceNetworkingDto'] = {
        serviceId: ids.service,
        serviceRevision: service.revision,
        publishedConfigRevision: 7,
        project,
        environment,
        cluster,
        eligiblePorts: [eligiblePort],
        blockers,
        platformSettings: state.platform,
        clusterNetworking: state.networking,
        domains,
      };
      return json(route, { data });
    }
    if (path === `/services/${ids.service}/domains` && method === 'POST') {
      if (!key || body.portId !== ids.port || body.revision !== service.revision)
        return json(
          route,
          { status: 422, detail: '契约测试：绑定必须使用已发布端口的稳定 ID 与服务 revision。' },
          422,
        );
      const domain = makeDomain();
      state.domains.push(domain);
      return json(route, { data: operation('domain_bind', domain) }, 202);
    }
    if (path === '/domains' && method === 'GET') {
      const q = url.searchParams;
      const data = state.domains.filter(
        (domain) =>
          (!q.get('search') ||
            `${domain.hostname} ${domain.serviceName}`
              .toLowerCase()
              .includes(q.get('search')!.toLowerCase())) &&
          (!q.get('projectId') || domain.project.id === q.get('projectId')) &&
          (!q.get('environmentId') || domain.environment.id === q.get('environmentId')) &&
          (!q.get('clusterId') || domain.cluster.id === q.get('clusterId')) &&
          (!q.get('serviceId') || domain.serviceId === q.get('serviceId')),
      );
      return list(route, data, url);
    }
    const domainMatch = path.match(/^\/domains\/([^/]+)(?:\/(sync|reconcile|production))?$/);
    if (domainMatch) {
      const domain = state.domains.find((item) => item.id === domainMatch[1]);
      if (!domain) return json(route, { status: 404, detail: '测试域名不存在。' }, 404);
      if (method === 'GET') return json(route, { data: domain });
      if (!key || body.revision !== domain.revision)
        return json(route, { status: 409, detail: '测试域名版本冲突。' }, 409);
      if (method === 'DELETE') {
        domain.desiredState = 'deleting';
        return json(route, { data: operation('domain_unbind', domain) }, 202);
      }
      if (method === 'POST' && domainMatch[2]) {
        if (domainMatch[2] === 'reconcile' && state.reconcileConflict)
          return json(
            route,
            {
              status: 409,
              code: 'PUBLISHED_HTTP_PORT_REQUIRED',
              detail: '当前已发布配置无法提供此绑定端口，请先核对服务。',
              requestId: 'fixture-reconcile-conflict',
            },
            409,
          );
        if (domainMatch[2] === 'production') domain.certificateEnvironment = 'production';
        if (domainMatch[2] === 'reconcile') domain.revision += 1;
        return json(
          route,
          {
            data: operation(
              domainMatch[2] === 'production'
                ? 'domain_production'
                : domainMatch[2] === 'reconcile'
                  ? 'domain_reconcile'
                  : 'domain_sync',
              domain,
            ),
          },
          202,
        );
      }
    }
    if (path === '/operations/worker-status')
      return json(route, {
        data: {
          status: 'offline',
          queue: 'unknown',
          queuedCount: state.operations.filter((op) => op.status === 'queued').length,
          unpublishedCount: 0,
          workers: [],
        },
      });
    if (path === '/operations') return list(route, state.operations, url);
    const opMatch = path.match(/^\/operations\/([^/]+)(?:\/(logs|retry|cancel))?$/);
    if (opMatch) {
      const value = state.operations.find((item) => item.id === opMatch[1]);
      if (!value) return json(route, { status: 404, detail: '测试操作不存在。' }, 404);
      if (opMatch[2] === 'logs')
        return json(route, {
          data: [],
          page: { hasMore: false, nextCursor: null },
          source: 'operation',
          available: false,
          unavailableReason: 'not_started',
          truncated: false,
        });
      if (opMatch[2] === 'cancel') {
        value.cancelRequestedAt = timestamp();
        return json(route, { data: value });
      }
      if (opMatch[2] === 'retry')
        return json(
          route,
          {
            data: operation(
              value.kind,
              state.domains.find(
                (item) => item.id === ('domainId' in value.input ? value.input.domainId : ''),
              ),
            ),
          },
          202,
        );
      return json(route, { data: value });
    }
    if (path === '/projects') return list(route, [projectResource], url);
    if (path === `/projects/${ids.project}`) return json(route, { data: projectResource });
    if (path === '/environments') return list(route, [environmentResource], url);
    if (path === '/clusters') return list(route, [clusterResource], url);
    if (path === `/clusters/${ids.cluster}`) return json(route, { data: clusterResource });
    if (path === '/services') return list(route, [service], url);
    if (path === `/services/${ids.service}`) return json(route, { data: service });
    if (path === '/secrets') return list(route, [], url);
    state.unexpected.push(`${method} ${path}`);
    return json(route, { status: 501, detail: '未声明的受控接口。' }, 501);
  });
  return state;
}
