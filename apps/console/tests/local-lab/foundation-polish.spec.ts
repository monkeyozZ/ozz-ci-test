import { errors, expect, test, type Page } from '@playwright/test';
import { installCreationFixture } from './creation-v3-fixture';
import { installImageWorkspaceFixture } from './service-workspace-v3-fixture';
import { s5Ids } from '../fixtures/s5-data';

const runs = new WeakMap<Page, { errors: string[]; unexpected: string[] }>();
function track(page: Page, unexpected: string[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { errors, unexpected });
}
async function fixture(page: Page) {
  const state = await installCreationFixture(page);
  track(page, state.core.unexpected);
  return state;
}
test.afterEach(({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors, '浏览器脚本错误').toEqual([]);
    expect(run.unexpected, '未声明的 API 请求').toEqual([]);
  }
});

test('忙碌服务的禁用链接不响应点击、中键和 Enter，其余六页签继续可用', async ({ page }) => {
  const state = await installImageWorkspaceFixture(page);
  track(page, state.unexpected);
  state.service.activeTask = {
    id: state.deployments[0]!.id,
    type: 'deployment',
    status: 'running',
    kind: 'deploy',
  };
  await page.goto(state.pathFor('overview'));
  const deploy = page.locator('[data-service-deploy]');
  await expect(deploy).toHaveAttribute('aria-disabled', 'true');
  await expect(deploy).toHaveAttribute('tabindex', '-1');
  const location = page.url();
  await deploy.click({ force: true });
  await expect(page).toHaveURL(location);
  const popupAttempt = page.waitForEvent('popup', { timeout: 500 }).catch((error: unknown) => {
    if (error instanceof errors.TimeoutError) return null;
    throw error;
  });
  await deploy.click({ button: 'middle', force: true });
  const popup = await popupAttempt;
  if (popup) await popup.close();
  expect(popup, '禁用链接的中键不应打开新标签页').toBeNull();
  await deploy.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(location);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const tabs = page.getByRole('navigation', { name: '服务页面', exact: true });
  await expect(tabs.getByRole('link')).toHaveCount(6);
  await tabs.getByRole('link', { name: '环境变量', exact: true }).click();
  await expect(tabs.getByRole('link', { name: '环境变量', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(deploy).toHaveAttribute('aria-disabled', 'true');
  expect(state.writes).toHaveLength(0);
});

for (const resource of [
  { name: '项目', path: '/projects', rows: '.project-card' },
  { name: '服务', path: '/services', rows: '.service-row' },
]) {
  test(`${resource.name}初次载入先显示加载，失败时不冒充空列表，重试恢复内容`, async ({ page }) => {
    await fixture(page);
    let fail = true;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api${resource.path}?**`, async (route) => {
      if (!fail) return route.fallback();
      await waiting;
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 403,
          code: 'FIXTURE_READ_DENIED',
          detail: `${resource.name}列表暂时不能读取。`,
          requestId: 'foundation-controlled-read',
        }),
      });
    });
    try {
      await page.goto(resource.path);
      await expect(page.getByRole('status', { name: '正在载入', exact: true })).toBeVisible();
      await expect(page.locator('.empty-state')).toHaveCount(0);
      release();
      const error = page.getByRole('alert').filter({ hasText: '没有载入最新数据' });
      await expect(error).toContainText(`${resource.name}列表暂时不能读取。`);
      await expect(page.locator('.empty-state')).toHaveCount(0);
      await expect(page.locator(resource.rows)).toHaveCount(0);
      fail = false;
      await error.getByRole('button', { name: '重新载入', exact: true }).click();
      await expect(page.locator(resource.rows).first()).toBeVisible();
      await expect(error).toHaveCount(0);
    } finally {
      release();
    }
  });
}

test('项目后台刷新保持内容与位置，更新失败仍保留已载入项目', async ({ page }) => {
  const state = await fixture(page);
  const base = state.projects[0]!;
  for (let index = 1; index <= 18; index++) {
    state.projects.push({
      ...base,
      id: `63000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `基础验证项目 ${String(index).padStart(2, '0')}`,
      slug: `foundation-project-${index}`,
    });
  }
  await page.goto('/projects');
  const rows = page.locator('.project-card');
  await expect(rows).toHaveCount(state.projects.length);
  const initialTop = await rows.first().evaluate((element) => element.getBoundingClientRect().top);
  let fail = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects?**', async (route) => {
    await waiting;
    if (!fail) return route.fallback();
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ status: 403, detail: '最新项目列表读取失败。' }),
    });
  });
  try {
    await page.getByRole('button', { name: '刷新项目', exact: true }).click();
    await expect(page.getByText('正在更新，保留当前内容', { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(state.projects.length);
    await expect(page.locator('#main-content .skeleton')).toHaveCount(0);
    const pendingTop = await rows
      .first()
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(pendingTop - initialTop)).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.scrollTo(0, 500));
    const position = await page.evaluate(() => window.scrollY);
    expect(position).toBeGreaterThan(0);
    state.projects[0]!.name = '后台更新后的项目';
    release();
    await expect(page.getByText('正在更新，保留当前内容', { exact: true })).toHaveCount(0);
    await expect(rows.first()).toContainText('后台更新后的项目');
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - position)).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    const updatedTop = await rows
      .first()
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(updatedTop - initialTop)).toBeLessThanOrEqual(1);
    fail = true;
    await page.getByRole('button', { name: '刷新项目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('最新项目列表读取失败。');
    await expect(rows).toHaveCount(state.projects.length);
    await expect(rows.first()).toContainText('后台更新后的项目');
    await expect(page.locator('.empty-state')).toHaveCount(0);
  } finally {
    release();
  }
});

test('离线仍能查看已载入服务，新搜索等待联网后自动继续', async ({ page, context }) => {
  const state = await fixture(page);
  await page.goto('/services');
  await expect(page.locator('.service-row')).toHaveCount(state.core.services.length);
  try {
    await context.setOffline(true);
    await expect(page.getByText('网络连接已断开', { exact: true })).toBeVisible();
    await expect(page.locator('.service-row')).toHaveCount(state.core.services.length);
    const before = state.core.reads.filter((entry) => entry.path === '/services').length;
    await page.getByLabel('搜索服务', { exact: true }).fill('offline-resume');
    await expect(page.getByText('等待网络恢复', { exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: '正在载入', exact: true })).toHaveCount(0);
    expect(state.core.reads.filter((entry) => entry.path === '/services')).toHaveLength(before);
    await context.setOffline(false);
    await expect(page.getByText('网络连接已断开', { exact: true })).toHaveCount(0);
    await expect(page.getByText('等待网络恢复', { exact: true })).toHaveCount(0);
    await expect(page.locator('.service-row')).toHaveCount(state.core.services.length);
    await expect
      .poll(() => state.core.reads.filter((entry) => entry.path === '/services').length)
      .toBeGreaterThan(before);
  } finally {
    await context.setOffline(false);
  }
});

test('初始离线平台信号暂停项目请求，online 事件后自动载入（受控事件）', async ({ page }) => {
  // This controls the browser signal only. It verifies the UI/query wiring,
  // without claiming a real network outage or changing the machine's network.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  const state = await fixture(page);
  await page.goto('/projects');
  await expect(page.getByText('网络连接已断开', { exact: true })).toBeVisible();
  await expect(page.getByText('等待网络恢复', { exact: true })).toBeVisible();
  await expect(page.locator('.project-card')).toHaveCount(0);
  expect(state.core.reads.filter((entry) => entry.path === '/projects')).toHaveLength(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByText('网络连接已断开', { exact: true })).toHaveCount(0);
  await expect(page.getByText('等待网络恢复', { exact: true })).toHaveCount(0);
  await expect(page.locator('.project-card')).toHaveCount(state.projects.length);
  expect(state.core.reads.filter((entry) => entry.path === '/projects')).toHaveLength(1);
});

test('快速打开聚焦搜索，中文输入时 Esc 不关闭，正常 Esc 与遮罩关闭后恢复焦点', async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.goto('/projects');
  const trigger = page.getByRole('button', { name: '快速打开项目与资源', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '快速打开', exact: true });
  const input = dialog.getByLabel('搜索资源或操作', { exact: true });
  await expect(input).toBeFocused();
  await input.dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await input.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  expect(
    await page
      .locator('.dialog-content[data-state="closed"]')
      .evaluateAll((elements) => elements.every((element) => element.hasAttribute('inert'))),
  ).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(input).toBeFocused();
  const snapshotOverlay = () =>
    page.evaluate(() => {
      function describe(element: Element | null) {
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          class: element.getAttribute('class'),
          style: element.getAttribute('style'),
          attributes: Object.fromEntries(
            [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
          ),
          computed: {
            pointerEvents: style.pointerEvents,
            zIndex: style.zIndex,
            opacity: style.opacity,
            display: style.display,
            visibility: style.visibility,
            transform: style.transform,
            animationName: style.animationName,
            animationDuration: style.animationDuration,
          },
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }
      const target = document.elementFromPoint(8, 8);
      return {
        target: describe(target),
        parent: describe(target?.parentElement ?? null),
        activeElement: describe(document.activeElement),
        layers: [...document.querySelectorAll('.dialog-content, .dialog-overlay')].map(describe),
        bodyStyle: document.body.getAttribute('style'),
      };
    });
  const before = await snapshotOverlay();
  await page.mouse.click(8, 8);
  const after = await snapshotOverlay();
  await testInfo.attach('command-overlay-hit-test', {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: 'application/json',
  });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('来源与配置返回保留草稿，叠加离开确认优先取消并恢复正确焦点', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/projects/${s5Ids.project}?environment=staging`);
  const trigger = page.locator('.app-sidebar').getByRole('link', { name: '添加服务', exact: true });
  await trigger.click();
  const creation = page.locator('.creation-dialog');
  await expect(creation.locator('.source-option')).toHaveCount(4);
  await creation.getByRole('link', { name: /部署 Docker 镜像/ }).click();
  await creation.getByLabel('服务名称', { exact: true }).fill('保留在原型流程里的草稿');
  await creation.getByLabel('镜像地址', { exact: true }).fill('nginx:1.28.0-alpine');
  await page.keyboard.press('Escape');
  await expect(creation.locator('.source-option')).toHaveCount(4);
  await creation.getByRole('link', { name: /部署 Docker 镜像/ }).click();
  await expect(creation.getByLabel('服务名称', { exact: true })).toHaveValue(
    '保留在原型流程里的草稿',
  );
  const close = creation.getByRole('button', { name: '关闭添加服务', exact: true });
  await close.click();
  const confirmation = page.getByRole('dialog', { name: '离开前保留当前编辑？', exact: true });
  const cancel = confirmation.getByRole('button', { name: '取消', exact: true });
  await expect(cancel).toBeFocused();
  const box = await cancel.boundingBox();
  expect(box).toBeTruthy();
  expect(
    await confirmation.evaluate(
      (element, point) => {
        const target = document.elementFromPoint(point.x, point.y);
        return target !== null && element.contains(target);
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(close).toBeFocused();
  await expect(creation.getByLabel('服务名称', { exact: true })).toHaveValue(
    '保留在原型流程里的草稿',
  );
  await close.click();
  await expect(cancel).toBeFocused();
  await confirmation.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(creation).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.core.writes).toHaveLength(0);
});

test('减少动效偏好缩短弹层与菜单过渡，菜单关闭后仍可继续键盘操作', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page);
  await page.goto('/projects');
  const theme = page.getByRole('button', { name: '选择外观主题', exact: true });
  await theme.click();
  await expect(page.getByRole('menu')).toBeVisible();
  const menuMotion = await page.locator('.theme-menu').evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.animationDuration, style.transitionDuration].flatMap((value) =>
      value
        .split(',')
        .map((duration) => parseFloat(duration) * (duration.trim().endsWith('ms') ? 1 : 1000)),
    );
  });
  expect(Math.max(...menuMotion)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  expect(
    await page
      .locator('.theme-menu[data-state="closed"]')
      .evaluateAll((elements) => elements.every((element) => element.hasAttribute('inert'))),
  ).toBe(true);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(theme).toBeFocused();
  const trigger = page.getByRole('button', { name: '快速打开项目与资源', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '快速打开', exact: true });
  await expect(dialog.getByLabel('搜索资源或操作', { exact: true })).toBeFocused();
  const dialogMotion = await page
    .locator('.dialog-content, .dialog-overlay')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const style = getComputedStyle(element);
        return [style.animationDuration, style.transitionDuration].flatMap((value) =>
          value
            .split(',')
            .map((duration) => parseFloat(duration) * (duration.trim().endsWith('ms') ? 1 : 1000)),
        );
      }),
    );
  expect(Math.max(...dialogMotion)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
