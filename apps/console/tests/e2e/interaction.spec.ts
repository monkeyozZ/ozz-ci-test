import { test, expect } from '@playwright/test';
import { api, baseURL, login, removeIfPresent, suffix } from './helpers';

test('中文输入、命令面板、未保存保护与主题保持', async ({ page }) => {
  await login(page);
  await page.goto('/servers/new');
  await page.getByLabel('服务器名称', { exact: true }).fill('中文输入保留测试');
  await page.getByRole('link', { name: '项目', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '离开前保留当前编辑？' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/\/servers\/new$/);
  await expect(page.getByRole('link', { name: '项目', exact: true })).toBeFocused();
  await expect(page.getByLabel('服务器名称', { exact: true })).toHaveValue('中文输入保留测试');
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveClass('dark');
  await expect(page.getByLabel('服务器名称', { exact: true })).toHaveValue('中文输入保留测试');
  await page.getByRole('link', { name: '项目', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '放弃修改并离开', exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass('dark');
  await expect(page.getByRole('heading', { name: '我的项目', level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: '搜索资源或操作', exact: true });
  await expect(input).toBeFocused();
  await input.dispatchEvent('compositionstart');
  await input.fill('登记集群');
  await input.press('Escape');
  await expect(page.getByRole('dialog', { name: '快速打开', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(page).toHaveURL(/\/projects$/);
  await input.dispatchEvent('compositionend');
  await expect(page.getByRole('option', { name: /登记集群/ })).toBeVisible();
  await input.press('Enter');
  await expect(page).toHaveURL(/\/clusters\/new$/);
  const commandTrigger = page.getByRole('button', { name: '快速打开项目与资源', exact: true });
  await commandTrigger.focus();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: '快速打开', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '快速打开', exact: true })).toHaveCount(0);
  await expect(commandTrigger).toBeFocused();
  await page.getByRole('button', { name: '退出当前会话', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  const unauthenticated = await page.request.get('/api/projects');
  expect(unauthenticated.status()).toBe(401);
});

test('窄屏、紧凑桌面、宽屏及 200% 文字缩放保持可操作', async ({ page }, testInfo) => {
  await login(page);
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    await page.locator('.skeleton').first().waitFor({ state: 'hidden' });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`projects-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    if (width === 390) {
      const menu = page.getByRole('button', { name: '打开导航', exact: true });
      await menu.click();
      const drawer = page.getByRole('dialog', { name: '工作台导航', exact: true });
      await expect(drawer).toBeVisible();
      await drawer.getByRole('link', { name: '基础设施', exact: true }).click();
      await expect(page.getByRole('heading', { name: '基础设施', exact: true })).toBeVisible();
      await expect(drawer).toHaveCount(0);
      await page.goto('/projects');
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath('projects-text-200-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
});

test('切换项目后，迟到响应不能覆盖新的项目与继承目标', async ({ page }) => {
  await login(page);
  const tag = suffix();
  let clusterA: { id: string } | undefined;
  let clusterB: { id: string } | undefined;
  let projectA: { id: string; name: string } | undefined;
  let projectB: { id: string; name: string } | undefined;
  try {
    clusterA = await api(page.request, '/clusters', 'POST', { name: `A-${tag}`, slug: `a-${tag}` });
    clusterB = await api(page.request, '/clusters', 'POST', { name: `B-${tag}`, slug: `b-${tag}` });
    projectA = await api(page.request, '/projects', 'POST', {
      name: `旧项目-${tag}`,
      slug: `a-${tag}`,
      clusterId: clusterA!.id,
    });
    projectB = await api(page.request, '/projects', 'POST', {
      name: `新项目-${tag}`,
      slug: `b-${tag}`,
      clusterId: clusterB!.id,
    });
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: projectA!.name, exact: true })).toBeVisible();
    let delayed = false;
    await page.route(`**/api/projects/${projectA!.id}`, async (route) => {
      const response = await route.fetch();
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.getByRole('heading', { name: projectA!.name, exact: true }).click();
    await expect.poll(() => delayed).toBe(true);
    await page.getByRole('link', { name: '返回项目列表', exact: true }).click();
    await page.getByRole('heading', { name: projectB!.name, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: projectB!.name, exact: true, level: 1 }),
    ).toBeVisible();
    await page.waitForTimeout(1700);
    await expect(
      page.getByRole('heading', { name: projectB!.name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.locator('#main-content')).toContainText(`B-${tag}`);
    await expect(page.locator('#main-content')).not.toContainText(`A-${tag}`);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await removeIfPresent(page.request, 'projects', projectA?.id);
    await removeIfPresent(page.request, 'projects', projectB?.id);
    await removeIfPresent(page.request, 'clusters', clusterA?.id);
    await removeIfPresent(page.request, 'clusters', clusterB?.id);
  }
});

test('会话撤销后返回登录，重新认证不重放写操作', async ({ page }) => {
  await login(page);
  const me = (await (await page.request.get('/api/auth/me')).json()).data;
  const logout = await page.request.post('/api/auth/logout', {
    headers: { Origin: baseURL, 'X-CSRF-Token': me.csrfToken },
  });
  expect(logout.status()).toBe(204);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && !request.url().endsWith('/api/auth/login')) writes++;
  });
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?.*expired=1/);
  await expect(page.getByText(/会话已过期/)).toBeVisible();
  await login(page);
  expect(writes).toBe(0);
});
