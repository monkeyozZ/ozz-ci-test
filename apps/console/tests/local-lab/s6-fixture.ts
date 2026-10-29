import type { Page, Route } from '@playwright/test';
import type { components } from '@ozz/api-client';
import type {
  BuildLogPage,
  GitPolicyUpdate,
  GitPreviewInput,
  GitSourceUpdate,
  WebhookDeliveryDetail,
  WebhookRejections,
} from '../../src/components/git/types';
import type { CreateServiceInput, DeploymentLogs } from '../../src/components/services/types';
import type { Operation, Session, WorkerStatus } from '../../src/lib/types';
import {
  makeBuilder,
  makeDelivery,
  makeGitDeployment,
  makeGitHubConnection,
  makeGitPreview,
  makeGitService,
  makeRegistry,
  makeRepository,
  makeTarget,
  s6Branches,
  s6Cluster,
  s6Environment,
  s6Ids,
  s6Project,
  s6Secrets,
  s6Time,
} from '../fixtures/s6-data';

type Schema = components['schemas'];
export { s6Ids };
export const s6ServicePath = (tab = 'overview') =>
  `/projects/${s6Ids.project}/services/${s6Ids.service}?environment=staging&tab=${tab}`;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const problem = (route: Route, status: number, detail: string, code = 'CONTROLLED_S6_REJECTION') =>
  json(route, { status, detail, code, requestId: 'controlled-s6-request' }, status);

/** All API traffic is intercepted. These scenarios never access the product API or a cluster. */
export async function installS6Fixture(page: Page) {
  const state = {
    source: 'controlled-interface-fixture; all API requests intercepted; no real resource writes',
    services: [makeGitService()],
    deployments: [makeGitDeployment()],
    operations: [] as Operation[],
    github: [makeGitHubConnection()],
    registries: [makeRegistry()],
    builders: [makeBuilder()],
    repositories: [
      makeRepository(),
      makeRepository({
        id: s6Ids.secondRepository,
        githubRepositoryId: '12346',
        fullName: 'fixture-team/second-application',
      }),
    ],
    branches: [...s6Branches],
    secrets: structuredClone(s6Secrets),
    targets: [
      makeTarget(),
      makeTarget({
        id: s6Ids.secondTarget,
        receiptSequence: '9007199254740994',
        state: 'orphaned',
        reason: 'service_deleted',
        currentServiceId: null,
        canPreview: false,
      }),
    ],
    deliveries: [makeDelivery()],
    preview: makeGitPreview(),
    rejections: {
      data: [],
      truncated: true,
      retentionHours: 24,
    } as WebhookRejections,
    logPages: [
      {
        runId: s6Ids.run,
        runNumber: 1,
        source: 'builder',
        available: true,
        unavailableReason: null,
        truncated: false,
        expiresAt: '2030-01-01T00:00:00.000Z',
        items: [
          {
            sequence: '9007199254740993',
            phase: 'building',
            timestamp: s6Time,
            content: 'large-sequence-second',
            truncated: false,
          },
          {
            sequence: '9007199254740992',
            phase: 'building',
            timestamp: s6Time,
            content: 'large-sequence-first',
            truncated: false,
          },
        ],
        pageInfo: { hasMore: true, nextCursor: 'fixture:1' },
      },
      {
        runId: s6Ids.run,
        runNumber: 1,
        source: 'builder',
        available: true,
        unavailableReason: null,
        truncated: true,
        expiresAt: '2030-01-01T00:00:00.000Z',
        items: [
          {
            sequence: '9007199254740994',
            phase: 'pushing',
            timestamp: s6Time,
            content: 'retained-registry-digest',
            truncated: true,
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    ] as BuildLogPage[],
    restoreMode: false,
    pageLimit: 1,
    failCreateReplyOnce: false,
    beforePreviewReply: undefined as undefined | ((input: GitPreviewInput) => Promise<void>),
    writes: [] as { method: string; path: string; body: unknown; key: string | null }[],
    reads: [] as { path: string; query: Record<string, string> }[],
    unexpected: [] as string[],
  };
  let operationSequence = 0;
  const creationKeys = new Map<string, string>();
  function operation(kind: Operation['kind'], input: Operation['input']): Operation {
    const id = `67000000-0000-4000-8000-${String(++operationSequence).padStart(12, '0')}`;
    const value: Operation = {
      id,
      kind,
      scope: kind === 'service_resume' ? 'service' : 'integration',
      serverId: null,
      clusterId: kind === 'service_resume' ? s6Ids.cluster : null,
      serviceId: kind === 'service_resume' ? s6Ids.service : null,
      status: 'queued',
      input,
      result: null,
      createdAt: s6Time,
      updatedAt: s6Time,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      retryOfId: null,
      cancelRequestedAt: null,
      pollUrl: '/api/operations/' + id,
    };
    state.operations.unshift(value);
    return value;
  }
  function list<T>(route: Route, values: T[], url: URL, limit = 50) {
    const start = Number(url.searchParams.get('cursor')?.split(':')[1] ?? 0);
    const size = Math.min(Number(url.searchParams.get('limit') ?? limit), limit);
    const next = start + size;
    return json(route, {
      data: values.slice(start, next),
      page: {
        hasMore: next < values.length,
        nextCursor: next < values.length ? `fixture:${next}` : null,
      },
    });
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    const method = request.method();
    const body = method === 'GET' ? undefined : request.postDataJSON();
    const key = request.headers()['idempotency-key'] ?? null;
    if (method === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    else state.writes.push({ method, path, body, key });
    if (path === '/auth/me') {
      const session: Session = {
        user: { id: '66000000-0000-4000-8000-000000000030', username: 'Git 界面契约测试' },
        csrfToken: 'controlled-s6-session',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        restoreMode: state.restoreMode,
      };
      return json(route, { data: session });
    }
    if (state.restoreMode && method !== 'GET')
      return problem(route, 503, '恢复核对期间只允许读取。', 'CONTROL_PLANE_READ_ONLY');
    if (path === '/operations/worker-status') {
      const value: WorkerStatus = {
        status: 'offline',
        restoreLocked: false,
        queue: 'unknown',
        queuedCount: state.operations.length,
        unpublishedCount: 0,
        oldestQueuedAt: null,
        workers: [],
      };
      return json(route, { data: value });
    }
    if (path === '/projects' && method === 'GET') return list(route, [s6Project], url);
    if (path === '/projects/' + s6Ids.project) return json(route, { data: s6Project });
    if (path === '/environments' && method === 'GET') return list(route, [s6Environment], url);
    if (path === '/clusters' && method === 'GET') return list(route, [s6Cluster], url);
    if (path === '/secrets' && method === 'GET')
      return list(
        route,
        state.secrets.filter(
          (item) => !url.searchParams.get('kind') || item.kind === url.searchParams.get('kind'),
        ),
        url,
      );
    if (path === '/operations' && method === 'GET') return list(route, state.operations, url);
    const operationMatch = path.match(/^\/operations\/([^/]+)(?:\/(logs))?$/);
    if (operationMatch && method === 'GET') {
      if (operationMatch[2]) {
        const logs: Schema['OperationLogsDto'] = {
          data: [],
          page: { hasMore: false, nextCursor: null },
          source: 'operation',
          available: false,
          unavailableReason: 'not_started',
          truncated: false,
        };
        return json(route, logs);
      }
      return json(route, { data: state.operations.find((item) => item.id === operationMatch[1]) });
    }
    const repositories = path.match(
      /^\/integrations\/github\/([^/]+)\/repositories(?:\/([^/]+)\/(branches|webhook))?$/,
    );
    if (repositories) {
      if (method === 'GET') {
        if (url.searchParams.has('limit')) {
          state.unexpected.push('GitHub pagination included the platform limit parameter');
          return problem(route, 400, 'GitHub 分页只接受 cursor。');
        }
        return repositories[3] === 'branches'
          ? list(route, state.branches, url, state.pageLimit)
          : list(route, state.repositories, url, state.pageLimit);
      }
      if (repositories[3] === 'webhook' && method === 'POST') {
        const input = body as Schema['RegisterWebhookDto'];
        const task = operation('github_webhook_register', {
          integrationId: repositories[2]!,
          revision: input.revision,
          action: 'register_webhook',
          hookSecretRefId: input.secretRefId,
          callbackUrl:
            'https://console.example.test/api/webhooks/github/' +
            repositories[2] +
            '/controlled-callback',
        });
        return json(route, { data: task }, 202);
      }
    }
    const integration = path.match(
      /^\/integrations\/(github|registries|builders)(?:\/([^/]+)(?:\/(verify))?)?$/,
    );
    if (integration) {
      const kind = integration[1] as 'github' | 'registries' | 'builders';
      const values = state[kind];
      const item = values.find((value) => value.id === integration[2]);
      if (method === 'GET')
        return item
          ? json(route, { data: item })
          : list<(typeof values)[number]>(route, values, url);
      if (method === 'PATCH' && item) {
        Object.assign(item, body, { revision: item.revision + 1 });
        return json(route, { data: item });
      }
      if (method === 'POST' && integration[3] === 'verify' && item) {
        if (kind === 'registries') {
          const task = operation('registry_validate', {
            integrationId: item.id,
            revision: item.revision,
            action: 'validate_registry',
            probeRepository: 'fixture-team/ozz-probe',
          });
          return json(route, { data: task }, 202);
        }
        return json(route, { data: item });
      }
    }
    if (path === '/services' && method === 'GET') return list(route, state.services, url);
    if (path === '/services' && method === 'POST') {
      const input = body as CreateServiceInput;
      let service = state.services.find((item) => item.id === creationKeys.get(key ?? ''));
      if (!service) {
        service = makeGitService({
          id: s6Ids.createdService,
          name: input.name,
          slug: input.slug,
          published: null,
          configurationState: 'unpublished',
          runtimeState: 'unpublished',
          desiredState: 'running',
          lastSuccessfulDeploymentId: null,
          remoteCreatedAt: null,
        });
        if (input.source?.kind === 'github' && service.source.kind === 'github') {
          const sourceInput = input.source;
          const repository = state.repositories.find(
            (item) => item.id === sourceInput.repositoryId,
          );
          Object.assign(service.source.currentRevision, {
            branchRef: input.source.branchRef,
            dockerfilePath: input.source.dockerfilePath,
            contextPath: input.source.contextPath,
            buildArgs: input.source.buildArgs ?? {},
            platforms: input.source.platforms,
            repository: {
              repositoryId: input.source.repositoryId,
              githubRepositoryId: repository?.githubRepositoryId ?? '12345',
              fullNameAtCapture: repository?.fullName ?? 'fixture-team/application',
            },
            destination: {
              registryConnectionId: input.source.registryConnectionId,
              authority: state.registries[0]!.authority,
              repository: state.registries[0]!.namespace + '/' + input.source.imageRepository,
            },
          });
          service.source.autoDeploy = input.source.autoDeploy ?? false;
        }
        state.services.push(service);
        creationKeys.set(key ?? '', service.id);
      }
      if (state.failCreateReplyOnce) {
        state.failCreateReplyOnce = false;
        return route.abort('failed');
      }
      return json(route, { data: service }, 201);
    }
    const serviceMatch = path.match(/^\/services\/([^/]+)(?:\/(.*))?$/);
    if (serviceMatch) {
      const service = state.services.find((item) => item.id === serviceMatch[1]);
      if (!service) return problem(route, 404, '受控服务不存在。');
      const action = serviceMatch[2];
      if ((!action || action === 'git-source') && method === 'GET')
        return json(route, { data: service });
      if (action === 'pending-commits' && method === 'GET')
        return list(route, state.targets, url, state.pageLimit);
      if (action === 'git-source/preview' && method === 'POST') {
        const input = body as GitPreviewInput;
        const preview = structuredClone(state.preview);
        if (input.selection.kind === 'commit') preview.source.commitSha = input.selection.commitSha;
        await state.beforePreviewReply?.(input);
        return json(route, { data: preview });
      }
      if (action === 'git-source' && method === 'PUT') {
        const input = body as GitSourceUpdate;
        if (input.revision !== service.revision)
          return problem(route, 409, '来源版本已更新。', 'REVISION_CONFLICT');
        if (service.source.kind === 'github') {
          Object.assign(service.source.currentRevision, {
            dockerfilePath: input.source.dockerfilePath,
            contextPath: input.source.contextPath,
            branchRef: input.source.branchRef,
            buildArgs: input.source.buildArgs ?? {},
            revision: service.source.currentRevision.revision + 1,
          });
        }
        service.revision++;
        return json(route, { data: service });
      }
      if (action === 'git-source/policy' && method === 'PATCH') {
        const input = body as GitPolicyUpdate;
        if (service.source.kind === 'github') {
          service.source.autoDeploy = input.autoDeploy;
          service.source.policyRevision++;
        }
        service.revision++;
        return json(route, { data: service });
      }
      if (action === 'deployments' && method === 'POST')
        return json(route, { data: state.deployments[0] }, 202);
      if (action === 'resume' && method === 'POST') {
        const task = operation('service_resume', {
          serviceId: service.id,
          mutationRevision: service.mutationRevision,
          snapshotId: service.published?.deploymentId ?? null,
          target: state.preview.target,
          volumeIds: [],
        });
        return json(route, { data: task }, 202);
      }
      if (['volume-mounts', 'database-bindings'].includes(action ?? '') && method === 'GET')
        return json(route, {
          data: [],
          serviceRevision: service.revision,
          configRevision: service.configRevision,
        });
    }
    if (path === '/deployments' && method === 'GET') return list(route, state.deployments, url);
    const deploymentMatch = path.match(
      /^\/deployments\/([^/]+)(?:\/(build-logs|logs|retry|cancel))?$/,
    );
    if (deploymentMatch) {
      const deployment = state.deployments.find((item) => item.id === deploymentMatch[1]);
      if (!deployment) return problem(route, 404, '受控部署不存在。');
      if (!deploymentMatch[2] && method === 'GET') return json(route, { data: deployment });
      if (deploymentMatch[2] === 'logs' && method === 'GET') {
        const logs: DeploymentLogs = {
          source: 'deployment',
          available: true,
          unavailableReason: null,
          truncated: false,
          data: [
            {
              sequence: 1,
              timestamp: s6Time,
              level: 'info',
              message: 'controlled-platform-deployment-log',
              attempt: 1,
            },
          ],
          page: { hasMore: false, nextCursor: null },
        };
        return json(route, logs);
      }
      if (deploymentMatch[2] === 'build-logs' && method === 'GET') {
        if (url.searchParams.get('runId') === s6Ids.secondRun) {
          const logs: BuildLogPage = {
            runId: s6Ids.secondRun,
            runNumber: 2,
            source: 'builder',
            available: false,
            unavailableReason: 'expired',
            truncated: false,
            expiresAt: s6Time,
            items: [],
            pageInfo: { hasMore: false, nextCursor: null },
          };
          return json(route, logs);
        }
        const index = Number(url.searchParams.get('cursor')?.split(':')[1] ?? 0);
        return json(route, state.logPages[Math.min(index, state.logPages.length - 1)]);
      }
      if (deploymentMatch[2] === 'retry' && method === 'POST')
        return json(route, { data: deployment }, 202);
      if (deploymentMatch[2] === 'cancel' && method === 'POST') {
        deployment.cancelRequestedAt = s6Time;
        return json(route, { data: deployment }, 202);
      }
    }
    if (path === '/webhook-deliveries' && method === 'GET')
      return list(route, state.deliveries, url, state.pageLimit);
    if (path === '/webhook-rejections' && method === 'GET') return json(route, state.rejections);
    const deliveryMatch = path.match(/^\/webhook-deliveries\/([^/]+)(?:\/(targets))?$/);
    if (deliveryMatch && method === 'GET') {
      if (deliveryMatch[2]) return list(route, state.targets, url, state.pageLimit);
      const value: WebhookDeliveryDetail = {
        ...state.deliveries[0]!,
        targets: [state.targets[0]!],
        targetsPage: { hasMore: true, nextCursor: 'fixture:1' },
      };
      return json(route, { data: value });
    }
    if (['/domains', '/volumes', '/databases', '/templates'].includes(path) && method === 'GET')
      return list(route, [], url);
    state.unexpected.push(method + ' ' + path);
    return problem(route, 501, '未声明的受控 S6 API 请求。');
  });
  return state;
}
