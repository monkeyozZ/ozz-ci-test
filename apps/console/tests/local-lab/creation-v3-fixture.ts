import type { Page, Route } from '@playwright/test';
import { installS5Fixture } from './s5-fixture';
import {
  makeService,
  s5Ids,
  s5Project,
  s5Cluster,
  s5Environment,
  timestamp,
} from '../fixtures/s5-data';
import type { CreateServiceInput, Configuration } from '../../src/components/services/types';
import type { Project, Environment } from '../../src/lib/types';

const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
const list = (route: Route, data: unknown[]) =>
  json(route, { data, page: { hasMore: false, nextCursor: null } });

/** Extends the storage fixture; all requests stay in the browser, with no API or cluster writes. */
export async function installCreationFixture(page: Page) {
  const core = await installS5Fixture(page);
  const project: Project = {
    ...s5Project,
    clusterId: s5Ids.cluster,
    cluster: { ...s5Cluster, connectionStatus: 'connected', lastObservedAt: timestamp() },
    revision: 1,
    description: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
  const environment: Environment = {
    ...s5Environment,
    projectId: s5Ids.project,
    clusterId: s5Ids.cluster,
    isDefault: false,
    revision: 1,
    description: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
  const state = {
    core,
    imageReplyLoss: false,
    imageReplyDamage: '' as '' | 'json' | 'envelope' | 'service',
    projectReplyLoss: false,
    projectReplyDamage: false,
    beforeImageReply: undefined as undefined | (() => Promise<void>),
    beforeProjectReply: undefined as undefined | (() => Promise<void>),
    projects: [project],
    environments: [environment],
    environmentPageSize: 50,
  };
  const imageReceipts = new Map<
    string,
    { service: ReturnType<typeof makeService>; payload: string }
  >();
  const projectReceipts = new Map<string, Project>();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    const method = request.method();
    const body = method === 'GET' ? undefined : request.postDataJSON();
    const key = request.headers()['idempotency-key'] ?? null;
    if (path === '/services' && method === 'POST' && !body.template && !body.source) {
      core.writes.push({ path, method, body, key });
      if (core.restoreMode || !key) return json(route, { code: 'CONTROLLED_WRITE_BLOCKED' }, 503);
      const input = body as CreateServiceInput;
      let receipt = imageReceipts.get(key);
      if (receipt && receipt.payload !== JSON.stringify(input))
        return json(route, { code: 'IDEMPOTENCY_CONFLICT' }, 409);
      if (!receipt) {
        const service = makeService({
          id: s5Ids.createdService,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          revision: 1,
          configRevision: 1,
          published: null,
          remoteCreatedAt: null,
          lastSuccessfulDeploymentId: null,
          configurationState: 'unpublished',
          runtimeState: 'unpublished',
          hasUnpublishedChanges: true,
          configuration: input.configuration as Configuration,
        });
        receipt = { service, payload: JSON.stringify(input) };
        imageReceipts.set(key, receipt);
        core.services.push(service);
      }
      await state.beforeImageReply?.();
      if (state.imageReplyLoss) {
        state.imageReplyLoss = false;
        return route.abort('failed');
      }
      if (state.imageReplyDamage) {
        const damage = state.imageReplyDamage;
        state.imageReplyDamage = '';
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: damage === 'json' ? '{"data":' : damage === 'envelope' ? '{}' : '{"data":{}}',
        });
      }
      return json(route, { data: receipt.service }, 201);
    }
    if (path === '/projects' && method === 'POST') {
      core.writes.push({ path, method, body, key });
      if (!key || core.restoreMode) return json(route, { code: 'CONTROLLED_WRITE_BLOCKED' }, 503);
      let created = projectReceipts.get(key);
      if (!created) {
        created = { ...project, ...body, id: '51000000-0000-4000-8000-000000000040' };
        projectReceipts.set(key, created!);
        state.projects.push(created!);
        state.environments.push({
          ...environment,
          id: '51000000-0000-4000-8000-000000000041',
          name: 'Production',
          slug: 'production',
          projectId: created!.id,
          isDefault: true,
        });
      }
      await state.beforeProjectReply?.();
      if (state.projectReplyLoss) {
        state.projectReplyLoss = false;
        return route.abort('failed');
      }
      if (state.projectReplyDamage) {
        state.projectReplyDamage = false;
        return json(route, { data: {} }, 201);
      }
      return json(route, { data: created }, 201);
    }
    if (method === 'GET' && ['/projects', '/environments', '/services'].includes(path)) {
      core.reads.push({ path, query: Object.fromEntries(url.searchParams) });
      if (path === '/projects') return list(route, state.projects);
      if (path === '/services')
        return list(
          route,
          core.services.filter(
            (item) =>
              (!url.searchParams.get('projectId') ||
                item.projectId === url.searchParams.get('projectId')) &&
              (!url.searchParams.get('environmentId') ||
                item.environmentId === url.searchParams.get('environmentId')),
          ),
        );
      const matches = state.environments.filter(
        (item) =>
          !url.searchParams.get('projectId') ||
          item.projectId === url.searchParams.get('projectId'),
      );
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end = start + state.environmentPageSize;
      return json(route, {
        data: matches.slice(start, end),
        page: {
          hasMore: end < matches.length,
          nextCursor: end < matches.length ? String(end) : null,
        },
      });
    }
    if (method === 'GET' && path.startsWith('/projects/')) {
      const value = state.projects.find((item) => item.id === path.split('/')[2]);
      if (value) return json(route, { data: value });
    }
    if (
      method === 'GET' &&
      ['/integrations/github', '/integrations/builders', '/integrations/registries'].includes(path)
    )
      return list(route, []);
    await route.fallback();
  });
  return state;
}
