import { expect, test, type Page } from '@playwright/test';
import { installCreationFixture } from './creation-v3-fixture';
import { installImageWorkspaceFixture } from './service-workspace-v3-fixture';
import { s5Ids } from '../fixtures/s5-data';

const runs = new WeakMap<Page, { errors: string[]; unexpected: string[] }>();
function track(page: Page, unexpected: string[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { errors, unexpected });
}
test.afterEach(({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors, '浏览器脚本错误').toEqual([]);
    expect(run.unexpected, '未声明的 API 请求').toEqual([]);
  }
});

test('项目资料重新载入时明确等待，读取失败保留已确认替换前的草稿', async ({ page }) => {
  const state = await installCreationFixture(page);
  track(page, state.core.unexpected);
  let fail = false;
  let count = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/projects/${s5Ids.project}`, async (route) => {
    if (!fail) return route.fallback();
    count++;
    await waiting;
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'FIXTURE_RELOAD_DENIED', detail: '最新项目资料暂时不能读取。' }),
    });
  });
  try {
    await page.goto(`/projects/${s5Ids.project}?environment=staging&tab=settings`);
    const name = page.getByLabel('项目名称', { exact: true });
    await expect(name).toHaveValue(state.projects[0]!.name);
    await name.fill('网络恢复前保留这份项目草稿');
    fail = true;
    await page.getByRole('button', { name: '载入最新资料', exact: true }).click();
    await page
      .getByRole('dialog', { name: '载入最新项目资料？', exact: true })
      .getByRole('button', { name: '载入最新资料', exact: true })
      .click();
    const pending = page.getByRole('button', { name: '正在载入最新资料…', exact: true });
    await expect(pending).toBeDisabled();
    await expect(name).toBeDisabled();
    await pending.click({ force: true });
    expect(count).toBe(1);
    release();
    await expect(page.getByRole('alert')).toContainText('最新项目资料暂时不能读取。');
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue('网络恢复前保留这份项目草稿');
    await expect(page.getByText('尚未保存', { exact: true })).toBeVisible();
    expect(state.core.writes).toHaveLength(0);
  } finally {
    release();
  }
});

test('环境内联编辑取消确认保留内容，放弃后焦点返回原入口', async ({ page }) => {
  const state = await installCreationFixture(page);
  track(page, state.core.unexpected);
  await page.goto(`/projects/${s5Ids.project}?environment=staging&tab=environments`);
  const trigger = page.getByRole('button', { name: '创建环境', exact: true });
  await trigger.click();
  const name = page.getByLabel('环境名称', { exact: true });
  await expect(name).toBeFocused();
  await name.fill('保留这个环境草稿');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '放弃环境修改？', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(name).toHaveValue('保留这个环境草稿');
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(name).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const edit = page.getByRole('button', {
    name: `编辑环境 ${state.environments[0]!.name}`,
    exact: true,
  });
  await edit.click();
  await expect(name).toBeFocused();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(edit).toBeFocused();
  expect(state.core.writes).toHaveLength(0);
});

test('服务侧面板关闭期保留内容并禁止激活，返回后保留原变量草稿', async ({ page }) => {
  const state = await installImageWorkspaceFixture(page);
  track(page, state.unexpected);
  await page.goto(state.pathFor('variables'));
  await page.getByRole('button', { name: '添加变量', exact: true }).click();
  await page.getByLabel('变量名', { exact: true }).fill('PANEL_CONTEXT');
  await page.getByLabel('变量值', { exact: true }).fill('keep-this-editor');
  const tabs = page.getByRole('navigation', { name: '服务页面', exact: true });
  await tabs.getByRole('link', { name: '服务状态', exact: true }).click();
  const trigger = page.getByRole('link', { name: '部署记录', exact: true }).first();
  await trigger.click();
  const panel = page.locator('.service-workspace-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: '部署记录', exact: true }).first()).toBeVisible();
  await panel.getByRole('button', { name: '返回服务', exact: true }).click();
  const closing = page.locator('.service-workspace-panel[data-state="closed"]');
  expect(
    await closing.evaluateAll((elements) =>
      elements.every(
        (element) =>
          element.hasAttribute('inert') &&
          !!element.querySelector('.workspace-panel-body')?.textContent?.trim(),
      ),
    ),
  ).toBe(true);
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await tabs.getByRole('link', { name: /^环境变量/ }).click();
  await expect(page.getByLabel('变量值', { exact: true })).toHaveValue('keep-this-editor');
  await tabs.getByRole('link', { name: '服务状态', exact: true }).click();
  await trigger.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.writes).toHaveLength(0);
});

test('服务聚合页保留 URL 归属和搜索，详情返回与刷新后仍定位原列表', async ({ page }) => {
  const state = await installCreationFixture(page);
  track(page, state.core.unexpected);
  const service = state.core.services[0]!;
  service.name = '用于检查长服务名称的应用'.repeat(5);
  await page.route('**/api/services?**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const data = state.core.services.filter(
      (item) =>
        (!query.get('projectId') || item.projectId === query.get('projectId')) &&
        (!query.get('clusterId') || item.clusterId === query.get('clusterId')) &&
        (!query.get('search') || item.name.includes(query.get('search')!)),
    );
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, nextCursor: null } }),
    });
  });
  await page.goto(
    `/services?projectId=${s5Ids.project}&clusterId=${s5Ids.cluster}&serviceSearch=长服务`,
  );
  const search = page.getByLabel('搜索服务', { exact: true });
  await expect(search).toHaveValue('长服务');
  await expect(page.getByLabel('所属项目', { exact: true })).toHaveValue(s5Ids.project);
  await expect(page.getByLabel('承载集群', { exact: true })).toHaveValue(s5Ids.cluster);
  await expect(page.locator('.service-row')).toHaveCount(1);
  await page.getByRole('link', { name: `打开服务 ${service.name}`, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: service.name, exact: true, level: 1 }),
  ).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue('长服务');
  await page.reload();
  await expect(search).toHaveValue('长服务');
  await expect(page.getByLabel('所属项目', { exact: true })).toHaveValue(s5Ids.project);
  await expect(page.getByLabel('承载集群', { exact: true })).toHaveValue(s5Ids.cluster);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.service-row .service-name')).toHaveAttribute('title', service.name);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  expect(state.core.writes).toHaveLength(0);
});

test('带搜索的服务深链清空时，慢读取失败不移除输入框或焦点', async ({ page }) => {
  const state = await installCreationFixture(page);
  track(page, state.core.unexpected);
  const term = state.core.services[0]!.name;
  let fullReads = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/services?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const query = new URL(route.request().url()).searchParams;
    state.core.reads.push({ path: '/services', query: Object.fromEntries(query) });
    const search = query.get('search');
    if (!search) {
      fullReads++;
      await waiting;
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'FULL_SERVICE_LIST_REJECTED',
          detail: '全量服务列表暂时不能读取。',
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: state.core.services.filter((service) => service.name.includes(search)),
        page: { hasMore: false, nextCursor: null },
      }),
    });
  });
  try {
    await page.goto(`/services?serviceSearch=${encodeURIComponent(term)}`);
    const search = page.getByLabel('搜索服务', { exact: true });
    await expect(search).toHaveValue(term);
    await expect(page.locator('.service-row')).toHaveCount(1);
    const originalInput = await search.elementHandle();
    expect(originalInput).not.toBeNull();
    await search.fill('');
    await expect(page).toHaveURL(/\/services$/);
    await expect.poll(() => fullReads).toBe(1);
    await expect(page.getByRole('status', { name: '正在载入', exact: true })).toBeVisible();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);
    release();
    await expect(page.getByRole('alert')).toContainText('全量服务列表暂时不能读取。');
    await expect(search).toBeEditable();
    await expect(search).toBeFocused();
    expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);
    await search.fill(term);
    await expect(page.locator('.service-row')).toHaveCount(1);
    await expect(search).toBeFocused();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(state.core.writes).toHaveLength(0);
  } finally {
    release();
  }
});

test('退出动画内通过历史重开服务面板，再次关闭仍回到原入口', async ({ page }) => {
  const state = await installImageWorkspaceFixture(page);
  track(page, state.unexpected);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(state.pathFor('overview'));
  const trigger = page.getByRole('link', { name: '部署记录', exact: true }).first();
  await trigger.click();
  const panel = page.locator('.service-workspace-panel');
  await expect(panel).toHaveAttribute('data-state', 'open');
  const delay = await page.addStyleTag({
    content:
      '.service-workspace-panel[data-state="closed"], .dialog-overlay[data-state="closed"] { animation-duration: 1s !important; }',
  });
  // Back keeps the panel entry in forward history, allowing a real popstate reopen.
  await page.goBack();
  const closing = page.locator('.service-workspace-panel[data-state="closed"]');
  await expect(closing).toHaveAttribute('inert', '');
  await expect(closing.locator('.workspace-panel-body')).not.toBeEmpty();
  await page.goForward();
  await expect(panel).toHaveAttribute('data-state', 'open');
  await expect(panel).not.toHaveAttribute('inert');
  await expect(page).toHaveURL(/tab=deployments/);
  await delay.evaluate((element) => element.parentNode?.removeChild(element));
  await panel.getByRole('button', { name: '返回服务', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.writes).toHaveLength(0);
});

test('直接打开创建服务深链，关闭后焦点回到主内容', async ({ page }) => {
  const state = await installCreationFixture(page);
  track(page, state.core.unexpected);
  await page.goto(`/projects/${s5Ids.project}?environment=staging&createService=1`);
  const dialog = page.getByRole('dialog', { name: '添加服务', exact: true });
  await expect(dialog.locator('.source-option').first()).toBeFocused();
  await dialog.getByRole('button', { name: '关闭添加服务', exact: true }).click();
  await expect(page.locator('.creation-dialog')).toHaveCount(0);
  await expect(page.locator('#main-content')).toBeFocused();
  expect(state.core.writes).toHaveLength(0);
});
