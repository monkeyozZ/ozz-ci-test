import { expect, test, type Page } from '@playwright/test';
import { installCreationFixture } from './creation-v3-fixture';
import { s5Ids } from '../fixtures/s5-data';

const runs = new WeakMap<
  Page,
  { state: Awaited<ReturnType<typeof installCreationFixture>>; errors: string[] }
>();
async function fixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await installCreationFixture(page);
  runs.set(page, { state, errors });
  return state;
}
test.afterEach(({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors, '浏览器脚本错误').toEqual([]);
    expect(run.state.core.unexpected, '未声明的 API 请求').toEqual([]);
  }
});

async function tryCommandNavigation(page: Page) {
  await page.keyboard.press('Meta+k');
  const command = page.getByRole('dialog', { name: '快速打开', exact: true });
  await command.getByLabel('搜索资源或操作', { exact: true }).fill('登记集群');
  await command.getByRole('option', { name: /登记集群/ }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
}

async function dismissReloadPrompt(page: Page) {
  const dialog = page.waitForEvent('dialog');
  const reload = page.evaluate(() => window.location.reload());
  const prompt = await dialog;
  expect(prompt.type()).toBe('beforeunload');
  await prompt.dismiss();
  await reload;
  await expect(page).toHaveURL(/\/projects\/new$/);
}

test('默认项目提交中和结果未知时保护所有离开入口，重试仍是同一次创建', async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.beforeProjectReply = () => waiting;
  state.projectReplyLoss = true;
  let logoutRequests = 0;
  await page.route('**/api/auth/logout', async (route) => {
    logoutRequests++;
    await route.fulfill({ status: 204 });
  });
  try {
    await page.goto('/projects');
    await page.getByRole('link', { name: '创建项目', exact: true }).first().click();
    await expect(page.getByRole('radio')).toBeChecked();
    await expect(page.getByText('尚未保存', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect
      .poll(() => state.core.writes.filter((entry) => entry.path === '/projects').length)
      .toBe(1);
    await expect(page.getByRole('button', { name: '正在创建…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await page.getByRole('link', { name: '登记集群', exact: true }).click({ force: true });
    await expect(page).toHaveURL(/\/projects\/new$/);
    await page.locator('.app-sidebar').getByRole('link', { name: '服务器', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/new$/);
    await tryCommandNavigation(page);
    await page.getByRole('button', { name: '退出当前会话', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/new$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/projects\/new$/);
    await dismissReloadPrompt(page);
    release();
    const retry = page.getByRole('button', { name: '重试确认创建结果', exact: true });
    await expect(retry).toBeEnabled();
    await expect(page.getByLabel('项目名称', { exact: false })).toBeDisabled();
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await page.getByRole('link', { name: 'Ozz 项目工作台', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/new$/);
    await tryCommandNavigation(page);
    await page.getByRole('button', { name: '退出当前会话', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(logoutRequests).toBe(0);
    await retry.click();
    await expect(
      page
        .getByRole('dialog', { name: '添加服务', exact: true })
        .getByRole('heading', { name: '添加第一个服务', exact: true }),
    ).toBeVisible();
    const writes = state.core.writes.filter((entry) => entry.path === '/projects');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.key).toBe(writes[0]!.key);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(state.projects).toHaveLength(2);
    await page.getByRole('button', { name: '关闭添加服务', exact: true }).click();
    await page.locator('.app-sidebar').getByRole('link', { name: '所有项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  } finally {
    release();
  }
});

test('不完整的项目成功响应仍保留原请求，明确成功后才解除离开保护', async ({ page }) => {
  const state = await fixture(page);
  state.projectReplyDamage = true;
  await page.goto('/projects/new');
  await expect(page.getByRole('radio')).toBeChecked();
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  const retry = page.getByRole('button', { name: '重试确认创建结果', exact: true });
  await expect(retry).toBeEnabled();
  await page.getByRole('link', { name: 'Ozz 项目工作台', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
  await retry.click();
  await expect(page.getByRole('dialog', { name: '添加服务', exact: true })).toBeVisible();
  const writes = state.core.writes.filter((entry) => entry.path === '/projects');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.key).toBe(writes[0]!.key);
  expect(writes[1]!.body).toEqual(writes[0]!.body);
  expect(state.projects).toHaveLength(2);
});

test('项目创建期间会话失效仍进入登录页并释放旧表单保护', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await waiting;
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ status: 401, code: 'SESSION_EXPIRED', detail: '会话已过期。' }),
    });
  });
  try {
    await page.goto('/projects/new');
    await expect(page.getByRole('radio')).toBeChecked();
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    release();
    await expect(page).toHaveURL(/\/login\?.*expired=1/);
    await expect(page.getByRole('heading', { name: '进入你的工作台', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(false);
  } finally {
    release();
  }
});

async function projectListFixture(page: Page) {
  const state = await fixture(page);
  const base = state.projects[0]!;
  const environment = state.environments[0]!;
  for (let index = 0; index < 48; index++) {
    const id = `61000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const primary = index < 36;
    const clusterId = primary ? s5Ids.cluster : '61000000-0000-4000-8000-000000000099';
    state.projects.push({
      ...base,
      id,
      clusterId,
      cluster: { ...base.cluster!, id: clusterId, name: primary ? '主集群' : '备用集群' },
      name: `交互项目 ${String(index + 1).padStart(2, '0')}`,
      slug: `navigation-project-${index + 1}`,
    });
    state.environments.push({
      ...environment,
      id: `62000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      projectId: id,
      clusterId,
      slug: 'production',
      name: 'Production',
      isDefault: true,
    });
  }
  return state;
}

async function openFilteredProject(page: Page) {
  await page.getByLabel('搜索已载入项目', { exact: true }).fill('交互项目');
  await expect(page).toHaveURL(/search=/);
  await page.getByLabel('筛选承载目标', { exact: true }).selectOption(s5Ids.cluster);
  await expect(page.locator('.project-card')).toHaveCount(36);
  const card = page.locator('.project-card').filter({
    has: page.getByRole('heading', { name: '交互项目 28', exact: true }),
  });
  await card.scrollIntoViewIfNeeded();
  const position = await page.evaluate(() => window.scrollY);
  expect(position).toBeGreaterThan(0);
  const listUrl = page.url();
  await card.click();
  await expect(
    page.getByRole('heading', { name: '交互项目 28', exact: true, level: 1 }),
  ).toBeVisible();
  return { position, listUrl };
}

async function expectListContext(page: Page, position: number, listUrl: string) {
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByLabel('搜索已载入项目', { exact: true })).toHaveValue('交互项目');
  await expect(page.getByLabel('筛选承载目标', { exact: true })).toHaveValue(s5Ids.cluster);
  await expect(page.locator('.project-card')).toHaveCount(36);
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - position))
    .toBeLessThanOrEqual(2);
}

test('浏览器返回和所有项目入口恢复筛选与位置，刷新保留筛选且可以同时清空', async ({ page }) => {
  const state = await projectListFixture(page);
  await page.goto('/projects');
  const { position, listUrl } = await openFilteredProject(page);
  await page.goBack();
  await expectListContext(page, position, listUrl);
  await page
    .locator('.project-card')
    .filter({
      has: page.getByRole('heading', { name: '交互项目 28', exact: true }),
    })
    .click();
  await expect(
    page.getByRole('heading', { name: '交互项目 28', exact: true, level: 1 }),
  ).toBeVisible();
  await page.locator('.app-sidebar').getByRole('link', { name: '所有项目', exact: true }).click();
  await expectListContext(page, position, listUrl);
  await page.reload();
  await expect(page.getByLabel('搜索已载入项目', { exact: true })).toHaveValue('交互项目');
  await expect(page.getByLabel('筛选承载目标', { exact: true })).toHaveValue(s5Ids.cluster);
  await expect(page.locator('.project-card')).toHaveCount(36);
  await page.getByLabel('搜索已载入项目', { exact: true }).fill('不存在的项目');
  await page.getByRole('button', { name: '清空筛选', exact: true }).click();
  await expect(page.getByLabel('搜索已载入项目', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('筛选承载目标', { exact: true })).toHaveValue('');
  await expect(page.locator('.project-card')).toHaveCount(state.projects.length);
  expect(new URL(page.url()).search).toBe('');
});

test('详情页刷新后的浏览器返回等待项目列表载入，再恢复原阅读位置', async ({ page }) => {
  await projectListFixture(page);
  await page.goto('/projects');
  const { position, listUrl } = await openFilteredProject(page);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '交互项目 28', exact: true, level: 1 }),
  ).toBeVisible();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects?**', async (route) => {
    await waiting;
    await route.fallback();
  });
  try {
    await page.goBack();
    await expect(page).toHaveURL(listUrl);
    await expect(page.locator('.project-card')).toHaveCount(0);
    release();
    await expectListContext(page, position, listUrl);
  } finally {
    release();
  }
});
