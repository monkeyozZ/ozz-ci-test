import { randomUUID } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login } from '../e2e/helpers';
import type { Project, Environment, Operation } from '../../src/lib/types';
import type { Service, DeploymentDetail } from '../../src/components/services/types';
import type {
  Template,
  TemplatePreview,
  Volume,
  VolumeCreateResult,
  VolumeMountCollection,
  Database,
  DatabaseBinding,
  DatabaseBindingCollection,
  DatabaseBindingPreview,
  ManualDataRecord,
  ClusterStorage,
} from '../../src/components/storage/types';

// Real browser requests only: no route interception, fetch replacement, Kubernetes writes,
// browser storage snapshots, or direct API mutations. All writes below use Console controls.
const scopePath = fileURLToPath(
  new URL('../../../../.local/local-lab/s5-real-ui-state.json', import.meta.url),
);
const mainStatePath = fileURLToPath(
  new URL('../../../../.local/local-lab/storage-product-state.json', import.meta.url),
);
const bindingStatePath = fileURLToPath(
  new URL('../../../../.local/local-lab/storage-bindings-state.json', import.meta.url),
);
const registeredPath = fileURLToPath(
  new URL('../../../../.local/local-lab/product-state.json', import.meta.url),
);
const origin = 'http://127.0.0.1:5173';
type Scope = {
  version: 1;
  runId: string;
  clusterId: string;
  projectSlug: string;
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  volumeId?: string;
  createVolumeOperationId?: string;
  nodeDeploymentId?: string;
  volumeDeploymentId?: string;
  redisServiceId?: string;
  redisDatabaseId?: string;
  redisDeploymentId?: string;
  bindingId?: string;
  bindingDeploymentId?: string;
  bindingDraftEvidence?: {
    publishedDeploymentId: string;
    podUids: string[];
    serviceRevision: number;
  };
  retainedFailedDeploymentIds?: string[];
  completed: string[];
};
type MainState = {
  version: 1;
  projects: Record<string, string>;
  environments: Record<string, string>;
  services: Record<string, string>;
  volumes: Record<string, string>;
  completed: Record<string, unknown>;
};
type Write = {
  method: string;
  path: string;
  status: number | null;
  origin: string | null;
  hasCsrfToken: boolean;
  hasIdempotencyKey: boolean;
};
async function readScope(): Promise<Scope> {
  const registered = JSON.parse(await readFile(registeredPath, 'utf8')) as {
    clusters: { b: string };
  };
  let scope: Scope;
  try {
    if (((await stat(scopePath)).mode & 0o077) !== 0)
      throw new Error('S5 UI state must use mode 0600.');
    scope = JSON.parse(await readFile(scopePath, 'utf8')) as Scope;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const runId = randomUUID();
    scope = {
      version: 1,
      runId,
      clusterId: registered.clusters.b,
      projectSlug: `s5-ui-${runId.slice(0, 8)}`,
      completed: [],
    };
    await saveScope(scope);
  }
  if (
    scope.version !== 1 ||
    scope.clusterId !== registered.clusters.b ||
    !/^s5-ui-[a-f0-9]{8}$/.test(scope.projectSlug)
  )
    throw new Error('S5 UI scope must identify the dedicated B project.');
  return scope;
}
async function saveScope(scope: Scope) {
  await writeFile(scopePath, JSON.stringify(scope, null, 2) + '\n', { mode: 0o600 });
}
async function authenticate(page: Page) {
  try {
    await login(page);
  } catch {
    await page.goto('about:blank').catch(() => undefined);
    throw new Error('S5 real login failed; credential-bearing details were not retained.');
  }
}
async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  if (response.status() !== 200) throw new Error(`S5 read ${path}: HTTP ${response.status()}`);
  return ((await response.json()) as { data: T }).data;
}
async function collection<T>(page: Page, path: string) {
  const response = await page.request.get(`/api${path}`);
  if (response.status() !== 200)
    throw new Error(`S5 collection ${path}: HTTP ${response.status()}`);
  return (await response.json()) as {
    data: T[];
    page: { hasMore: boolean; nextCursor: string | null };
  };
}
function location(service: Service, tab = 'overview') {
  return `/projects/${service.projectId}/services/${service.id}?environment=${service.environment.slug}&tab=${tab}`;
}
function monitor(page: Page) {
  const writes: Write[] = [];
  const requests = new Map<Request, Write>();
  const headers: Promise<void>[] = [];
  let pageErrors = 0;
  let headerErrors = 0;
  page.on('pageerror', () => pageErrors++);
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const row: Write = {
      method: request.method(),
      path,
      status: null,
      origin: null,
      hasCsrfToken: false,
      hasIdempotencyKey: false,
    };
    requests.set(request, row);
    writes.push(row);
    headers.push(
      Promise.all([
        request.headerValue('origin'),
        request.headerValue('x-csrf-token'),
        request.headerValue('idempotency-key'),
      ])
        .then(([sentOrigin, csrf, key]) => {
          row.origin = sentOrigin;
          row.hasCsrfToken = !!csrf;
          row.hasIdempotencyKey = !!key;
        })
        .catch(() => {
          headerErrors++;
        }),
    );
  });
  page.on('response', (response) => {
    const row = requests.get(response.request());
    if (row) row.status = response.status();
  });
  return {
    writes,
    async finish() {
      await Promise.all(headers);
      expect(pageErrors, 'actual Console pageerror count').toBe(0);
      expect(headerErrors, 'browser header reads').toBe(0);
      expect(writes.every((row) => row.origin === origin && row.hasCsrfToken)).toBe(true);
      return { pageErrors, headerErrors, writes };
    },
  };
}
async function accepted<T>(
  page: Page,
  path: string,
  method: 'POST' | 'PATCH',
  status: number,
  trigger: () => Promise<unknown>,
): Promise<T> {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === `/api${path}`,
    { timeout: 45_000 },
  );
  await trigger();
  const response = await pending;
  if (response.status() !== status) {
    const problem = (await response.json().catch(() => ({}))) as { code?: string };
    const code = problem.code && /^[A-Z0-9_]+$/.test(problem.code) ? problem.code : 'UNAVAILABLE';
    throw new Error(`S5 ${method} ${path}: HTTP ${response.status()}, ${code}`);
  }
  return ((await response.json()) as { data: T }).data;
}
async function task<T extends Operation | DeploymentDetail>(
  page: Page,
  kind: 'operations' | 'deployments',
  id: string,
): Promise<T> {
  let current: T | undefined;
  let previous = '';
  await expect
    .poll(
      async () => {
        current = await get<T>(page, `/${kind}/${id}`);
        const next = `${current.status}:${current.errorCode ?? ''}`;
        if (next !== previous) {
          previous = next;
          console.log(
            JSON.stringify({ task: id, status: current.status, code: current.errorCode }),
          );
        }
        return ['queued', 'running'].includes(current.status);
      },
      { timeout: 600_000, intervals: [1500, 3000, 5000], message: `actual ${kind} terminal state` },
    )
    .toBe(false);
  expect(current!.status, current!.errorCode ?? 'actual task result').toBe('succeeded');
  return current!;
}
async function ownedService(page: Page, scope: Scope) {
  if (!scope.serviceId || !scope.projectId || !scope.environmentId)
    throw new Error('S5 UI service scope is incomplete.');
  const service = await get<Service>(page, `/services/${scope.serviceId}`);
  expect({
    projectId: service.projectId,
    environmentId: service.environmentId,
    clusterId: service.clusterId,
    slug: service.slug,
  }).toEqual({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    clusterId: scope.clusterId,
    slug: 'ui-node',
  });
  return service;
}
function expectFixedRetrySnapshot(original: DeploymentDetail, retry: DeploymentDetail) {
  expect(retry.retryOfId).toBe(original.id);
  expect(retry.snapshot).toEqual({
    ...original.snapshot,
    deployAndStart: retry.snapshot.deployAndStart,
    allowConfigurationRepair: retry.snapshot.allowConfigurationRepair,
  });
}
async function retryOwnedDeployment(page: Page, scope: Scope, id: string) {
  const original = await get<DeploymentDetail>(page, `/deployments/${id}`);
  expect(original.serviceId).toBe(scope.serviceId);
  if (original.retryOfId && scope.retainedFailedDeploymentIds?.includes(original.retryOfId)) {
    const source = await get<DeploymentDetail>(page, `/deployments/${original.retryOfId}`);
    expect(source.serviceId).toBe(scope.serviceId);
    expectFixedRetrySnapshot(source, original);
  }
  if (
    !['failed', 'cancelled'].includes(original.status) ||
    process.env.S5_REAL_RETRY_DEPLOYMENT_ID !== original.id
  ) {
    return id;
  }
  const service = await ownedService(page, scope);
  expect(original.serviceId).toBe(service.id);
  expect(service.activeTask).toBeNull();
  await page.goto(`/deployments/${original.id}`);
  await page.getByRole('button', { name: '审阅原部署重试', exact: true }).click();
  const review = page.locator('[data-deployment-review]');
  await expect(review).toContainText('固定原快照');
  const confirmations = { deployAndStart: false, allowConfigurationRepair: false };
  for (const [field, name] of [
    ['deployAndStart', '发布并启动这个已停止的服务'],
    ['allowConfigurationRepair', '按此完整配置修复当前不一致状态'],
  ] as const) {
    const confirmation = review.getByRole('checkbox', { name });
    if (await confirmation.count()) {
      await confirmation.check();
      confirmations[field] = true;
    }
  }
  const retry = await accepted<DeploymentDetail>(
    page,
    `/deployments/${original.id}/retry`,
    'POST',
    202,
    () => review.getByRole('button', { name: '确认创建重试部署', exact: true }).click(),
  );
  scope.retainedFailedDeploymentIds = [
    ...new Set([...(scope.retainedFailedDeploymentIds ?? []), original.id]),
  ];
  if (scope.nodeDeploymentId === original.id) scope.nodeDeploymentId = retry.id;
  if (scope.volumeDeploymentId === original.id) scope.volumeDeploymentId = retry.id;
  if (scope.bindingDeploymentId === original.id) scope.bindingDeploymentId = retry.id;
  await saveScope(scope);
  expect(retry.snapshot.deployAndStart).toBe(confirmations.deployAndStart);
  expect(retry.snapshot.allowConfigurationRepair).toBe(confirmations.allowConfigurationRepair);
  expectFixedRetrySnapshot(original, retry);
  return retry.id;
}
async function expectProtectionLabels(page: Page) {
  await expect(page.locator('[data-database-protected-fields] > li')).toHaveText([
    '镜像版本',
    '副本数',
    '启动命令',
    '启动参数',
    '端口',
    '环境变量',
    '数据卷挂载',
    '数据库凭证',
  ]);
}
async function expectVisibleStorageTab(page: Page) {
  const navigation = page.getByRole('navigation', { name: '服务页面', exact: true });
  const storageTab = navigation.getByRole('link', { name: '数据与存储', exact: true });
  await expect(storageTab).toBeInViewport({ ratio: 1 });
  const overviewTab = navigation.getByRole('link', { name: '概览', exact: true });
  await overviewTab.click();
  await expect(overviewTab).toHaveAttribute('aria-current', 'page');
  await overviewTab.focus();
  const scrollY = await page.evaluate(() => window.scrollY);
  await storageTab.dispatchEvent('click');
  await expect(page).toHaveURL(/tab=storage$/);
  await expect(storageTab).toBeInViewport({ ratio: 1 });
  await expect(overviewTab).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
}
async function sample(page: Page, info: TestInfo, name: string) {
  await expect(page.getByRole('status', { name: '正在载入', exact: true })).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const violations = axe.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.length,
  }));
  expect(violations).toEqual([]);
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await chmod(path, 0o600);
  await info.attach(name, { path, contentType: 'image/png' });
  return { name, violations, overflow };
}
async function report(info: TestInfo, name: string, body: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(
    path,
    JSON.stringify(
      {
        source:
          'Actual current Console → authenticated API / Worker → retained local ARM64 K3s; no API fixture or request interception',
        nativeCloudAcceptance: false,
        ...(body as object),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await info.attach(name, { path, contentType: 'application/json' });
}

test('真实 S5 独立 Node 模板：浏览器创建项目、保存草稿并发布', async ({ page }, info) => {
  const scope = await readScope();
  await authenticate(page);
  const observed = monitor(page);
  if (!scope.projectId) {
    const existing = await collection<Project>(
      page,
      `/projects?search=${encodeURIComponent(scope.projectSlug)}&limit=100`,
    );
    const exact = existing.data.filter(
      (item) => item.slug === scope.projectSlug && item.clusterId === scope.clusterId,
    );
    expect(exact.length).toBeLessThanOrEqual(1);
    if (exact[0]) scope.projectId = exact[0].id;
    else {
      await page.goto(`/projects/new?clusterId=${scope.clusterId}`);
      await page.getByLabel('项目名称', { exact: true }).fill(`S5 UI ${scope.runId.slice(0, 8)}`);
      await page.getByLabel('项目标识', { exact: true }).fill(scope.projectSlug);
      const project = await accepted<Project>(page, '/projects', 'POST', 201, () =>
        page.getByRole('button', { name: '创建项目', exact: true }).click(),
      );
      expect(project.clusterId).toBe(scope.clusterId);
      scope.projectId = project.id;
    }
    await saveScope(scope);
  }
  if (!scope.environmentId) {
    const environments = await collection<Environment>(
      page,
      `/environments?projectId=${scope.projectId}&limit=100`,
    );
    const production = environments.data.find((item) => item.slug === 'production');
    expect(production).toBeTruthy();
    scope.environmentId = production!.id;
    await saveScope(scope);
  }
  if (!scope.serviceId) {
    const existing = await collection<Service>(
      page,
      `/services?projectId=${scope.projectId}&search=ui-node&limit=100`,
    );
    const exact = existing.data.filter((item) => item.slug === 'ui-node');
    expect(exact.length).toBeLessThanOrEqual(1);
    if (exact[0]) scope.serviceId = exact[0].id;
    else {
      const template = await get<Template>(page, '/templates/node-example');
      await page.goto(`/projects/${scope.projectId}/services/new?environment=production`);
      await page.getByRole('link', { name: `使用 ${template.name} 模板`, exact: true }).click();
      await page.getByLabel('服务名称', { exact: true }).fill('S5 UI Node');
      await page.getByLabel('服务标识', { exact: true }).fill('ui-node');
      const preview = await accepted<TemplatePreview>(
        page,
        '/templates/node-example/preview',
        'POST',
        200,
        () => page.getByRole('button', { name: '预览生成配置', exact: true }).click(),
      );
      expect(preview.environmentId).toBe(scope.environmentId);
      expect(preview.clusterId).toBe(scope.clusterId);
      const service = await accepted<Service>(page, '/services', 'POST', 201, () =>
        page.getByRole('button', { name: '保存并预览发布', exact: true }).click(),
      );
      expect(service.template).toEqual({ id: template.id, version: template.version });
      expect(service.published).toBeNull();
      scope.serviceId = service.id;
    }
    await saveScope(scope);
  }
  let service = await ownedService(page, scope);
  if (!scope.nodeDeploymentId) {
    if (
      service.configuration.resources.requests.memoryMiB !== 32 ||
      service.configuration.resources.limits.memoryMiB !== 128
    ) {
      await page.goto(location(service, 'configuration'));
      await page.getByRole('button', { name: '启动与资源', exact: true }).click();
      await page.getByLabel('每副本 CPU（mCPU）', { exact: true }).first().fill('25');
      await page.getByLabel('每副本 CPU（mCPU）', { exact: true }).last().fill('250');
      await page.getByLabel('每副本内存（MiB）', { exact: true }).first().fill('32');
      await page.getByLabel('每副本内存（MiB）', { exact: true }).last().fill('128');
      service = await accepted<Service>(page, `/services/${service.id}`, 'PATCH', 200, () =>
        page.getByRole('button', { name: '保存草稿', exact: true }).click(),
      );
    }
    await page.goto(location(service, 'review'));
    const review = page.locator('[data-deployment-review]');
    await expect(review.getByRole('button', { name: '确认发布', exact: true })).toBeEnabled();
    const deployment = await accepted<DeploymentDetail>(
      page,
      `/services/${service.id}/deployments`,
      'POST',
      202,
      () => review.getByRole('button', { name: '确认发布', exact: true }).click(),
    );
    scope.nodeDeploymentId = deployment.id;
    await saveScope(scope);
  }
  scope.nodeDeploymentId = await retryOwnedDeployment(page, scope, scope.nodeDeploymentId);
  await saveScope(scope);
  const deployment = await task<DeploymentDetail>(page, 'deployments', scope.nodeDeploymentId);
  expect(deployment.snapshot.version).toBe(2);
  expect(deployment.snapshot.template?.id).toBe('node-example');
  await expect
    .poll(
      async () => {
        service = await ownedService(page, scope);
        return { runtime: service.runtimeState, deployed: service.published?.deploymentId };
      },
      { timeout: 120_000, intervals: [2000, 4000] },
    )
    .toEqual({
      runtime: 'running',
      deployed: scope.completed.includes('database-binding')
        ? scope.bindingDeploymentId
        : scope.completed.includes('volume')
          ? scope.volumeDeploymentId
          : deployment.id,
    });
  await page.goto(location(service));
  await expect(page.locator('[data-service-runtime] [data-workload-controller]')).toContainText(
    'Deployment',
  );
  const screen = await sample(page, info, 'real-ui-node-running-1440');
  scope.completed = [...new Set([...scope.completed, 'node'])];
  await saveScope(scope);
  const network = await observed.finish();
  expect(
    network.writes.every((row) =>
      [
        '/api/projects',
        '/api/templates/node-example/preview',
        '/api/services',
        `/api/services/${service.id}`,
        `/api/services/${service.id}/deployments`,
        ...(scope.retainedFailedDeploymentIds ?? []).map((id) => `/api/deployments/${id}/retry`),
      ].includes(row.path),
    ),
  ).toBe(true);
  expect(
    network.writes
      .filter((row) =>
        [
          '/api/projects',
          '/api/services',
          `/api/services/${service.id}/deployments`,
          ...(scope.retainedFailedDeploymentIds ?? []).map((id) => `/api/deployments/${id}/retry`),
        ].includes(row.path),
      )
      .every((row) => row.hasIdempotencyKey),
  ).toBe(true);
  await report(info, 'real-node-template', {
    passed: true,
    scope,
    service: {
      id: service.id,
      runtimeState: service.runtimeState,
      resources: service.configuration.resources,
    },
    deployment: {
      id: deployment.id,
      status: deployment.status,
      snapshotVersion: deployment.snapshot.version,
      template: deployment.snapshot.template,
      controller: deployment.snapshot.controller,
    },
    screen,
    ...network,
  });
});

test('真实 S5 独立卷：PVC创建、WFFC、挂载草稿和固定快照发布', async ({ page }, info) => {
  const scope = await readScope();
  expect(scope.completed).toContain('node');
  await authenticate(page);
  const observed = monitor(page);
  let service = await ownedService(page, scope);
  const storage = await get<ClusterStorage>(page, `/clusters/${scope.clusterId}/storage`);
  expect(storage.stale).toBe(false);
  expect(storage.capabilities?.provisioner.state).toBe('ready');
  expect(storage.capabilities?.permissions).toBe('ready');
  expect(storage.storageClasses.some((item) => item.name === 'local-path' && item.supported)).toBe(
    true,
  );
  if (!scope.volumeId) {
    const existing = await collection<Volume>(
      page,
      `/volumes?projectId=${scope.projectId}&search=ui-data&limit=100`,
    );
    const exact = existing.data.filter((item) => item.slug === 'ui-data');
    expect(exact.length).toBeLessThanOrEqual(1);
    if (exact[0]) scope.volumeId = exact[0].id;
    else {
      await page.goto(
        `/volumes/new?projectId=${scope.projectId}&environmentId=${scope.environmentId}&serviceId=${service.id}`,
      );
      await page.getByLabel('卷名称', { exact: true }).fill('S5 UI data');
      await page.getByLabel('卷标识', { exact: true }).fill('ui-data');
      const created = await accepted<VolumeCreateResult>(page, '/volumes', 'POST', 202, () =>
        page.getByRole('button', { name: '创建卷并查看任务', exact: true }).click(),
      );
      scope.volumeId = created.volumeId;
      scope.createVolumeOperationId = created.operation.id;
    }
    await saveScope(scope);
  }
  if (scope.createVolumeOperationId)
    await task<Operation>(page, 'operations', scope.createVolumeOperationId);
  let volume = await get<Volume>(page, `/volumes/${scope.volumeId}`);
  expect({
    projectId: volume.project?.id,
    environmentId: volume.environment?.id,
    clusterId: volume.cluster?.id,
  }).toEqual({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    clusterId: scope.clusterId,
  });
  const pvcUid = volume.pvc.uid;
  expect(pvcUid).toBeTruthy();
  const initialPhase = volume.pvc.phase;
  if (!scope.volumeDeploymentId) {
    const mountsResponse = await page.request.get(`/api/services/${service.id}/volume-mounts`);
    expect(mountsResponse.status()).toBe(200);
    const mounts = (await mountsResponse.json()) as VolumeMountCollection;
    if (!mounts.data.some((item) => item.volumeId === volume.id && item.desired)) {
      await page.goto(`${location(service, 'storage')}&volumeId=${volume.id}`);
      const panel = page.locator('[data-service-volume-mounts]');
      await panel.getByLabel('容器挂载路径', { exact: true }).fill('/data');
      const response = page.waitForResponse(
        (value) =>
          value.request().method() === 'POST' &&
          new URL(value.url()).pathname === `/api/services/${service.id}/volume-mounts`,
      );
      await panel.getByRole('button', { name: '保存挂载草稿', exact: true }).click();
      expect((await response).status()).toBe(200);
      await expect(panel.locator('.mount-list')).toContainText('/data');
    }
    service = await ownedService(page, scope);
    expect(service.controller).toEqual({ kind: 'Deployment', strategy: 'Recreate' });
    await page.goto(location(service, 'review'));
    const review = page.locator('[data-deployment-review]');
    await expect(review).toContainText('S5 UI data');
    await expect(review).toContainText('/data');
    await expect(review).toContainText('Recreate');
    const deployment = await accepted<DeploymentDetail>(
      page,
      `/services/${service.id}/deployments`,
      'POST',
      202,
      () => review.getByRole('button', { name: '确认发布', exact: true }).click(),
    );
    scope.volumeDeploymentId = deployment.id;
    await saveScope(scope);
  }
  scope.volumeDeploymentId = await retryOwnedDeployment(page, scope, scope.volumeDeploymentId);
  await saveScope(scope);
  const deployment = await task<DeploymentDetail>(page, 'deployments', scope.volumeDeploymentId);
  expect(deployment.snapshot.volumes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ volumeId: volume.id, pvcUid, mountPath: '/data', readOnly: false }),
    ]),
  );
  await expect
    .poll(
      async () => {
        volume = await get<Volume>(page, `/volumes/${scope.volumeId}`);
        return {
          phase: volume.pvc.phase,
          uid: volume.pvc.uid,
          actualMount: volume.mounts.actual.some((item) => item.serviceId === service.id),
        };
      },
      { timeout: 180_000, intervals: [2000, 4000] },
    )
    .toEqual({ phase: 'Bound', uid: pvcUid, actualMount: true });
  await page.goto(`/volumes/${volume.id}`);
  await expect(page.locator('[data-volume-observations]')).toContainText('Bound');
  const screen = await sample(page, info, 'real-ui-volume-bound-1440');
  await page.goto(`/deployments/${deployment.id}`);
  await expect(page.locator('[data-deployment-storage-snapshot]')).toContainText(pvcUid!);
  await expect(page.locator('[data-deployment-stages] .deployment-stages > li strong')).toHaveText([
    '持久受理',
    '解析镜像',
    '准备存储',
    '应用配置',
    '等待健康检查',
  ]);
  scope.completed = [...new Set([...scope.completed, 'volume'])];
  await saveScope(scope);
  const network = await observed.finish();
  expect(
    network.writes.every((row) =>
      [
        '/api/volumes',
        `/api/services/${service.id}/volume-mounts`,
        `/api/services/${service.id}/deployments`,
        ...(scope.retainedFailedDeploymentIds ?? []).map((id) => `/api/deployments/${id}/retry`),
      ].includes(row.path),
    ),
  ).toBe(true);
  expect(
    network.writes
      .filter((row) => row.path.endsWith('/retry'))
      .every((row) => row.hasIdempotencyKey),
  ).toBe(true);
  await report(info, 'real-volume-publication', {
    passed: true,
    scope,
    initialPvcPhase: initialPhase,
    finalPvcPhase: volume.pvc.phase,
    pvcUid,
    volumeId: volume.id,
    deploymentId: deployment.id,
    retryOfId: deployment.retryOfId,
    allowConfigurationRepair: deployment.snapshot.allowConfigurationRepair,
    snapshotVolumeCount: deployment.snapshot.volumes?.length,
    actualMounts: volume.mounts.actual.length,
    screen,
    ...network,
  });
});

test('真实 S5 独立 Redis 模板与连接：浏览器创建数据库并发布应用引用', async ({ page }, info) => {
  const scope = await readScope();
  expect(scope.completed).toContain('volume');
  await authenticate(page);
  const observed = monitor(page);
  const screens: Awaited<ReturnType<typeof sample>>[] = [];
  let node = await ownedService(page, scope);
  const originalVolumeDeployment = await get<DeploymentDetail>(
    page,
    `/deployments/${scope.volumeDeploymentId}`,
  );
  const originalVolume = originalVolumeDeployment.snapshot.volumes?.find(
    (item) => item.volumeId === scope.volumeId,
  );
  expect(originalVolume?.pvcUid).toBeTruthy();
  if (!scope.redisServiceId) {
    const existing = await collection<Service>(
      page,
      `/services?projectId=${scope.projectId}&search=ui-redis&limit=100`,
    );
    const exact = existing.data.filter((item) => item.slug === 'ui-redis');
    expect(exact.length).toBeLessThanOrEqual(1);
    if (exact[0]) scope.redisServiceId = exact[0].id;
    else {
      await page.goto(`/projects/${scope.projectId}/services/new?environment=production`);
      await page.getByRole('link', { name: '使用 Redis 模板', exact: true }).click();
      await page.getByLabel('服务名称', { exact: true }).fill('S5 UI Redis');
      await page.getByLabel('服务标识', { exact: true }).fill('ui-redis');
      const preview = await accepted<TemplatePreview>(
        page,
        '/templates/redis/preview',
        'POST',
        200,
        () => page.getByRole('button', { name: '预览生成配置', exact: true }).click(),
      );
      expect(preview.environmentId).toBe(scope.environmentId);
      expect(preview.clusterId).toBe(scope.clusterId);
      const created = await accepted<Service>(page, '/services', 'POST', 201, () =>
        page.getByRole('button', { name: '保存并预览发布', exact: true }).click(),
      );
      expect(created.published).toBeNull();
      scope.redisServiceId = created.id;
      await saveScope(scope);
    }
  }
  let redis = await get<Service>(page, `/services/${scope.redisServiceId}`);
  expect({
    projectId: redis.projectId,
    environmentId: redis.environmentId,
    clusterId: redis.clusterId,
    slug: redis.slug,
    templateId: redis.template?.id,
  }).toEqual({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    clusterId: scope.clusterId,
    slug: 'ui-redis',
    templateId: 'redis',
  });
  expect(redis.databaseInstanceId).toBeTruthy();
  scope.redisDatabaseId = redis.databaseInstanceId!;
  await saveScope(scope);
  if (!scope.redisDeploymentId) {
    if (redis.configuration.resources.limits.memoryMiB !== 128) {
      await page.goto(location(redis, 'configuration'));
      await page.getByRole('button', { name: '启动与资源', exact: true }).click();
      await page.getByLabel('每副本 CPU（mCPU）', { exact: true }).first().fill('50');
      await page.getByLabel('每副本 CPU（mCPU）', { exact: true }).last().fill('500');
      await page.getByLabel('每副本内存（MiB）', { exact: true }).first().fill('64');
      await page.getByLabel('每副本内存（MiB）', { exact: true }).last().fill('128');
      redis = await accepted<Service>(page, `/services/${redis.id}`, 'PATCH', 200, () =>
        page.getByRole('button', { name: '保存草稿', exact: true }).click(),
      );
    }
    await page.goto(location(redis, 'review'));
    const review = page.locator('[data-deployment-review]');
    await expect(review).toContainText('StatefulSet');
    const deployment = await accepted<DeploymentDetail>(
      page,
      `/services/${redis.id}/deployments`,
      'POST',
      202,
      () => review.getByRole('button', { name: '确认发布', exact: true }).click(),
    );
    scope.redisDeploymentId = deployment.id;
    await saveScope(scope);
  }
  const redisDeployment = await task<DeploymentDetail>(
    page,
    'deployments',
    scope.redisDeploymentId,
  );
  expect(redisDeployment.snapshot.database?.databaseInstanceId).toBe(scope.redisDatabaseId);
  let database = await get<Database>(page, `/databases/${scope.redisDatabaseId}`);
  await expect
    .poll(
      async () => {
        database = await get<Database>(page, `/databases/${scope.redisDatabaseId}`);
        return database.databaseReady;
      },
      { timeout: 120_000, intervals: [2000, 4000] },
    )
    .toBe(true);
  expect(database.protection.active).toBe(true);
  expect(database.initialization.pvcUid).toBe(database.dataVolume.pvcUid);
  await page.goto(`/databases/${database.id}`);
  await expectProtectionLabels(page);
  screens.push(await sample(page, info, 'real-ui-redis-ready-1440'));

  if (!scope.bindingDeploymentId) {
    node = await ownedService(page, scope);
    expect(node.activeTask).toBeNull();
    expect(node.published).toBeTruthy();
    const publishedDeploymentId = node.published!.deploymentId;
    const podUids = node
      .observation!.pods.filter((pod) => pod.ready && !pod.deletionTimestamp)
      .map((pod) => pod.uid)
      .sort();
    expect(podUids).toHaveLength(1);
    const response = await page.request.get(`/api/services/${node.id}/database-bindings`);
    expect(response.status()).toBe(200);
    const bindings = (await response.json()) as DatabaseBindingCollection;
    let binding = bindings.data.find(
      (item) => item.databaseInstanceId === database.id && item.desired,
    );
    if (!binding) {
      await page.goto(`${location(node, 'storage')}&databaseId=${database.id}`);
      const panel = page.locator('[data-service-database-bindings]');
      await panel.getByLabel('数据库', { exact: true }).selectOption(database.id);
      await panel.getByLabel('注入方式', { exact: true }).selectOption('url');
      await panel
        .getByLabel('完整连接 URI（秘密引用） → 环境变量', { exact: true })
        .fill('S5_REDIS_URL');
      const preview = await accepted<DatabaseBindingPreview>(
        page,
        `/services/${node.id}/database-bindings/preview`,
        'POST',
        200,
        () => panel.getByRole('button', { name: '预览连接变更', exact: true }).click(),
      );
      expect(
        preview.variables.some((variable) => variable.name === 'S5_REDIS_URL' && variable.secret),
      ).toBe(true);
      const saved = await accepted<DatabaseBinding[]>(
        page,
        `/services/${node.id}/database-bindings`,
        'POST',
        200,
        () => panel.getByRole('button', { name: '保存连接草稿', exact: true }).click(),
      );
      binding = saved.find((item) => item.databaseInstanceId === database.id && item.desired);
    }
    expect(binding).toBeTruthy();
    expect(binding!.mapping).toEqual({ url: 'S5_REDIS_URL' });
    expect(binding!.published).toBe(false);
    scope.bindingId = binding!.id;
    await saveScope(scope);
    node = await ownedService(page, scope);
    expect(node.activeTask).toBeNull();
    expect(node.published!.deploymentId).toBe(publishedDeploymentId);
    expect(
      node
        .observation!.pods.filter((pod) => pod.ready && !pod.deletionTimestamp)
        .map((pod) => pod.uid)
        .sort(),
    ).toEqual(podUids);
    scope.bindingDraftEvidence = { publishedDeploymentId, podUids, serviceRevision: node.revision };
    await saveScope(scope);
    await page.goto(location(node, 'review'));
    const review = page.locator('[data-deployment-review]');
    await expect(review).toContainText('S5 UI Redis');
    await expect(review).toContainText('/data');
    const deployment = await accepted<DeploymentDetail>(
      page,
      `/services/${node.id}/deployments`,
      'POST',
      202,
      () => review.getByRole('button', { name: '确认发布', exact: true }).click(),
    );
    scope.bindingDeploymentId = deployment.id;
    await saveScope(scope);
  }
  const deployment = await task<DeploymentDetail>(page, 'deployments', scope.bindingDeploymentId);
  expect(deployment.snapshot.databaseBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        bindingId: scope.bindingId,
        databaseInstanceId: database.id,
        mapping: { url: 'S5_REDIS_URL' },
      }),
    ]),
  );
  expect(deployment.snapshot.volumes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        volumeId: originalVolume!.volumeId,
        pvcUid: originalVolume!.pvcUid,
        mountPath: originalVolume!.mountPath,
        readOnly: originalVolume!.readOnly,
      }),
    ]),
  );
  await expect
    .poll(
      async () => {
        node = await ownedService(page, scope);
        return { runtime: node.runtimeState, deploymentId: node.published?.deploymentId };
      },
      { timeout: 120_000, intervals: [2000, 4000] },
    )
    .toEqual({ runtime: 'running', deploymentId: deployment.id });
  const volume = await get<Volume>(page, `/volumes/${scope.volumeId}`);
  expect(volume.pvc.uid).toBe(originalVolume!.pvcUid);
  expect(scope.bindingDraftEvidence).toBeTruthy();
  expect(
    node
      .observation!.pods.filter((pod) => pod.ready && !pod.deletionTimestamp)
      .every((pod) => !scope.bindingDraftEvidence!.podUids.includes(pod.uid)),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await page.goto(location(node, 'storage'));
  await expectVisibleStorageTab(page);
  const row = page.locator('[data-service-database-bindings] .binding-list > li').filter({
    has: page.locator(`a[href="/databases/${database.id}"]`),
  });
  await expect(row).toContainText('已发布引用');
  await expect(row).toContainText('S5_REDIS_URL');
  screens.push(await sample(page, info, 'real-ui-node-redis-binding-390-dark'));
  scope.completed = [...new Set([...scope.completed, 'database-binding'])];
  await saveScope(scope);
  const network = await observed.finish();
  const allowedPaths = [
    '/api/templates/redis/preview',
    '/api/services',
    `/api/services/${redis.id}`,
    `/api/services/${redis.id}/deployments`,
    `/api/services/${node.id}/database-bindings/preview`,
    `/api/services/${node.id}/database-bindings`,
    `/api/services/${node.id}/deployments`,
  ];
  expect(network.writes.every((write) => allowedPaths.includes(write.path))).toBe(true);
  expect(
    network.writes
      .filter((write) => write.path === '/api/services' || write.path.endsWith('/deployments'))
      .every((write) => write.hasIdempotencyKey),
  ).toBe(true);
  await report(info, 'real-ui-database-binding', {
    passed: true,
    scope,
    database: {
      id: database.id,
      serviceId: redis.id,
      ready: database.databaseReady,
      volumeId: database.dataVolume.id,
      pvcUid: database.dataVolume.pvcUid,
      deploymentId: redisDeployment.id,
    },
    application: {
      serviceId: node.id,
      deploymentId: deployment.id,
      bindingId: scope.bindingId,
      preservedVolumeId: volume.id,
      preservedPvcUid: volume.pvc.uid,
    },
    draftDidNotHotUpdate: scope.bindingDraftEvidence,
    screens,
    ...network,
  });
});

test('真实 S5 主数据只读：数据库保护、StatefulSet 与卷挂载', async ({ page }, info) => {
  const main = JSON.parse(await readFile(mainStatePath, 'utf8')) as MainState;
  if (
    main.version !== 1 ||
    !main.services.postgresql ||
    !main.services.redis ||
    !main.services.files
  )
    throw new Error('Main S5 source resources are not prepared yet.');
  await authenticate(page);
  const observed = monitor(page);
  const screens: Awaited<ReturnType<typeof sample>>[] = [];
  const databases: Array<{
    id: string;
    serviceId: string;
    volumeId: string;
    pvcUid: string | null;
    engine: string;
    ready: boolean;
    controller: string | undefined;
    protected: boolean;
  }> = [];
  for (const engine of ['postgresql', 'redis']) {
    const service = await get<Service>(page, `/services/${main.services[engine]}`);
    expect(service.databaseInstanceId).toBeTruthy();
    const database = await get<Database>(page, `/databases/${service.databaseInstanceId}`);
    expect(database.engine).toBe(engine);
    expect(database.databaseReady).toBe(true);
    expect(database.protection.active).toBe(true);
    const volume = await get<Volume>(page, `/volumes/${database.dataVolume.id}`);
    expect(database.initialization.pvcUid).toBe(volume.pvc.uid);
    expect(service.observation?.controller?.kind).toBe('StatefulSet');
    expect(service.observation?.deployment).toBeNull();
    await page.goto(`/databases/${database.id}`);
    await expect(page.locator('[data-database-identity]')).toContainText('认证检查通过');
    await expect(page.locator('[data-database-identity]')).toContainText('数据身份保护已生效');
    screens.push(await sample(page, info, `real-${engine}-database-1440`));
    await page.goto(location(service));
    await expect(page.locator('[data-workload-controller]')).toContainText('StatefulSet');
    await page
      .locator('[data-service-runtime]')
      .getByText('实例身份', { exact: true })
      .first()
      .click();
    await expect(page.locator('[data-service-runtime]')).toContainText('StatefulSet /');
    await page.goto(location(service, 'configuration'));
    await expect(page.locator('[data-database-config-protection]')).toBeVisible();
    await expect(page.getByLabel('镜像地址', { exact: true })).toHaveAttribute('readonly', '');
    if (service.published) {
      const deployment = await get<DeploymentDetail>(
        page,
        `/deployments/${service.published.deploymentId}`,
      );
      expect(deployment.snapshot.database?.databaseInstanceId).toBe(database.id);
      await page.goto(`/deployments/${deployment.id}`);
      await expect(page.locator('[data-deployment-storage-snapshot]')).toContainText(database.id);
      await expect(page.locator('[data-deployment-storage-snapshot]')).toContainText(volume.id);
      await expect(
        page.locator('[data-deployment-stages] .deployment-stages > li strong'),
      ).toHaveText([
        '持久受理',
        '解析镜像',
        '准备存储',
        '应用配置',
        '等待健康检查',
        '验证数据库连接',
      ]);
    }
    databases.push({
      id: database.id,
      serviceId: service.id,
      volumeId: volume.id,
      pvcUid: volume.pvc.uid,
      engine,
      ready: database.databaseReady,
      controller: service.observation?.controller?.kind,
      protected: database.protection.active,
    });
  }
  const files = await get<Service>(page, `/services/${main.services.files}`);
  await page.goto(location(files, 'storage'));
  await expect(page.locator('[data-service-volume-mounts] .mount-list')).toContainText('/data');
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  screens.push(await sample(page, info, 'real-service-data-390-dark'));
  const network = await observed.finish();
  expect(network.writes).toEqual([]);
  await report(info, 'real-source-data-readonly', {
    passed: true,
    databases,
    filesServiceId: files.id,
    screens,
    ...network,
  });
});

test('真实 S5 同环境连接只读：已发布 PostgreSQL 与 Redis 引用', async ({ page }, info) => {
  const state = JSON.parse(await readFile(bindingStatePath, 'utf8')) as {
    version: 1;
    source: {
      projectId: string;
      environmentId: string;
      clusterId: string;
      providers: Record<string, { databaseId: string; volumeId: string; pvcUid: string }>;
    };
    services: Record<string, string>;
    bindings: Record<string, string>;
  };
  if (state.version !== 1 || !state.services.postgresql || !state.services.redis)
    throw new Error('Real published binding consumers are not prepared yet.');
  await authenticate(page);
  const observed = monitor(page);
  const screens: Awaited<ReturnType<typeof sample>>[] = [];
  const references: Array<{
    engine: string;
    serviceId: string;
    deploymentId: string;
    bindingId: string;
    databaseId: string;
    profile: string;
    variables: string[];
    credentialRefId: string;
    credentialContentRevision: number;
  }> = [];
  for (const engine of ['postgresql', 'redis']) {
    const service = await get<Service>(page, `/services/${state.services[engine]}`);
    expect({
      projectId: service.projectId,
      environmentId: service.environmentId,
      clusterId: service.clusterId,
    }).toEqual({
      projectId: state.source.projectId,
      environmentId: state.source.environmentId,
      clusterId: state.source.clusterId,
    });
    const response = await page.request.get(`/api/services/${service.id}/database-bindings`);
    expect(response.status()).toBe(200);
    const collection = (await response.json()) as DatabaseBindingCollection;
    expect(collection.serviceRevision).toBe(service.revision);
    const binding = collection.data.find((item) => item.id === state.bindings[engine]);
    expect(binding).toBeTruthy();
    expect(binding!.databaseInstanceId).toBe(state.source.providers[engine]!.databaseId);
    expect(binding!.desired).toBe(true);
    expect(binding!.published).toBe(true);
    expect(service.published).toBeTruthy();
    const deployment = await get<DeploymentDetail>(
      page,
      `/deployments/${service.published!.deploymentId}`,
    );
    const snapshot = deployment.snapshot.databaseBindings?.find(
      (item) => item.bindingId === binding!.id,
    );
    expect(snapshot).toBeTruthy();
    expect(snapshot!.databaseInstanceId).toBe(binding!.databaseInstanceId);
    expect(snapshot!.mapping).toEqual(binding!.mapping);
    const database = await get<Database>(page, `/databases/${binding!.databaseInstanceId}`);
    expect(database.dataVolume.id).toBe(state.source.providers[engine]!.volumeId);
    expect(database.dataVolume.pvcUid).toBe(state.source.providers[engine]!.pvcUid);
    await page.goto(`/databases/${database.id}`);
    await expectProtectionLabels(page);
    screens.push(await sample(page, info, `real-${engine}-database-protection`));
    if (engine === 'redis') {
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
      await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
    }
    await page.goto(location(service, 'storage'));
    if (engine === 'redis') await expectVisibleStorageTab(page);
    const row = page.locator('[data-service-database-bindings] .binding-list > li').filter({
      has: page.locator(`a[href="/databases/${binding!.databaseInstanceId}"]`),
    });
    await expect(row).toContainText('已发布引用');
    await expect(row).toContainText('草稿引用');
    const variables = Object.values(binding!.mapping).filter(
      (value): value is string => typeof value === 'string',
    );
    expect(variables.length).toBeGreaterThan(0);
    for (const variable of variables) await expect(row).toContainText(variable);
    screens.push(await sample(page, info, `real-${engine}-published-binding`));
    await page.goto(`/deployments/${deployment.id}`);
    const fixed = page.locator('[data-deployment-storage-snapshot]');
    await expect(fixed).toContainText(binding!.databaseInstanceId);
    await expect(fixed).toContainText(snapshot!.credentialRefId);
    await expect(fixed).toContainText(snapshot!.providerDeploymentId);
    references.push({
      engine,
      serviceId: service.id,
      deploymentId: deployment.id,
      bindingId: binding!.id,
      databaseId: binding!.databaseInstanceId,
      profile: binding!.profile,
      variables,
      credentialRefId: snapshot!.credentialRefId,
      credentialContentRevision: snapshot!.credentialContentRevision,
    });
  }
  const network = await observed.finish();
  expect(network.writes).toEqual([]);
  await report(info, 'real-published-bindings-readonly', {
    passed: true,
    references,
    screens,
    ...network,
  });
});

test('真实 S5 手工记录只读：源卷、新目标与操作者证据', async ({ page }, info) => {
  const main = JSON.parse(await readFile(mainStatePath, 'utf8')) as MainState;
  if (main.version !== 1 || !main.volumes.postgresql || !main.volumes.redis || !main.volumes.files)
    throw new Error('Main S5 manual data sources are not prepared yet.');
  await authenticate(page);
  const observed = monitor(page);
  const screens: Awaited<ReturnType<typeof sample>>[] = [];
  const evidence: Array<{
    engine: string;
    sourceVolumeId: string;
    sourcePvcUid: string;
    backupRecordId: string;
    restoreRecordId: string;
    targetVolumeId: string;
    targetPvcUid: string;
    verificationSource: string;
  }> = [];
  for (const engine of ['postgresql', 'redis', 'files']) {
    const volume = await get<Volume>(page, `/volumes/${main.volumes[engine]}`);
    const records = await collection<ManualDataRecord>(
      page,
      `/volumes/${volume.id}/manual-data-records?limit=100`,
    );
    const backup = records.data.find(
      (record) => record.type === 'backup' && record.result === 'passed',
    );
    const restore = records.data.find(
      (record) => record.type === 'restore' && record.result === 'passed',
    );
    expect(backup, `${engine} actual backup record`).toBeTruthy();
    expect(restore, `${engine} actual restore record`).toBeTruthy();
    expect(restore!.target).toBeTruthy();
    expect(restore!.target!.volumeId).not.toBe(volume.id);
    for (const record of [backup!, restore!]) {
      expect(record.source.volumeId).toBe(volume.id);
      expect(record.source.pvcUid).toBe(volume.pvc.uid);
      expect(record.engine).toBe(engine);
      expect(record.verificationSource).toBe('operator_reported');
    }
    const target = await get<Volume>(page, `/volumes/${restore!.target!.volumeId}`);
    expect(target.pvc.uid).toBe(restore!.target!.pvcUid);
    await page.setViewportSize({
      width: engine === 'postgresql' ? 1440 : engine === 'redis' ? 1024 : 390,
      height: 1000,
    });
    if (engine === 'files') {
      await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
      await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
    }
    await page.goto(`/volumes/${volume.id}?tab=manual`);
    for (const record of [backup!, restore!]) {
      const card = page
        .locator('[data-manual-record-list] article')
        .filter({
          has: page.getByRole('heading', {
            name: record.type === 'backup' ? '手工备份记录' : '手工恢复记录',
            exact: true,
          }),
        })
        .filter({ hasText: record.backupId })
        .first();
      await expect(card).toContainText('操作者报告通过');
      await card.getByText('查看清单与验证证据', { exact: true }).click();
      await expect(card).toContainText(record.source.pvcUid);
      await expect(card).toContainText(record.sha256);
      if (record.target)
        await expect(card.getByRole('link', { name: '查看目标卷', exact: true })).toHaveAttribute(
          'href',
          `/volumes/${record.target.volumeId}`,
        );
    }
    screens.push(await sample(page, info, `real-${engine}-manual-records`));
    evidence.push({
      engine,
      sourceVolumeId: volume.id,
      sourcePvcUid: backup!.source.pvcUid,
      backupRecordId: backup!.id,
      restoreRecordId: restore!.id,
      targetVolumeId: target.id,
      targetPvcUid: restore!.target!.pvcUid,
      verificationSource: restore!.verificationSource,
    });
  }
  const network = await observed.finish();
  expect(network.writes).toEqual([]);
  await report(info, 'real-manual-records-readonly', {
    passed: true,
    evidence,
    screens,
    ...network,
  });
});
