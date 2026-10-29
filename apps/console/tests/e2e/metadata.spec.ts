import { test, expect } from '@playwright/test';
import { api, login, removeIfPresent, suffix } from './helpers';

test('真实登记、项目与环境 CRUD 在刷新后保持，并执行引用保护', async ({ page }, testInfo) => {
  await login(page);
  const tag = suffix();
  const clusterName = `集群-${tag}`;
  const projectName = `项目-${tag}`;
  let clusterId: string | undefined;
  let projectId: string | undefined;
  let environmentId: string | undefined;
  try {
    await page.goto('/clusters/new');
    await page.getByLabel('集群名称', { exact: true }).fill(clusterName);
    await page.getByLabel('集群标识', { exact: true }).fill(tag);
    await page.getByLabel('地区', { exact: false }).fill('新加坡');
    await page.getByRole('button', { name: '保存登记', exact: true }).click();
    await expect(page).toHaveURL(/\/clusters\/[0-9a-f-]{36}$/);
    clusterId = page.url().split('/').pop();
    await expect(page.getByRole('heading', { name: clusterName, exact: true })).toBeVisible();
    await expect(page.getByText('尚未验证', { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('集群名称', { exact: true })).toHaveValue(clusterName);

    await page.goto('/projects/new');
    await page.getByRole('radio', { name: new RegExp(clusterName) }).check();
    await expect(page.getByLabel('项目名称', { exact: false })).toHaveJSProperty('required', false);
    await page.getByLabel('项目名称', { exact: false }).fill(projectName);
    await expect(page.getByLabel('项目标识', { exact: true })).not.toBeVisible();
    await page.locator('summary').filter({ hasText: '更多设置' }).click();
    await page.getByLabel('项目标识', { exact: true }).fill(tag);
    await page.getByLabel('描述', { exact: false }).fill('真实浏览器回归创建的隔离测试项目');
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?/);
    projectId = new URL(page.url()).pathname.split('/').pop();
    expect(new URL(page.url()).searchParams.get('createService')).toBe('1');
    const firstService = page.getByRole('dialog', { name: '添加服务', exact: true });
    await expect(firstService).toBeVisible();
    await firstService.getByRole('button', { name: '关闭添加服务', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('createService')).toBe(false);
    await expect(
      page.getByRole('heading', { name: projectName, exact: true, level: 1 }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: projectName, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('环境', { exact: true })).toHaveCount(0);
    const initialEnvironments = await api(page.request, `/environments?projectId=${projectId}`);
    expect(initialEnvironments).toHaveLength(1);
    expect(initialEnvironments[0]).toMatchObject({ slug: 'production', clusterId });
    await expect(page.getByRole('link', { name: clusterName, exact: true }).first()).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      // Let responsive layout and the sticky header reach the compositor before
      // recording the resized page; a resize acknowledgement is not a paint.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`project-context-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(`/clusters/${clusterId}`);
    await expect(page.getByLabel('Kubernetes API 地址', { exact: false })).toHaveAttribute(
      'readonly',
    );
    await expect(page.getByRole('button', { name: '移除集群登记' })).toBeDisabled();
    await page.goto(`/projects/${projectId}`);
    await page
      .getByRole('navigation', { name: '项目导航', exact: true })
      .getByRole('link', { name: '项目设置', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: '项目设置页面', exact: true })
      .getByRole('link', { name: '环境管理', exact: true })
      .click();
    await expect(page.getByRole('button', { name: /删除环境 Production/ })).toHaveCount(0);
    await page.getByRole('button', { name: '创建环境', exact: true }).click();
    await page.getByLabel('环境名称', { exact: true }).fill('预发布');
    await page.getByLabel('环境标识', { exact: true }).fill('staging');
    await page.getByRole('button', { name: '保存环境', exact: true }).click();
    await expect(page.getByRole('cell', { name: '预发布', exact: true })).toBeVisible();
    const environments = await api(page.request, `/environments?projectId=${projectId}`);
    environmentId = environments.find((item: { slug: string }) => item.slug === 'staging').id;
    expect(environments.every((item: { clusterId: string }) => item.clusterId === clusterId)).toBe(
      true,
    );
    await page.getByRole('button', { name: '编辑环境 预发布', exact: true }).click();
    await expect(page.getByLabel('环境标识', { exact: true })).toHaveAttribute('readonly');
    await page.getByLabel('环境名称', { exact: true }).fill('测试环境');
    await page.getByRole('button', { name: '保存环境', exact: true }).click();
    await expect(page.getByRole('cell', { name: '测试环境', exact: true })).toBeVisible();
    await page.getByLabel('环境', { exact: true }).selectOption('staging');
    await expect(page).toHaveURL(/environment=staging/);
    await page.reload();
    await expect(page.getByLabel('环境', { exact: true })).toHaveValue('staging');
    await page.getByRole('button', { name: '删除环境 测试环境', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除环境', exact: true }).click();
    await expect(page.getByRole('cell', { name: '测试环境', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('环境', { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('environment')).toBe('production');
    const remainingEnvironments = await api(page.request, `/environments?projectId=${projectId}`);
    expect(remainingEnvironments).toHaveLength(1);
    expect(remainingEnvironments[0]).toMatchObject({ slug: 'production', clusterId });
    environmentId = undefined;
    await page.goto(`/projects/${projectId}?tab=settings`);
    await page.getByLabel('项目名称', { exact: true }).fill(`${projectName}-更新`);
    await page.getByRole('button', { name: '保存项目资料', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: `${projectName}-更新`, exact: true, level: 2 }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(`${projectName}-更新`);
    await page.getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除项目', exact: true }).click();
    await expect(page).toHaveURL(/\/projects$/);
    projectId = undefined;
    await page.goto(`/clusters/${clusterId}`);
    await page.getByRole('button', { name: '移除集群登记', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '移除登记', exact: true }).click();
    await expect(page).toHaveURL(/\/infrastructure$/);
    clusterId = undefined;
  } finally {
    await removeIfPresent(page.request, 'environments', environmentId);
    await removeIfPresent(page.request, 'projects', projectId);
    await removeIfPresent(page.request, 'clusters', clusterId);
  }
});

test('真实凭证与服务器 CRUD：只返回元数据，引用中的凭证不能删除', async ({ page }) => {
  await login(page);
  const tag = suffix();
  let secretId: string | undefined;
  let serverId: string | undefined;
  try {
    await page.goto('/settings');
    await page.getByRole('button', { name: '新增凭证', exact: true }).first().click();
    await page.getByLabel('凭证名称', { exact: true }).fill(tag);
    await page
      .getByLabel('私钥内容', { exact: true })
      .fill(`TEST-ONLY-NOT-A-REAL-PRIVATE-KEY-${tag}`);
    await page.getByRole('button', { name: '加密保存凭证', exact: true }).click();
    await expect(page.getByRole('cell', { name: new RegExp(tag) }).first()).toBeVisible();
    await expect(page.getByLabel('私钥内容', { exact: true })).toHaveCount(0);
    const metadata = (await api(page.request, '/secrets?kind=ssh')).find(
      (item: { name: string }) => item.name === tag,
    );
    secretId = metadata.id;
    expect(JSON.stringify(metadata)).not.toContain('TEST-ONLY');
    expect(metadata.payload).toBeUndefined();
    await page.goto('/servers/new');
    await page.getByLabel('服务器名称', { exact: true }).fill(tag);
    await page.getByLabel('地址 / IP', { exact: true }).fill('192.0.2.20');
    await page.getByLabel('SSH 用户', { exact: true }).fill('ubuntu');
    await page.getByLabel('SSH 凭证', { exact: false }).selectOption(secretId!);
    await page.getByRole('button', { name: '保存服务器登记', exact: true }).click();
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]{36}$/);
    serverId = page.url().split('/').pop();
    await page.reload();
    await expect(page.getByLabel('地址 / IP', { exact: true })).toHaveValue('192.0.2.20');
    await page.getByLabel('SSH 端口', { exact: true }).fill('2222');
    await page.getByRole('button', { name: '保存服务器登记', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '服务器登记已保存' }).first(),
    ).toBeVisible();
    await page.goto('/settings');
    await page.getByRole('button', { name: `删除凭证 ${tag}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除凭证', exact: true }).click();
    await expect(page.locator('[data-mutation-error]')).toBeVisible();
    await expect(page.getByRole('button', { name: `删除凭证 ${tag}`, exact: true })).toBeVisible();
    await page.goto(`/servers/${serverId}`);
    await page.getByRole('button', { name: '移除服务器登记', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '移除登记', exact: true }).click();
    await expect(page).toHaveURL(/\/infrastructure\?tab=servers$/);
    serverId = undefined;
    await page.goto('/settings');
    await page.getByRole('button', { name: `删除凭证 ${tag}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除凭证', exact: true }).click();
    await expect(page.getByRole('button', { name: `删除凭证 ${tag}`, exact: true })).toHaveCount(0);
    secretId = undefined;
  } finally {
    await removeIfPresent(page.request, 'servers', serverId);
    await removeIfPresent(page.request, 'secrets', secretId);
  }
});
