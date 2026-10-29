import { expect, test, type Page } from '@playwright/test';
import type { Server } from '../../src/lib/types';
import { installCreationFixture } from './creation-v3-fixture';
import { makeDatabase, makeVolume, s5Environment, s5Ids, timestamp } from '../fixtures/s5-data';

const runs = new WeakMap<Page, { errors: string[]; unexpected: string[] }>();
const secondServerId = '68000000-0000-4000-8000-000000000002';
const foreignEnvironmentId = '68000000-0000-4000-8000-000000000090';
async function fixture(page: Page) {
  const base = await installCreationFixture(page);
  const server: Server = {
    id: '68000000-0000-4000-8000-000000000001',
    name: '台北服务器样本',
    revision: 1,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    initializationVersion: 'fixture-only',
    hostKey: {
      trustedFingerprint: null,
      trustedAt: null,
      trustSource: null,
      observedFingerprint: null,
      observedAlgorithm: null,
      observedAt: null,
      discoveryOperationId: null,
    },
    machineId: null,
    preflight: null,
    preflightAt: null,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastOperationId: null,
    host: '192.0.2.81',
    sshPort: 22,
    sshUser: 'fixture',
    credentialRefId: null,
    region: '台北',
    tags: [],
    connectionStatus: 'unverified',
    lastObservedAt: null,
  };
  const state = {
    ...base,
    failServers: false,
    servers: [
      server,
      {
        ...server,
        id: secondServerId,
        name: '目标服务器' + 'LongName'.repeat(10),
        host: '192.0.2.82',
        region: '东京',
      },
    ],
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { errors, unexpected: state.core.unexpected });
  // S5 owns all other API contracts; the extra server records are read-only fixtures.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    const match = path.match(/^\/servers\/([^/]+)(?:\/(nodes))?$/);
    const current = match && state.servers.find((value) => value.id === match[1]);
    const clusterNodes = path === `/clusters/${s5Ids.cluster}/nodes`;
    if (request.method() !== 'GET' || (path !== '/servers' && !current && !clusterNodes))
      return route.fallback();
    state.core.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    if (path === '/servers' && state.failServers)
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'SERVER_LIST_REJECTED', detail: '服务器列表暂时不能读取。' }),
      });
    const start = Number(url.searchParams.get('cursor') || 0);
    const data =
      path === '/servers'
        ? {
            data: state.servers.slice(start, start + 1),
            page: {
              hasMore: start + 1 < state.servers.length,
              nextCursor: start + 1 < state.servers.length ? String(start + 1) : null,
            },
          }
        : clusterNodes || match?.[2] === 'nodes'
          ? { data: [], page: { hasMore: false, nextCursor: null } }
          : { data: current };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });
  return state;
}
test.afterEach(({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors, '浏览器脚本错误').toEqual([]);
    expect(run.unexpected, '未声明的 API 请求').toEqual([]);
  }
});
async function expectNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

test('基础设施搜索只筛已载入条目，分页、详情往返、类型切换和刷新保留关键词', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/infrastructure?tab=servers&search=目标');
  const search = page.getByLabel('搜索已载入服务器', { exact: true });
  await expect(search).toHaveValue('目标');
  await expect(search).toHaveAttribute('placeholder', '筛选已载入服务器的名称、地区或地址');
  await expect(page.getByText('没有匹配的服务器', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '载入更多记录', exact: true }).click();
  const target = state.servers[1]!;
  const detail = page.getByRole('link', { name: `查看服务器 ${target.name}`, exact: true });
  await expect(detail).toBeVisible();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  const reads = state.core.reads.filter((read) => read.path === '/servers');
  expect(reads).toHaveLength(2);
  expect(reads[1]!.query.cursor).toBe('1');
  expect(reads.every((read) => !Object.hasOwn(read.query, 'search'))).toBe(true);
  await detail.click();
  await expect(page).toHaveURL(new RegExp(`/servers/${target.id}\\?`));
  await expect(page.locator('#server-name')).toHaveValue(target.name);
  await page.goBack();
  await expect(search).toHaveValue('目标');
  await expect(detail).toBeVisible();
  await page.goForward();
  await expect(page.locator('#server-name')).toHaveValue(target.name);
  await page.reload();
  await page
    .getByRole('navigation', { name: '面包屑' })
    .getByRole('link', { name: '服务器', exact: true })
    .click();
  await expect(search).toHaveValue('目标');
  const tabs = page.getByRole('navigation', { name: '基础设施类型', exact: true });
  await tabs.getByRole('link', { name: /^集群/ }).click();
  await expect(page.getByLabel('搜索已载入集群', { exact: true })).toHaveValue('目标');
  await tabs.getByRole('link', { name: /^服务器/ }).click();
  await expect(search).toHaveValue('目标');
  await page.reload();
  await expect(search).toHaveValue('目标');
  await expect(page).toHaveURL(/tab=servers.*search=|search=.*tab=servers/);
  await page.getByRole('button', { name: '载入更多记录', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: target.name, exact: true })).toHaveText(target.name);
  await expectNoPageOverflow(page);
  expect(state.core.writes).toHaveLength(0);
});

test('基础设施读取失败仍保留 URL 搜索，刷新失败不会显示空列表引导', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/infrastructure?tab=servers&search=台北');
  const search = page.getByLabel('搜索已载入服务器', { exact: true });
  await expect(page.getByRole('link', { name: state.servers[0]!.name, exact: true })).toBeVisible();
  state.failServers = true;
  await page.getByRole('button', { name: '刷新基础设施', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('服务器列表暂时不能读取。');
  await expect(search).toHaveValue('台北');
  await expect(page.getByRole('link', { name: state.servers[0]!.name, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('服务器列表暂时不能读取。');
  await expect(search).toHaveValue('台北');
  await expect(page.locator('main .empty-state')).toHaveCount(0);
  state.failServers = false;
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(page.getByRole('link', { name: state.servers[0]!.name, exact: true })).toBeVisible();
  await expect(search).toHaveValue('台北');
  expect(state.core.writes).toHaveLength(0);
});

test('集群详情刷新后按面包屑返回原搜索，无效返回地址回落基础设施列表', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/infrastructure?search=隔离');
  await page.getByRole('link', { name: '查看集群 隔离集群样本', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/clusters/${s5Ids.cluster}\\?`));
  await page.reload();
  const back = page
    .getByRole('navigation', { name: '面包屑' })
    .getByRole('link', { name: '基础设施', exact: true });
  await expect(back).toHaveAttribute('href', '/infrastructure?search=%E9%9A%94%E7%A6%BB');
  await back.click();
  await expect(page.getByLabel('搜索已载入集群', { exact: true })).toHaveValue('隔离');
  for (const list of ['https://example.test/volumes?search=other', '/databases?search=other']) {
    await page.goto(`/clusters/${s5Ids.cluster}?list=${encodeURIComponent(list)}`);
    await expect(back).toHaveAttribute('href', '/infrastructure');
  }
  await back.click();
  await expect(page).toHaveURL(/\/infrastructure$/);
  expect(state.core.reads.every((read) => !Object.hasOwn(read.query, 'list'))).toBe(true);
  expect(state.core.writes).toHaveLength(0);
});

for (const resource of [
  {
    path: '/volumes',
    term: '导航卷',
    label: '搜索卷名称',
    rows: '.volume-row',
    more: '载入更多卷',
    kind: '卷',
  },
  {
    path: '/databases',
    term: '导航数据库',
    label: '搜索数据库',
    rows: '.database-row',
    more: '载入更多数据库',
    kind: '数据库',
  },
] as const) {
  test(`${resource.kind}保留后端搜索、归属组合与分页，错误搜索和详情返回可恢复`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.core.pageLimit = 1;
    const name = resource.term + 'LongResourceName'.repeat(5);
    let id: string;
    if (resource.path === '/volumes') {
      const first = state.core.volumes[0]!;
      first.name = name;
      id = first.id;
      state.core.volumes.push(
        makeVolume({ id: '68000000-0000-4000-8000-000000000021', name: '导航卷第二项' }),
        makeVolume({
          id: '68000000-0000-4000-8000-000000000022',
          name: '导航卷其他环境',
          environment: {
            ...s5Environment,
            id: foreignEnvironmentId,
            name: '其他环境',
            slug: 'other',
          },
        }),
      );
    } else {
      const first = state.core.databases[0]!;
      first.service = { ...first.service!, name };
      first.originalService = { ...first.originalService, name };
      id = first.id;
      for (const [suffix, environmentId] of [
        ['031', s5Ids.environment],
        ['032', foreignEnvironmentId],
      ] as const) {
        const service = {
          id: `68000000-0000-4000-8000-000000000${suffix}`,
          name: `导航数据库${environmentId === foreignEnvironmentId ? '其他环境' : '第二项'}`,
          slug: `database-${suffix}`,
        };
        state.core.databases.push(
          makeDatabase({
            id: `69000000-0000-4000-8000-000000000${suffix}`,
            environmentId,
            service,
            originalService: service,
            dataVolume: {
              ...first.dataVolume,
              id: `70000000-0000-4000-8000-000000000${suffix}`,
              name: `数据库数据 ${suffix}`,
            },
          }),
        );
      }
    }
    const scope = {
      projectId: s5Ids.project,
      environmentId: s5Ids.environment,
      clusterId: s5Ids.cluster,
      ...(resource.path === '/volumes' ? { retained: 'false' } : {}),
    };
    const query = new URLSearchParams({ ...scope, search: resource.term });
    await page.route(`**/api${resource.path}?**`, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get('search') !== '受控错误搜索') return route.fallback();
      state.core.reads.push({ path: resource.path, query: Object.fromEntries(params) });
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'RESOURCE_SEARCH_REJECTED',
          detail: '当前搜索暂时不能读取。',
        }),
      });
    });
    await page.goto(`${resource.path}?${query}`);
    const search = page.getByLabel(resource.label, { exact: true });
    await expect(search).toHaveValue(resource.term);
    await expect(page.locator(resource.rows)).toHaveCount(1);
    await page.getByRole('button', { name: resource.more, exact: true }).click();
    await expect(page.locator(resource.rows)).toHaveCount(2);
    await expect(page.locator(resource.rows).filter({ hasText: '其他环境' })).toHaveCount(0);
    const read = state.core.reads.filter((item) => item.path === resource.path).at(-1)!;
    expect(read.query).toMatchObject({ ...scope, search: resource.term, cursor: 'fixture:1' });
    await page.getByRole('link', { name: `查看${resource.kind} ${name}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${resource.path}/${id}\\?`));
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
    await page.goBack();
    await expect(search).toHaveValue(resource.term);
    await expect(page.getByLabel('项目', { exact: true })).toHaveValue(s5Ids.project);
    await expect(page.getByLabel('环境', { exact: true })).toHaveValue(s5Ids.environment);
    await expect(page.getByLabel('集群', { exact: true })).toHaveValue(s5Ids.cluster);
    await page.goForward();
    await page.reload();
    await page
      .getByRole('navigation', { name: '面包屑' })
      .getByRole('link', {
        name: resource.path === '/volumes' ? '持久卷' : '数据库',
        exact: true,
      })
      .click();
    await expect(search).toHaveValue(resource.term);
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
      ...scope,
      search: resource.term,
    });
    await page.reload();
    await expect(search).toHaveValue(resource.term);
    await expect(page.locator(resource.rows)).toHaveCount(1);
    await search.fill('受控错误搜索');
    await expect(page.getByRole('alert')).toContainText('当前搜索暂时不能读取。');
    await expect(search).toHaveValue('受控错误搜索');
    await expect(page.locator('main .empty-state')).toHaveCount(0);
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
      ...scope,
      search: '受控错误搜索',
    });
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('当前搜索暂时不能读取。');
    await expect(search).toHaveValue('受控错误搜索');
    await search.fill(resource.term);
    await expect(page.locator(resource.rows)).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('link', { name, exact: true })).toHaveText(name);
    await expectNoPageOverflow(page);
    const serviceId = resource.path === '/volumes' ? s5Ids.service : s5Ids.databaseService;
    await page.goto(`${resource.path}?${query}&serviceId=${serviceId}`);
    await expect(search).toHaveValue(resource.term);
    await page.getByLabel('项目', { exact: true }).selectOption('');
    await expect.poll(() => new URL(page.url()).searchParams.has('projectId')).toBe(false);
    const remaining = Object.fromEntries(new URL(page.url()).searchParams);
    expect(remaining).toMatchObject({ clusterId: s5Ids.cluster, search: resource.term });
    expect(remaining).not.toHaveProperty('environmentId');
    expect(remaining).not.toHaveProperty('serviceId');
    if (resource.path === '/volumes') expect(remaining.retained).toBe('false');
    expect(state.core.reads.every((read) => !Object.hasOwn(read.query, 'list'))).toBe(true);
    expect(state.core.writes).toHaveLength(0);
  });
}
