import { expect, test, type Page } from '@playwright/test';
import { installCreationFixture } from './creation-v3-fixture';
import { s5Ids } from '../fixtures/s5-data';

const projectPath = `/projects/${s5Ids.project}?environment=staging`;
const createPath = `${projectPath}&createService=1`;
const dialog = (page: Page) => page.getByRole('dialog', { name: '添加服务', exact: true });
type State = Awaited<ReturnType<typeof installCreationFixture>>;
const runs = new WeakMap<Page, { state: State; errors: string[] }>();
async function fixture(page: Page) {
  const state = await installCreationFixture(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { state, errors });
  return state;
}
test.afterEach(async ({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors).toEqual([]);
    expect(run.state.core.unexpected).toEqual([]);
  }
});
async function enterImage(page: Page, name = '镜像体验服务') {
  await dialog(page)
    .getByRole('link', { name: /部署 Docker 镜像/ })
    .click();
  await dialog(page).getByLabel('服务名称', { exact: true }).fill(name);
  await dialog(page).getByLabel('镜像地址', { exact: true }).fill('nginx:1.28.0-alpine');
}

test('项目背景保持：四个来源可选、键盘与连续返回保留独立草稿', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${projectPath}&tab=settings`);
  await page.getByLabel('项目名称', { exact: true }).fill('背景项目草稿');
  await page.locator('.app-sidebar').getByRole('link', { name: '添加服务', exact: true }).click();
  await expect(dialog(page).locator('.source-option')).toHaveCount(4);
  await expect(page).toHaveURL(/tab=settings.*createService=1/);
  const options = dialog(page).locator('.source-option');
  await options.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await dialog(page).getByLabel('服务名称', { exact: true }).fill('镜像草稿');
  await dialog(page).getByLabel('镜像地址', { exact: true }).fill('nginx:1.28.0-alpine');
  await page.keyboard.press('Escape');
  await dialog(page)
    .getByRole('link', { name: /从 GitHub 部署/ })
    .click();
  await dialog(page).getByLabel('服务名称', { exact: true }).fill('Git 草稿');
  await dialog(page).getByRole('link', { name: '选择来源', exact: true }).click();
  await dialog(page)
    .getByRole('link', { name: /部署 Docker 镜像/ })
    .click();
  await expect(dialog(page).getByLabel('服务名称', { exact: true })).toHaveValue('镜像草稿');
  await expect(dialog(page).getByLabel('镜像地址', { exact: true })).toHaveValue(
    'nginx:1.28.0-alpine',
  );
  await dialog(page).getByRole('button', { name: '关闭添加服务', exact: true }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: '离开前保留当前编辑？' });
  await expect(confirm).toContainText('服务配置');
  await expect(confirm).not.toContainText('项目资料有尚未保存');
  await confirm.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('背景项目草稿');
  expect(state.core.writes).toEqual([]);
});

test('模板分类保留全部五种模板，未内置数据库不混入目录', async ({ page }) => {
  await fixture(page);
  await page.goto(createPath);
  await dialog(page)
    .getByRole('link', { name: /添加数据库/ })
    .click();
  await expect(dialog(page).locator('[data-template-gallery] article')).toHaveCount(2);
  await expect(dialog(page)).toContainText('PostgreSQL');
  await expect(dialog(page)).toContainText('Redis');
  await expect(dialog(page)).not.toContainText('MySQL');
  await dialog(page).getByRole('link', { name: '选择来源', exact: true }).click();
  await dialog(page)
    .getByRole('link', { name: /使用应用模板/ })
    .click();
  await expect(dialog(page).locator('[data-template-gallery] article')).toHaveCount(3);
  await dialog(page).getByRole('link', { name: '使用 Node.js 示例 模板', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: '配置 Node.js 示例' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page).getByLabel('模板类别')).toHaveValue('application');
});

test('镜像来源保存后留在弹窗，编辑与刷新复用同一服务', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(createPath);
  await enterImage(page);
  await dialog(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`createdService=${s5Ids.createdService}`));
  await expect(dialog(page).locator('[data-deployment-review]')).toBeVisible();
  expect(state.core.writes.filter((entry) => entry.path === '/services')).toHaveLength(1);
  expect(state.core.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
  await dialog(page).getByRole('button', { name: '返回配置', exact: true }).click();
  await dialog(page).getByLabel('服务名称', { exact: true }).fill('已修改镜像服务');
  await dialog(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
  await expect(dialog(page).locator('[data-deployment-review]')).toBeVisible();
  expect(
    state.core.writes.filter(
      (entry) => entry.path === `/services/${s5Ids.createdService}` && entry.method === 'PATCH',
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(dialog(page).locator('[data-deployment-review]')).toBeVisible();
  await dialog(page).getByRole('button', { name: '返回配置', exact: true }).click();
  await expect(dialog(page).getByLabel('服务名称', { exact: true })).toHaveValue('已修改镜像服务');
  expect(state.core.writes.filter((entry) => entry.path === '/services')).toHaveLength(1);
});

test('请求进行中与响应丢失都不能返回来源；重试保持原请求和幂等键', async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.beforeImageReply = () => waiting;
  state.imageReplyLoss = true;
  await page.goto(createPath);
  await enterImage(page);
  await dialog(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: '关闭添加服务' })).toBeDisabled();
  await dialog(page).getByRole('link', { name: '管理凭证', exact: true }).click();
  await expect(page).toHaveURL(/createService=1&source=image/);
  await page.keyboard.press('Escape');
  await expect(
    dialog(page).getByRole('heading', { name: '部署 Docker 镜像', exact: true }),
  ).toBeVisible();
  release();
  await expect(dialog(page).getByRole('button', { name: '重试确认保存结果' })).toBeEnabled();
  await expect(dialog(page).getByLabel('服务名称', { exact: true })).toBeDisabled();
  await dialog(page).getByRole('link', { name: '管理凭证', exact: true }).click();
  await expect(page).toHaveURL(/createService=1&source=image/);
  await page.keyboard.press('Meta+k');
  const command = page.getByRole('dialog', { name: '快速打开', exact: true });
  await command.getByLabel('搜索资源或操作', { exact: true }).fill('创建项目');
  await command.getByRole('option', { name: /创建项目/ }).click();
  await expect(dialog(page).getByRole('button', { name: '重试确认保存结果' })).toBeVisible();
  await page.goBack();
  await expect(dialog(page).getByRole('button', { name: '重试确认保存结果' })).toBeVisible();
  await dialog(page).getByRole('button', { name: '重试确认保存结果' }).click();
  await expect(dialog(page).locator('[data-deployment-review]')).toBeVisible();
  const saves = state.core.writes.filter((entry) => entry.path === '/services');
  expect(saves).toHaveLength(2);
  expect(saves[1]!.key).toBe(saves[0]!.key);
  expect(saves[1]!.body).toEqual(saves[0]!.body);
  expect(state.core.services.filter((service) => service.id === s5Ids.createdService)).toHaveLength(
    1,
  );
});

test('已有创建结果返回来源后继续原服务，不发第二次创建', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(createPath);
  await enterImage(page);
  await dialog(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
  await expect(dialog(page).locator('[data-deployment-review]')).toBeVisible();
  await page.goBack();
  await expect(dialog(page).locator('.source-option')).toHaveCount(4);
  await dialog(page)
    .getByRole('link', { name: /部署 Docker 镜像/ })
    .click();
  await expect(dialog(page).locator('[data-deployment-review]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`createdService=${s5Ids.createdService}`));
  expect(state.core.writes.filter((entry) => entry.path === '/services')).toHaveLength(1);
});

test('单目标项目名称可选，创建回复丢失时继续同一次创建', async ({ page }) => {
  const state = await fixture(page);
  state.projectReplyLoss = true;
  await page.goto('/projects/new');
  const submit = page.getByRole('button', { name: '创建项目', exact: true });
  await expect(page.getByRole('radio')).toBeChecked();
  await submit.click();
  await expect(page.getByRole('button', { name: '重试确认创建结果', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重试确认创建结果', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: '添加第一个服务' })).toBeVisible();
  const writes = state.core.writes.filter((entry) => entry.path === '/projects');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.key).toBe(writes[0]!.key);
  expect(writes[1]!.body).toEqual(writes[0]!.body);
  expect(writes[0]!.body).toMatchObject({
    name: expect.stringMatching(/^新项目 /),
    slug: expect.stringMatching(/^[a-z][a-z0-9-]{0,62}$/),
    clusterId: s5Ids.cluster,
  });
});

test('单环境隐藏选择，分页多环境准确定位，错误环境不回落创建', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(createPath);
  await expect(dialog(page).locator('.source-option')).toHaveCount(4);
  await expect(page.locator('.app-sidebar select')).toHaveCount(0);
  state.environmentPageSize = 1;
  state.environments.unshift({
    ...state.environments[0]!,
    id: '51000000-0000-4000-8000-000000000042',
    name: 'Production',
    slug: 'production',
  });
  await page.reload();
  await expect(dialog(page).locator('.source-option')).toHaveCount(4);
  await expect(page.locator('.app-sidebar select')).toHaveValue('staging');
  expect(
    state.core.reads.some((read) => read.path === '/environments' && read.query.cursor === '1'),
  ).toBe(true);
  await page.goto(`/projects/${s5Ids.project}?environment=missing&createService=1&source=image`);
  await expect(dialog(page)).toContainText('所选环境不属于当前项目');
  await expect(dialog(page).getByRole('button', { name: '核对部署配置', exact: true })).toHaveCount(
    0,
  );
  expect(state.core.writes).toEqual([]);
});

test('390px 添加服务全屏、源选择和配置无横向溢出', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(createPath);
  await expect(dialog(page).locator('.source-option')).toHaveCount(4);
  const sourceBox = await dialog(page).boundingBox();
  expect(sourceBox?.width).toBe(390);
  await enterImage(page);
  await expect(dialog(page).getByLabel('容器端口', { exact: true })).toBeVisible();
  expect(
    await dialog(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
});

test('项目卡片首次及缓存后再次打开，都直接进入所属服务', async ({ page }) => {
  const state = await fixture(page);
  state.environments[0] = {
    ...state.environments[0]!,
    slug: 'production',
    name: 'Production',
    isDefault: true,
  };
  for (const service of state.core.services)
    service.environment = { ...service.environment, slug: 'production', name: 'Production' };
  await page.goto('/projects');
  await page.locator('.project-card').first().click();
  await expect(page).toHaveURL(new RegExp(`/services/${s5Ids.service}\\?environment=production`));
  await page.locator('.app-sidebar').getByRole('link', { name: '所有项目', exact: true }).click();
  await page.locator('.project-card').first().click();
  await expect(page).toHaveURL(new RegExp(`/services/${s5Ids.service}\\?environment=production`));
  expect(state.core.writes).toEqual([]);
});

for (const damage of ['json', 'envelope', 'service'] as const) {
  test(`201 响应损坏（${damage}）保留未知创建，原请求重试不会重复服务`, async ({ page }) => {
    const state = await fixture(page);
    state.imageReplyDamage = damage;
    await page.goto(createPath);
    await enterImage(page);
    await dialog(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
    await expect(dialog(page).getByRole('button', { name: '重试确认保存结果' })).toBeEnabled();
    await expect(dialog(page).getByLabel('服务名称', { exact: true })).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: '关闭添加服务' })).toBeDisabled();
    await dialog(page).getByRole('button', { name: '重试确认保存结果' }).click();
    await expect(dialog(page).locator('[data-deployment-review]')).toBeVisible();
    const saves = state.core.writes.filter((entry) => entry.path === '/services');
    expect(saves).toHaveLength(2);
    expect(saves[1]!.key).toBe(saves[0]!.key);
    expect(saves[1]!.body).toEqual(saves[0]!.body);
    expect(
      state.core.services.filter((service) => service.id === s5Ids.createdService),
    ).toHaveLength(1);
  });
}

test('项目入口等待过期服务缓存更新，已删除的首服务不会被重新打开', async ({ page }) => {
  const state = await fixture(page);
  await page.clock.install();
  state.environments[0] = {
    ...state.environments[0]!,
    slug: 'production',
    name: 'Production',
    isDefault: true,
  };
  for (const service of state.core.services)
    service.environment = { ...service.environment, slug: 'production', name: 'Production' };
  await page.goto('/projects');
  await page.locator('.project-card').first().click();
  await expect(page).toHaveURL(new RegExp(`/services/${s5Ids.service}\\?`));
  await page.locator('.app-sidebar').getByRole('link', { name: '所有项目', exact: true }).click();
  state.core.services.splice(0, 1);
  await page.clock.fastForward(16_000);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/services?*', async (route) => {
    await waiting;
    await route.fallback();
  });
  await page.locator('.project-card').first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${s5Ids.project}\\?openService=1`));
  release();
  await expect(page).toHaveURL(
    new RegExp(`/services/${s5Ids.databaseService}\\?environment=production`),
  );
  expect(state.core.unexpected).toEqual([]);
});

test('创建弹窗确认发布后离开忙碌保护并进入唯一部署任务', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(createPath);
  await enterImage(page);
  await dialog(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
  const review = dialog(page).locator('[data-deployment-review]');
  await expect(review.getByRole('button', { name: '确认发布', exact: true })).toBeEnabled();
  await review.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]{36}$/);
  expect(
    state.core.writes.filter(
      (entry) => entry.path === `/services/${s5Ids.createdService}/deployments`,
    ),
  ).toHaveLength(1);
  expect(state.core.writes.filter((entry) => entry.path === '/services')).toHaveLength(1);
});
