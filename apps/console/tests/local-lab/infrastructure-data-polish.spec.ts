import { expect, test, type Page, type Route } from '@playwright/test';
import type { Cluster, Operation, OperationLog } from '../../src/lib/types';
import { installS4Fixture, ids, makeDomain, setReadyObservations, servicePath } from './s4-fixture';
import { installImageWorkspaceFixture } from './service-workspace-v3-fixture';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const checked = new WeakMap<Page, { errors: string[]; unexpected: string[] }>();
function track(page: Page, state: { unexpected: string[] }) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  checked.set(page, { errors, unexpected: state.unexpected });
}
test.afterEach(async ({ page }) => {
  const run = checked.get(page);
  if (!run) return;
  expect(run.errors, '浏览器运行错误').toEqual([]);
  expect(run.unexpected, '未声明的 API 请求').toEqual([]);
});
declare global {
  interface Window {
    __infrastructureCopies: string[];
  }
}
async function clipboardFixture(page: Page, failure = false) {
  await page.addInitScript(
    ({ failure }) => {
      window.__infrastructureCopies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            window.__infrastructureCopies.push(value);
            if (failure) throw new Error('Controlled clipboard rejection.');
          },
        },
      });
    },
    { failure },
  );
}

async function taskFixture(page: Page) {
  const state = await installS4Fixture(page);
  track(page, state);
  const time = new Date().toISOString();
  const first: Operation = {
    id: '74000000-0000-4000-8000-000000000001',
    kind: 'cluster_sync',
    scope: 'cluster',
    serverId: null,
    clusterId: ids.cluster,
    serviceId: null,
    status: 'failed',
    input: { targetId: ids.cluster, connectionRevision: 4 },
    result: null,
    createdAt: time,
    updatedAt: time,
    startedAt: time,
    finishedAt: time,
    attempts: 1,
    maxAttempts: 3,
    errorCode: 'CONTROLLED_SYNC_FAILURE',
    errorMessage: '受控集群观察失败。',
    retryOfId: null,
    cancelRequestedAt: null,
    pollUrl: '/api/operations/74000000-0000-4000-8000-000000000001',
  };
  state.operations.push(first);
  const cluster: Cluster = {
    id: ids.cluster,
    name: '受控基础设施任务',
    slug: 'fixture-cluster',
    revision: 4,
    createdAt: time,
    updatedAt: time,
    identity: null,
    observation: null,
    observationStale: true,
    nodeCount: 0,
    lastAttemptAt: time,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastOperationId: first.id,
    description: null,
    region: null,
    apiEndpoint: 'https://192.0.2.10:6443',
    credentialRefId: null,
    connectionStatus: 'unreachable',
    lastObservedAt: null,
    projectCount: 1,
  };
  const rows: OperationLog[] = Array.from({ length: 40 }, (_, index) => ({
    sequence: index + 1,
    timestamp: time,
    level: 'info',
    attempt: 1,
    message: `infrastructure-history-${index}`,
    ...(index === 10 ? { code: 'CONTROLLED_MATCH' } : {}),
  }));
  const controls = {
    beforeLogs: undefined as undefined | (() => Promise<void>),
    beforeRetry: undefined as undefined | (() => Promise<void>),
    beforeCancel: undefined as undefined | (() => Promise<void>),
    failRetry: false,
    failCancel: false,
  };
  // The S4 fixture intercepts every API call. This overlay adds only the declared
  // cluster task, its empty node inventory and controlled log/action responses.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    if (request.method() === 'GET' && path === `/clusters/${ids.cluster}`) {
      state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
      return json(route, { data: cluster });
    }
    if (request.method() === 'GET' && path === `/clusters/${ids.cluster}/nodes`) {
      state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
      return json(route, { data: [], page: { hasMore: false, nextCursor: null } });
    }
    const match = path.match(/^\/operations\/([^/]+)\/(logs|retry|cancel)$/);
    const operation = match && state.operations.find((value) => value.id === match[1]);
    if (!operation || !match) return route.fallback();
    if (request.method() === 'GET' && match[2] === 'logs') {
      state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
      await controls.beforeLogs?.();
      const data = operation.id === first.id ? rows : [];
      return json(route, {
        data,
        source: 'operation',
        available: !!data.length,
        unavailableReason: data.length ? null : 'not_started',
        truncated: false,
        page: { hasMore: false, nextCursor: null },
      });
    }
    if (request.method() !== 'POST' || !['retry', 'cancel'].includes(match[2]!))
      return route.fallback();
    state.writes.push({
      path,
      method: request.method(),
      body: request.postDataJSON(),
      key: request.headers()['idempotency-key'] ?? null,
    });
    if (match[2] === 'cancel') {
      await controls.beforeCancel?.();
      if (controls.failCancel)
        return json(
          route,
          { status: 503, code: 'CONTROLLED_CANCEL_FAILURE', detail: '受控取消暂未收到确认。' },
          503,
        );
      operation.cancelRequestedAt = new Date().toISOString();
      return json(route, { data: operation }, 202);
    }
    await controls.beforeRetry?.();
    if (controls.failRetry)
      return json(
        route,
        { status: 503, code: 'CONTROLLED_RETRY_FAILURE', detail: '受控重试暂未收到确认。' },
        503,
      );
    const id = `74000000-0000-4000-8000-${String(state.operations.length + 1).padStart(12, '0')}`;
    const next: Operation = {
      ...structuredClone(operation),
      id,
      status: 'queued',
      retryOfId: operation.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      cancelRequestedAt: null,
      attempts: 0,
      pollUrl: `/api/operations/${id}`,
    };
    state.operations.push(next);
    cluster.lastOperationId = next.id;
    return json(route, { data: next }, 202);
  });
  return { state, first, cluster, rows, controls, time, path: `/clusters/${ids.cluster}` };
}

for (const action of ['sync', 'reconcile', 'production'] as const) {
  test(`域名 ${action} 慢请求显示具体操作，受理后继续等待任务结果`, async ({ page }) => {
    const state = await installS4Fixture(page);
    track(page, state);
    const domain = makeDomain();
    setReadyObservations(domain);
    state.domains.push(domain);
    const calls: { key: string | undefined; body: unknown }[] = [];
    let release!: () => void;
    let waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reject = action === 'sync';
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      if (
        request.method() !== 'POST' ||
        new URL(request.url()).pathname !== `/api/domains/${domain.id}/${action}`
      )
        return route.fallback();
      calls.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
      await waiting;
      if (reject)
        return json(
          route,
          { status: 503, code: 'CONTROLLED_DOMAIN_FAILURE', detail: '受控域名请求暂未确认。' },
          503,
        );
      return route.fallback();
    });
    await page.goto(`/domains/${domain.id}`);
    const actions = page.locator('[data-domain-actions]');
    const labels = {
      sync: ['重新检查', '正在提交检查…'],
      reconcile: ['重新应用绑定', '正在提交重新应用…'],
      production: ['申请正式证书', '正在提交证书申请…'],
    } as const;
    async function submit() {
      await actions.getByRole('button', { name: labels[action][0], exact: true }).click();
      if (action === 'production')
        await page
          .getByRole('dialog')
          .getByRole('button', { name: '申请正式证书', exact: true })
          .click();
    }
    await submit();
    const pending = actions.getByRole('button', { name: labels[action][1], exact: true });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect(pending.locator('svg.animate-spin')).toHaveCount(1);
    await expect(actions.getByRole('button', { name: '解绑审查', exact: true })).toBeDisabled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ revision: domain.revision });
    expect(calls[0]?.key).toBeTruthy();
    release();
    if (action === 'sync') {
      await expect(actions).toContainText('受控域名请求暂未确认');
      await expect(
        actions.getByRole('button', { name: labels[action][0], exact: true }),
      ).toBeEnabled();
      reject = false;
      waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      await submit();
      await expect(pending).toBeDisabled();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.key).toBe(calls[0]?.key);
      release();
    }
    await expect.poll(() => state.operations.length).toBe(1);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('operation'))
      .toBe(state.operations[0]!.id);
    expect(state.operations[0]!.status).toBe('queued');
    await expect(actions.getByRole('button', { name: '重新检查', exact: true })).toBeDisabled();
    await expect(actions.getByRole('button', { name: labels[action][1], exact: true })).toHaveCount(
      0,
    );
  });
}

test('DNS 观察和分配说明逐项复制实际 A、AAAA 与 CNAME 值', async ({ page }) => {
  const state = await installS4Fixture(page);
  track(page, state);
  await clipboardFixture(page);
  const domain = makeDomain();
  setReadyObservations(domain);
  const addresses = ['192.0.2.10', '2001:db8::10'];
  const cname = 'edge.fixture.example.test';
  domain.dns!.addresses = [...addresses];
  domain.dns!.expectedAddresses = [...addresses];
  domain.dns!.expectedCname = cname;
  domain.dns!.cnameChain = [cname, 'ingress.fixture.example.test'];
  state.domains.push(domain);
  state.networking.entryAddresses = [...addresses];
  state.networking.cnameTarget = cname;
  await page.goto(`/domains/${domain.id}`);
  const observations = page.locator('[data-domain-observations]');
  for (const [label, value] of [
    [`复制预期 A 记录值 ${addresses[0]}`, addresses[0]!],
    [`复制预期 AAAA 记录值 ${addresses[1]}`, addresses[1]!],
    ['复制预期 CNAME 目标', cname],
    [`复制解析 A 记录值 ${addresses[0]}`, addresses[0]!],
    [`复制解析 AAAA 记录值 ${addresses[1]}`, addresses[1]!],
    ['复制 CNAME 路径 ingress.fixture.example.test', 'ingress.fixture.example.test'],
  ]) {
    await observations.getByRole('button', { name: label, exact: true }).click();
    expect(await page.evaluate(() => window.__infrastructureCopies.at(-1))).toBe(value);
  }
  state.domains.splice(0);
  await page.goto(servicePath);
  const allocation = page.locator('[data-domain-allocation]');
  for (const [label, value] of [
    [`复制 A 记录值 ${addresses[0]}`, addresses[0]!],
    [`复制 AAAA 记录值 ${addresses[1]}`, addresses[1]!],
    ['复制 CNAME 目标', cname],
  ]) {
    await allocation.getByRole('button', { name: label, exact: true }).click();
    expect(await page.evaluate(() => window.__infrastructureCopies.at(-1))).toBe(value);
  }
  expect(state.writes).toHaveLength(0);
});

test('数据库只复制实际连接字段，缺少地址不复制提示，Redis 逻辑库 0 可复制', async ({ page }) => {
  const state = await installImageWorkspaceFixture(page);
  track(page, state);
  await clipboardFixture(page);
  const database = state.imageState.databases[0]!;
  await page.goto(`/databases/${database.id}`);
  const identity = page.locator('[data-database-identity]');
  for (const label of ['复制数据库地址', '复制数据库端口', '复制数据库名', '复制数据库用户名'])
    await identity.getByRole('button', { name: label, exact: true }).click();
  expect(await page.evaluate(() => window.__infrastructureCopies)).toEqual([
    database.connection.host,
    String(database.connection.port),
    database.connection.database,
    database.connection.username,
  ]);
  database.engine = 'redis';
  database.majorVersion = 7;
  database.exactVersion = '7.4.2';
  database.connection.host = null;
  database.connection.port = 6379;
  database.connection.database = null;
  database.connection.redisDatabase = 0;
  database.connection.username = 'default';
  await page.reload();
  await expect(identity.getByRole('button', { name: '复制数据库地址', exact: true })).toHaveCount(
    0,
  );
  await expect(identity).toContainText('发布后由实际 Service 确认');
  await identity.getByRole('button', { name: '复制逻辑库编号', exact: true }).click();
  expect(await page.evaluate(() => window.__infrastructureCopies.at(-1))).toBe('0');
  database.connection.redisDatabase = null;
  await page.reload();
  await expect(identity.getByRole('button', { name: '复制逻辑库编号', exact: true })).toHaveCount(
    0,
  );
  expect(state.writes).toHaveLength(0);
});

test('基础设施日志支持已载入搜索、复制、暂停阅读和折叠后恢复', async ({ page }) => {
  const fixture = await taskFixture(page);
  await clipboardFixture(page);
  await page.goto(fixture.path);
  const task = page.locator('[data-infrastructure-task]');
  await task.locator('.task-logs > summary').click();
  const output = task.locator('.log-scroll');
  await expect(output.locator('.log-line')).toHaveCount(40);
  await task.getByLabel('搜索基础设施日志', { exact: true }).fill('controlled_match');
  await expect(output.locator('.log-line')).toHaveCount(1);
  await task.getByRole('button', { name: '复制匹配日志', exact: true }).click();
  expect(await page.evaluate(() => window.__infrastructureCopies.at(-1))).toBe(
    `${fixture.time} info infrastructure-history-10 [CONTROLLED_MATCH]`,
  );
  await task.getByLabel('搜索基础设施日志', { exact: true }).fill('');
  await output.press('Home');
  await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(task.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.controls.beforeLogs = () => waiting;
  await task.getByRole('button', { name: '刷新基础设施日志', exact: true }).click();
  await expect(task.getByText('正在更新，保留当前内容', { exact: true })).toBeVisible();
  await expect(output.locator('.log-line')).toHaveCount(40);
  fixture.rows.push({
    sequence: 41,
    timestamp: fixture.time,
    level: 'info',
    attempt: 1,
    message: 'infrastructure-final-line',
  });
  fixture.controls.beforeLogs = undefined;
  release();
  await expect(output.locator('.log-line')).toHaveCount(41);
  expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(
    task.getByRole('button', { name: '回到最新 · 1 条新输出', exact: true }),
  ).toBeVisible();
  await task.locator('.task-logs > summary').click();
  await expect(output).toBeHidden();
  await task.locator('.task-logs > summary').click();
  await expect(output).toBeVisible();
  expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(
    task.getByRole('button', { name: '回到最新 · 1 条新输出', exact: true }),
  ).toBeVisible();
  await task.getByRole('button', { name: '复制基础设施日志', exact: true }).click();
  expect(await page.evaluate(() => window.__infrastructureCopies.at(-1))).toContain(
    'infrastructure-final-line',
  );
  await task.getByRole('button', { name: '回到最新 · 1 条新输出', exact: true }).click();
  await expect
    .poll(() =>
      output.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThan(3);
  expect(fixture.state.writes).toHaveLength(0);
});

test('基础设施重试和取消显示真实 pending，重试沿用幂等键且取消受理不冒充完成', async ({ page }) => {
  const fixture = await taskFixture(page);
  await page.goto(fixture.path);
  const task = page.locator('[data-infrastructure-task]');
  await task.locator('.task-logs > summary').click();
  await expect(task.locator('.log-line')).toHaveCount(40);
  let release!: () => void;
  let waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.controls.beforeRetry = () => waiting;
  fixture.controls.failRetry = true;
  await task.getByRole('button', { name: '创建重试任务', exact: true }).click();
  const retry = task.getByRole('button', { name: '正在创建重试任务…', exact: true });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  expect(fixture.state.writes).toHaveLength(1);
  release();
  await expect(task).toContainText('受控重试暂未收到确认');
  fixture.controls.failRetry = false;
  waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await task.getByRole('button', { name: '创建重试任务', exact: true }).click();
  await expect(retry).toBeDisabled();
  expect(fixture.state.writes).toHaveLength(2);
  expect(fixture.state.writes[0]!.key).toBeTruthy();
  expect(fixture.state.writes[1]!.key).toBe(fixture.state.writes[0]!.key);
  release();
  await expect.poll(() => fixture.state.operations.length).toBe(2);
  const accepted = fixture.state.operations[1]!;
  await expect(task).toContainText(accepted.id);
  expect(accepted.input).toEqual(fixture.first.input);
  expect(accepted.retryOfId).toBe(fixture.first.id);
  expect(accepted.status).toBe('queued');
  waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.controls.beforeCancel = () => waiting;
  fixture.controls.failCancel = true;
  await task.getByRole('button', { name: '请求取消', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '请求取消', exact: true }).click();
  const cancel = task.getByRole('button', { name: '正在提交取消…', exact: true });
  await expect(cancel).toBeDisabled();
  await expect(cancel).toHaveAttribute('aria-busy', 'true');
  expect(fixture.state.writes).toHaveLength(3);
  expect(fixture.state.writes[2]!.path).toBe(`/operations/${accepted.id}/cancel`);
  release();
  await expect(task).toContainText('受控取消暂未收到确认');
  expect(accepted.cancelRequestedAt).toBeNull();
  const external: Operation = {
    ...structuredClone(accepted),
    id: '74000000-0000-4000-8000-000000000003',
    status: 'running',
    startedAt: new Date().toISOString(),
    pollUrl: '/api/operations/74000000-0000-4000-8000-000000000003',
  };
  fixture.state.operations.push(external);
  fixture.cluster.lastOperationId = external.id;
  accepted.status = 'failed';
  accepted.finishedAt = new Date().toISOString();
  // A completed old task refreshes its parent cluster. That same component now
  // receives the newly observed task id, without navigation or a remount.
  await task.getByRole('button', { name: '刷新当前基础设施任务', exact: true }).click();
  await expect(task).toContainText(external.id);
  await expect(task).not.toContainText('受控取消暂未收到确认');
  await expect(task.locator('.task-logs')).toHaveAttribute('open', '');
  await expect(task).not.toContainText('infrastructure-history-');
  fixture.controls.failCancel = false;
  waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await task.getByRole('button', { name: '请求取消', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '请求取消', exact: true }).click();
  await expect(cancel).toBeDisabled();
  expect(fixture.state.writes).toHaveLength(4);
  expect(fixture.state.writes[3]!.path).toBe(`/operations/${external.id}/cancel`);
  release();
  await expect(task.getByRole('button', { name: '取消待确认', exact: true })).toBeDisabled();
  expect(external.status).toBe('running');
  expect(external.finishedAt).toBeNull();
  expect(external.cancelRequestedAt).toBeTruthy();
  await expect(task.getByRole('progressbar')).toHaveCount(0);
});

test('长 DNS 与数据库地址在三种宽度和明暗主题下可选中，复制失败提示不撑宽页面', async ({
  page,
}) => {
  const state = await installImageWorkspaceFixture(page);
  track(page, state);
  await clipboardFixture(page, true);
  await page.addInitScript(() => localStorage.setItem('ozz.appearance', 'system'));
  const database = state.imageState.databases[0]!;
  const host =
    Array.from({ length: 6 }, (_, index) => `db-${index}-${'y'.repeat(21)}`).join('.') +
    '.namespace.svc.cluster.local';
  database.connection.host = host;
  const cname =
    Array.from({ length: 6 }, (_, index) => `edge-${index}-${'x'.repeat(26)}`).join('.') +
    '.example.test';
  const domain = makeDomain();
  domain.serviceId = state.service.id;
  domain.serviceName = state.service.name;
  domain.project = state.service.project;
  domain.environment = state.service.environment;
  domain.cluster = state.service.cluster;
  setReadyObservations(domain);
  domain.dns!.expectedCname = cname;
  domain.dns!.cnameChain = [cname];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname !== `/api/domains/${domain.id}`)
      return route.fallback();
    state.reads.push({
      path: `/domains/${domain.id}`,
      query: Object.fromEntries(url.searchParams),
    });
    return json(route, { data: domain });
  });
  const records: {
    view: string;
    width: number;
    theme: string;
    overflow: number;
    selectable: boolean;
    retryEnabled: boolean;
  }[] = [];
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const view of ['dns', 'database'] as const) {
        const value = view === 'dns' ? cname : host;
        await page.goto(view === 'dns' ? `/domains/${domain.id}` : `/databases/${database.id}`);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
          .toBe(theme === 'dark');
        const section = page.locator(
          view === 'dns' ? '[data-domain-observations]' : '[data-database-identity]',
        );
        const copy = section.getByRole('button', {
          name: view === 'dns' ? `复制 CNAME 路径 ${cname}` : '复制数据库地址',
          exact: true,
        });
        await copy.click();
        await expect(
          copy.locator('..').getByText('复制失败，请选中文本后复制。', { exact: true }),
        ).toBeVisible();
        await expect(copy).toBeEnabled();
        expect(await page.evaluate(() => window.__infrastructureCopies.at(-1))).toBe(value);
        const record = section.getByText(value, { exact: true });
        const selection = await record.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return { text: selection?.toString(), userSelect: getComputedStyle(element).userSelect };
        });
        expect(selection.userSelect).not.toBe('none');
        expect(selection.text).toBe(value);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${view} / ${width} / ${theme}`).toBeLessThanOrEqual(1);
        const copiedBeforeRetry = await page.evaluate(() => window.__infrastructureCopies.length);
        await copy.click();
        await expect
          .poll(() => page.evaluate(() => window.__infrastructureCopies.length))
          .toBe(copiedBeforeRetry + 1);
        await expect(copy).toBeEnabled();
        records.push({
          view,
          width,
          theme,
          overflow,
          selectable: selection.text === value,
          retryEnabled: await copy.isEnabled(),
        });
      }
    }
  }
  expect(records).toHaveLength(12);
  expect(state.writes).toHaveLength(0);
  await test.info().attach('dns-database-copy-layout.json', {
    body: JSON.stringify(records, null, 2),
    contentType: 'application/json',
  });
});
