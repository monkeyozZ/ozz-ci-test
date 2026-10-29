import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { api, login, removeIfPresent, suffix } from './helpers';

test('服务器就地保存 SSH 密码凭证，未核对指纹前预检保持禁用', async ({ page }) => {
  await login(page, '/servers/new');
  const tag = suffix();
  let serverId: string | undefined;
  let secretId: string | undefined;
  try {
    await page.getByLabel('服务器名称', { exact: true }).fill(`主机-${tag}`);
    await page.getByLabel('地址 / IP', { exact: true }).fill('192.0.2.90');
    await page.getByLabel('SSH 用户', { exact: true }).fill('ubuntu');
    await page.getByRole('button', { name: '新增 SSH 凭证', exact: true }).click();
    await page.getByLabel('SSH 凭证名称', { exact: true }).fill(`凭证-${tag}`);
    await page.getByLabel('认证方式', { exact: true }).selectOption('password');
    await page.getByLabel('SSH 登录密码', { exact: true }).fill(`TEST-ONLY-${tag}`);
    await expect(page.getByRole('button', { name: '保存服务器登记', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '加密保存 SSH 凭证', exact: true }).click();
    await expect(page.getByLabel('SSH 登录密码', { exact: true })).toHaveCount(0);
    secretId = await page.getByLabel('SSH 凭证', { exact: false }).inputValue();
    expect(secretId).toMatch(/^[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: '保存服务器登记', exact: true }).click();
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);
    serverId = page.url().split('/').pop();
    await expect(page.getByRole('button', { name: '读取主机指纹', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '执行只读预检', exact: true })).toBeDisabled();
    expect((await api(page.request, `/servers/${serverId}`)).credentialRefId).toBe(secretId);
    const secret = await api(page.request, `/secrets/${secretId}`);
    expect(secret.payload).toBeUndefined();
    await page.reload();
    await expect(page.getByRole('button', { name: '执行只读预检', exact: true })).toBeDisabled();
  } finally {
    await removeIfPresent(page.request, 'servers', serverId);
    await removeIfPresent(page.request, 'secrets', secretId);
  }
});

test('危险 kubeconfig 在真实预览接口被拒绝，不创建连接任务或修改集群', async ({ page }) => {
  await login(page);
  const tag = suffix();
  const cluster = await api(page.request, '/clusters', 'POST', { name: tag, slug: tag });
  let secretId: string | undefined;
  const connectionPosts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/clusters/${cluster.id}/connect`))
      connectionPosts.push(request.url());
  });
  try {
    await page.goto(`/clusters/${cluster.id}`);
    await page.getByRole('button', { name: '接入已有集群', exact: true }).click();
    await page.getByLabel('候选凭证名称', { exact: true }).fill(`candidate-${tag}`);
    await page
      .getByLabel('kubeconfig 内容', { exact: true })
      .fill(
        [
          'apiVersion: v1',
          'kind: Config',
          'current-context: unsafe',
          'clusters:',
          '  - name: unsafe',
          '    cluster:',
          '      server: https://127.0.0.1:6443',
          '      insecure-skip-tls-verify: true',
          'users:',
          '  - name: unsafe',
          '    user:',
          '      exec:',
          '        command: forbidden-auth-plugin',
          'contexts:',
          '  - name: unsafe',
          '    context:',
          '      cluster: unsafe',
          '      user: unsafe',
        ].join('\n'),
      );
    await page.getByRole('button', { name: '预览候选连接', exact: true }).click();
    await expect(page.locator('[data-mutation-error]')).toBeVisible();
    await expect(page.getByLabel('kubeconfig 内容', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始验证并连接', exact: true })).toHaveCount(0);
    expect(connectionPosts).toEqual([]);
    const latest = await api(page.request, `/clusters/${cluster.id}`);
    expect(latest.identity).toBeNull();
    expect(latest.credentialRefId).toBeNull();
    expect(latest.connectionStatus).toBe('unverified');
    const secrets = await api(page.request, '/secrets?kind=kubeconfig');
    secretId = secrets.find((item: { name: string }) => item.name === `candidate-${tag}`)?.id;
    expect(secretId).toBeTruthy();
    expect((await api(page.request, `/secrets/${secretId}`)).payload).toBeUndefined();
  } finally {
    await removeIfPresent(page.request, 'clusters', cluster.id);
    await removeIfPresent(page.request, 'secrets', secretId);
  }
});

test('候选连接在窄屏保留输入，离开前确认放弃且不发送连接请求', async ({ page }, testInfo) => {
  await login(page);
  const tag = suffix();
  const cluster = await api(page.request, '/clusters', 'POST', { name: tag, slug: tag });
  try {
    await page.goto(`/clusters/${cluster.id}`);
    await page.getByRole('button', { name: '接入已有集群', exact: true }).click();
    await page
      .getByLabel('候选 API 地址', { exact: false })
      .fill('https://cluster.example.invalid:6443');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await expect(page.getByLabel('候选 API 地址', { exact: false })).toHaveValue(
      'https://cluster.example.invalid:6443',
    );
    // No credential material is entered in this screenshot case.
    await page.screenshot({
      path: testInfo.outputPath('cluster-candidate-mobile.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '取消并清空输入', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByLabel('候选 API 地址', { exact: false })).toHaveValue(
      'https://cluster.example.invalid:6443',
    );
    await page.getByRole('button', { name: '取消并清空输入', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '清空输入并关闭', exact: true })
      .click();
    await expect(page.getByLabel('候选 API 地址', { exact: false })).toHaveCount(0);
    expect((await api(page.request, `/clusters/${cluster.id}`)).lastOperationId).toBeNull();
  } finally {
    await removeIfPresent(page.request, 'clusters', cluster.id);
  }
});

test('主题切换后可用的危险操作按钮保持文字对比度', async ({ page }) => {
  await login(page);
  const tag = suffix();
  const cluster = await api(page.request, '/clusters', 'POST', { name: tag, slug: tag });
  try {
    await page.goto(`/clusters/${cluster.id}`);
    await expect(page.getByRole('button', { name: '移除集群登记', exact: true })).toBeEnabled();
    for (const label of ['深色', '浅色', '深色']) {
      await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
      await page.getByRole('menuitemradio', { name: label, exact: true }).click();
      // Check immediately after paint, including the state that previously
      // produced an unreadable intermediate foreground/background pairing.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(page.getByRole('button', { name: '移除集群登记', exact: true })).toBeEnabled();
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        result.violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
        })),
      ).toEqual([]);
    }
  } finally {
    await removeIfPresent(page.request, 'clusters', cluster.id);
  }
});
