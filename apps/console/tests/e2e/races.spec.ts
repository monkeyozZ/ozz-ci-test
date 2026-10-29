import { test, expect } from '@playwright/test';
import { api, baseURL, login, removeIfPresent, suffix } from './helpers';

test('同项目切换页签时，确认放弃会真正清除旧草稿', async ({ page }) => {
  await login(page);
  const tag = suffix();
  const cluster = await api(page.request, '/clusters', 'POST', { name: tag, slug: tag });
  const project = await api(page.request, '/projects', 'POST', {
    name: tag,
    slug: tag,
    clusterId: cluster.id,
  });
  try {
    await page.goto(`/projects/${project.id}?tab=settings`);
    await page.getByLabel('项目名称', { exact: true }).fill('应当放弃的中文草稿');
    await page
      .getByRole('navigation', { name: '项目设置页面', exact: true })
      .getByRole('link', { name: '环境管理', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '放弃修改并离开', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: '项目设置页面', exact: true })
      .getByRole('link', { name: '项目资料', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(tag);
  } finally {
    await removeIfPresent(page.request, 'projects', project.id);
    await removeIfPresent(page.request, 'clusters', cluster.id);
  }
});

test('离开提交中的表单后，迟到的成功响应不会强行跳回旧资源', async ({ page }) => {
  await login(page);
  const tag = suffix();
  let serverId: string | undefined;
  let responseReady = false;
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/servers', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    serverId = (await response.json()).data.id;
    responseReady = true;
    await responseGate;
    await route.fulfill({ response });
  });
  try {
    await page.goto('/servers/new');
    await page.getByLabel('服务器名称', { exact: true }).fill(tag);
    await page.getByLabel('地址 / IP', { exact: true }).fill('192.0.2.30');
    await page.getByLabel('SSH 用户', { exact: true }).fill('ubuntu');
    await page.getByRole('button', { name: '保存服务器登记', exact: true }).click();
    await expect.poll(() => responseReady).toBe(true);
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '项目', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '放弃修改并离开', exact: true })
      .click();
    await expect(page).toHaveURL(/\/projects$/);
    release();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/projects$/);
    expect((await api(page.request, `/servers/${serverId}`)).name).toBe(tag);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await removeIfPresent(page.request, 'servers', serverId);
  }
});

test('删除确认固定当时版本，后台刷新后的新版本必须重新审阅', async ({ page }) => {
  await login(page);
  const tag = suffix();
  const server = await api(page.request, '/servers', 'POST', {
    name: tag,
    host: '192.0.2.40',
    sshUser: 'ubuntu',
  });
  let release!: () => void;
  let intercepted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(`/servers/${server.id}`);
    await expect(page.getByLabel('服务器名称', { exact: true })).toHaveValue(tag);
    await page.route(`**/api/servers/${server.id}`, async (route) => {
      if (route.request().method() !== 'GET' || intercepted) return route.continue();
      intercepted = true;
      await gate;
      await route.fulfill({ response: await route.fetch() });
    });
    await page.getByRole('button', { name: '载入最新资料', exact: true }).click();
    await expect.poll(() => intercepted).toBe(true);
    await page.getByRole('button', { name: '移除服务器登记', exact: true }).click();
    await api(page.request, `/servers/${server.id}`, 'PATCH', {
      name: `${tag}-new`,
      revision: server.revision,
    });
    release();
    await expect(page.getByLabel('服务器名称', { exact: true })).toHaveValue(`${tag}-new`);
    await page.getByRole('dialog').getByRole('button', { name: '移除登记', exact: true }).click();
    await expect(page.locator('[data-mutation-error]')).toBeVisible();
    expect((await api(page.request, `/servers/${server.id}`)).name).toBe(`${tag}-new`);
  } finally {
    release?.();
    await page.unrouteAll({ behavior: 'wait' });
    await removeIfPresent(page.request, 'servers', server.id);
  }
});

test('会话失效会关闭旧删除确认，不在登录页保留资源上下文', async ({ page }) => {
  await login(page);
  const tag = suffix();
  const server = await api(page.request, '/servers', 'POST', {
    name: tag,
    host: '192.0.2.50',
    sshUser: 'ubuntu',
  });
  let release!: () => void;
  let intercepted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(`/servers/${server.id}`);
    await expect(page.getByLabel('服务器名称', { exact: true })).toHaveValue(tag);
    await page.route(`**/api/servers/${server.id}`, async (route) => {
      if (route.request().method() !== 'GET' || intercepted) return route.continue();
      intercepted = true;
      await gate;
      await route.fulfill({ response: await route.fetch() });
    });
    await page.getByRole('button', { name: '载入最新资料', exact: true }).click();
    await expect.poll(() => intercepted).toBe(true);
    await page.getByRole('button', { name: '移除服务器登记', exact: true }).click();
    const session = (await (await page.request.get('/api/auth/me')).json()).data;
    await page.request.post('/api/auth/logout', {
      headers: { Origin: baseURL, 'X-CSRF-Token': session.csrfToken },
    });
    release();
    await expect(page).toHaveURL(/\/login\?.*expired=1/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(tag);
    await page.unrouteAll({ behavior: 'wait' });
    await login(page);
  } finally {
    release?.();
    await page.unrouteAll({ behavior: 'wait' });
    await removeIfPresent(page.request, 'servers', server.id);
  }
});
