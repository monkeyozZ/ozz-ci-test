import type { Page, Route } from '@playwright/test';
import type { ServiceNetworking } from '../../src/components/networking/types';
import type {
  Service,
  UpdateServiceInput,
  WorkloadObservation,
} from '../../src/components/services/types';
import { installS5Fixture, s5Ids } from './s5-fixture';
import { installS6Fixture } from './s6-fixture';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function observation(service: Service): WorkloadObservation {
  const time = new Date().toISOString();
  const metrics = {
    state: 'available' as const,
    cpuCores: 0.04,
    memoryBytes: 64 * 1024 * 1024,
    observedAt: time,
    windowSeconds: 30,
  };
  return {
    observedAt: time,
    configurationState: 'consistent',
    drift: [],
    resources: [],
    deployment: null,
    controller: null,
    pods: [
      {
        uid: '71000000-0000-4000-8000-000000000001',
        name: 'workspace-fixture-pod',
        namespace: 'workspace-fixture-only',
        nodeName: 'fixture-node',
        createdAt: time,
        deletionTimestamp: null,
        phase: 'Running',
        ready: true,
        snapshotId: service.published?.deploymentId ?? null,
        configRevision: service.configRevision,
        rolloutId: null,
        replicaSetUid: null,
        matchesDeploymentTemplate: true,
        containers: ['app', 'sidecar'].map((name) => ({
          name,
          image: 'fixture.example.test/workspace:1',
          imageId: 'fixture.example.test/workspace@sha256:' + 'a'.repeat(64),
          ready: true,
          restartCount: 0,
          state: 'running' as const,
          reason: null,
          lastTerminationReason: null,
          oomKilled: false,
          exitCode: null,
          requests: { cpuCores: 0.1, memoryBytes: 64 * 1024 * 1024 },
          limits: { cpuCores: 0.5, memoryBytes: 256 * 1024 * 1024 },
          metrics,
        })),
      },
    ],
    podsTruncated: false,
    events: [],
    eventsState: 'available',
    eventsTruncated: false,
    metrics,
    metricsErrorCode: null,
    serviceDns: 'workspace-fixture.workspace-fixture-only.svc.cluster.local',
  };
}

/** Only adds controlled responses needed by the workspace; all other API calls stay in S5/S6. */
async function extendWorkspaceFixture(
  page: Page,
  state:
    Awaited<ReturnType<typeof installS5Fixture>> | Awaited<ReturnType<typeof installS6Fixture>>,
  kind: 'image' | 'git',
) {
  for (const service of state.services) {
    if (!service.source) service.source = { kind: 'image' };
  }
  const service = state.services[0]!;
  service.configuration.ports.push({
    name: 'admin',
    protocol: 'http',
    containerPort: 9090,
    servicePort: 9090,
  });
  if (kind === 'image') {
    service.observation = observation(service);
    service.observationStale = false;
    service.lastObservedAt = service.observation.observedAt;
  }
  const controls = {
    beforeDeploymentReply: undefined as undefined | (() => Promise<void>),
    beforeLogReply: undefined as undefined | (() => Promise<void>),
  };
  const pathFor = (tab = 'overview', environment = true, id = service.id) =>
    `/projects/${service.projectId}/services/${id}?${environment ? 'environment=staging&' : ''}tab=${tab}`;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    const method = request.method();
    const serviceMatch = path.match(/^\/services\/([^/]+)(?:\/(.*))?$/);
    const current = serviceMatch && state.services.find((value) => value.id === serviceMatch[1]);
    const action = serviceMatch?.[2];
    const handled =
      path === '/services/parse-env' ||
      (current &&
        ((action === 'networking' && method === 'GET') ||
          (!action && method === 'PATCH') ||
          (action === 'logs' && method === 'GET')));
    if (action === 'deployments' && method === 'POST') await controls.beforeDeploymentReply?.();
    if (!handled) return route.fallback();
    if (method === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    else
      state.writes.push({
        method,
        path,
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'] ?? null,
      });
    if (path === '/services/parse-env') {
      const text = String(request.postDataJSON().text);
      return json(route, {
        data: {
          variables: text
            .split('\n')
            .filter(Boolean)
            .map((line, index) => ({
              name: line.split('=')[0],
              value: line.slice(line.indexOf('=') + 1),
              secret: false,
              line: index + 1,
            })),
          issues: [],
        },
      });
    }
    if (!current) throw new Error('Workspace fixture expected a declared service.');
    if (action === 'networking') {
      const data: ServiceNetworking = {
        serviceId: current.id,
        serviceRevision: current.revision,
        publishedConfigRevision: current.published?.configRevision ?? null,
        project: current.project,
        environment: current.environment,
        cluster: current.cluster,
        eligiblePorts: current.configuration.ports
          .filter((port) => port.protocol === 'http')
          .map((port, index) => ({
            ...port,
            protocol: 'http' as const,
            id: `72000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            publishedConfigRevision: current.published?.configRevision ?? 0,
          })),
        blockers: [],
        platformSettings: {
          revision: 1,
          appsDomainSuffix: 'example.test',
          acmeEmail: 'fixture@example.test',
          updatedAt: new Date().toISOString(),
        },
        clusterNetworking: {
          clusterId: current.clusterId,
          revision: 1,
          subdomain: 'workspace-fixture',
          entryAddresses: ['192.0.2.10'],
          cnameTarget: null,
          domainSuffix: 'workspace-fixture.example.test',
          ingressClassName: 'traefik',
          capabilities: null,
          capabilitiesStale: false,
          updatedAt: new Date().toISOString(),
        },
        domains: [],
      };
      return json(route, { data });
    }
    if (!action && method === 'PATCH') {
      const input = request.postDataJSON() as UpdateServiceInput;
      if (input.revision !== current.revision)
        return json(
          route,
          {
            status: 409,
            code: 'REVISION_CONFLICT',
            detail: '受控版本冲突。',
            requestId: 'workspace-fixture',
          },
          409,
        );
      const configuration = input.configuration;
      const nextConfiguration = configuration
        ? {
            ...current.configuration,
            ...configuration,
            environment: configuration.environment?.map((variable, index) =>
              variable.secret
                ? {
                    name: variable.name,
                    secretRefId: `73000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                    secretKey: 'value',
                  }
                : { ...variable },
            ),
          }
        : current.configuration;
      Object.assign(current, input, {
        revision: current.revision + 1,
        configRevision: current.configRevision + 1,
        hasUnpublishedChanges: true,
        configuration: nextConfiguration,
      });
      return json(route, { data: current });
    }
    await controls.beforeLogReply?.();
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `event: log\ndata: ${JSON.stringify({ text: 'workspace controlled log\n' })}\n\nevent: end\ndata: ${JSON.stringify({ reason: 'eof' })}\n\n`,
    });
  });
  return { ...state, service, controls, pathFor };
}

export async function installImageWorkspaceFixture(page: Page) {
  const state = await installS5Fixture(page);
  const extended = await extendWorkspaceFixture(page, state, 'image');
  return {
    ...extended,
    imageState: state,
    databaseServiceId: s5Ids.databaseService,
    volumeId: s5Ids.volume,
    databaseId: s5Ids.database,
  };
}

export async function installGitWorkspaceFixture(page: Page) {
  const state = await installS6Fixture(page);
  return { ...(await extendWorkspaceFixture(page, state, 'git')), gitState: state };
}
