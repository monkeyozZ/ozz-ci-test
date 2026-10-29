import { expect, test, type Page } from '@playwright/test';
import {
  installGitWorkspaceFixture,
  installImageWorkspaceFixture,
} from './service-workspace-v3-fixture';

const tabNames = ['服务状态', '环境变量', '用量', '网络', '数据与存储', '设置'];
const runs = new WeakMap<Page, { errors: string[]; unexpected: string[] }>();
function track(page: Page, state: { unexpected: string[] }) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { errors, unexpected: state.unexpected });
}
async function imageFixture(page: Page) {
  const state = await installImageWorkspaceFixture(page);
  track(page, state);
  return state;
}
async function gitFixture(page: Page) {
  const state = await installGitWorkspaceFixture(page);
  track(page, state);
  return state;
}
const tabs = (page: Page) => page.getByRole('navigation', { name: '服务页面', exact: true });
const tabLink = (page: Page, name: string) =>
  tabs(page).getByRole('link', { name: new RegExp(`^${name}(?:\\s|$)`) });
async function selectTab(page: Page, name: string) {
  await tabLink(page, name).click();
  await expect(tabLink(page, name)).toHaveAttribute('aria-current', 'page');
}
test.afterEach(async ({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors, '浏览器运行错误').toEqual([]);
    expect(run.unexpected, '未声明的 API 请求').toEqual([]);
  }
});

test('六个服务页签与原镜像服务链接均有明确入口', async ({ page }) => {
  const state = await imageFixture(page);
  await page.goto(state.pathFor());
  await expect(tabs(page).getByRole('link')).toHaveText(tabNames);
  await expect(page.locator('[data-service-status]')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('service-status-1440.png'),
    fullPage: true,
    animations: 'disabled',
  });
  for (const name of tabNames.slice(1)) await selectTab(page, name);
  await expect(page.getByLabel('服务名称', { exact: true })).toBeVisible();
  await page.goto(state.pathFor('configuration'));
  await expect(tabLink(page, '设置')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('服务名称', { exact: true })).toBeVisible();
  await page.goto(state.pathFor('network'));
  await expect(page.locator('[data-domain-allocation]')).toBeVisible();
  await page.goto(state.pathFor('storage'));
  await expect(page.locator('[data-service-volume-mounts]')).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test('没有环境参数的深链切页签保留变量、名称和未应用的 env 导入', async ({ page }) => {
  const state = await imageFixture(page);
  await page.goto(state.pathFor('variables', false));
  await page.getByRole('button', { name: '添加变量', exact: true }).click();
  await page.getByLabel('变量名', { exact: true }).fill('WORKSPACE_NAME');
  await page.getByLabel('变量值', { exact: true }).fill('kept across tabs');
  await page.getByRole('button', { name: '导入 .env', exact: true }).click();
  await page.getByLabel('.env 文件内容', { exact: true }).fill('IMPORTED=still here');
  await page.getByRole('button', { name: '解析并检查', exact: true }).click();
  await expect(page.getByText('已解析 1 个变量：IMPORTED', { exact: true })).toBeVisible();
  await selectTab(page, '设置');
  await page.getByLabel('服务名称', { exact: true }).fill('切换后保留的名称');
  await selectTab(page, '用量');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await selectTab(page, '环境变量');
  await expect(page.getByLabel('变量值', { exact: true })).toHaveValue('kept across tabs');
  await expect(page.getByLabel('.env 文件内容', { exact: true })).toHaveValue(
    'IMPORTED=still here',
  );
  await expect(page.getByRole('button', { name: '加入当前草稿', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '加入当前草稿', exact: true }).click();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  await expect.poll(() => state.service.name).toBe('切换后保留的名称');
  expect(new URL(page.url()).searchParams.has('environment')).toBe(false);
  const saves = state.writes.filter((entry) => entry.method === 'PATCH');
  expect(saves).toHaveLength(1);
  expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
  const savedSecret = state.service.configuration.environment.find(
    (entry) => entry.name === 'IMPORTED',
  );
  expect(savedSecret?.value).toBeUndefined();
  expect(savedSecret?.secretRefId).toBeTruthy();
  await expect(page.getByLabel('秘密值', { exact: true })).toHaveCount(0);
});

test('保存时定位到另一页签中无效的运行字段和变量字段', async ({ page }) => {
  const state = await imageFixture(page);
  await page.goto(state.pathFor('configuration'));
  await page.getByLabel('服务名称', { exact: true }).fill('');
  await selectTab(page, '环境变量');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByLabel('服务名称', { exact: true })).toBeFocused();
  await expect(tabLink(page, '设置')).toHaveAttribute('aria-current', 'page');
  await page.getByLabel('服务名称', { exact: true }).fill('有效的草稿名称');
  await selectTab(page, '环境变量');
  await page.getByRole('button', { name: '添加变量', exact: true }).click();
  await selectTab(page, '设置');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByLabel('变量名', { exact: true })).toBeFocused();
  await expect(tabLink(page, '环境变量')).toHaveAttribute('aria-current', 'page');
  expect(state.writes).toHaveLength(0);
});

test('Git 来源和构建表单跨六页签保留，旧 source 深链直接显示来源', async ({ page }) => {
  const state = await gitFixture(page);
  await page.goto(state.pathFor('source'));
  const source = page.locator('[data-service-source-settings]');
  await expect(source).toBeVisible();
  await source.getByLabel('Dockerfile 路径', { exact: true }).fill('deploy/Workspace.Dockerfile');
  await source.getByLabel('构建上下文', { exact: true }).fill('packages/workspace');
  await selectTab(page, '环境变量');
  await selectTab(page, '网络');
  await selectTab(page, '数据与存储');
  await selectTab(page, '服务状态');
  await selectTab(page, '设置');
  await page
    .getByRole('navigation', { name: '服务设置分组' })
    .getByRole('link', { name: 'Git 来源与构建' })
    .click();
  await expect(source.getByLabel('Dockerfile 路径', { exact: true })).toHaveValue(
    'deploy/Workspace.Dockerfile',
  );
  await expect(source.getByLabel('构建上下文', { exact: true })).toHaveValue('packages/workspace');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('网络确认、卷挂载和数据库连接草稿在切页签时保持，离开服务仍确认', async ({ page }) => {
  const state = await imageFixture(page);
  await page.goto(state.pathFor('network'));
  const networkPort = page.getByLabel('已发布 HTTP 端口', { exact: true });
  await networkPort.selectOption({ index: 1 });
  const selectedPort = await networkPort.inputValue();
  const networkConfirmation = page.getByRole('checkbox', {
    name: '已核对目标集群、HTTP 端口和 DNS 记录归属。',
  });
  await networkConfirmation.check();
  await selectTab(page, '数据与存储');
  await page.getByLabel('数据卷', { exact: true }).selectOption(state.volumeId);
  await page.getByLabel('容器挂载路径', { exact: true }).fill('/workspace-data');
  await page.getByRole('checkbox', { name: '只读挂载' }).check();
  await page.getByLabel('数据库', { exact: true }).selectOption(state.databaseId);
  await page.getByLabel('私有主机 → 环境变量', { exact: true }).fill('WORKSPACE_DB_HOST');
  await selectTab(page, '用量');
  await selectTab(page, '网络');
  await expect(networkPort).toHaveValue(selectedPort);
  await expect(networkConfirmation).toBeChecked();
  await selectTab(page, '数据与存储');
  await expect(page.getByLabel('容器挂载路径', { exact: true })).toHaveValue('/workspace-data');
  await expect(page.getByLabel('数据卷', { exact: true })).toHaveValue(state.volumeId);
  await expect(page.getByRole('checkbox', { name: '只读挂载' })).toBeChecked();
  await expect(page.getByLabel('私有主机 → 环境变量', { exact: true })).toHaveValue(
    'WORKSPACE_DB_HOST',
  );
  await page
    .getByRole('navigation', { name: '面包屑' })
    .getByRole('link', { name: '项目', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('离开前保留当前编辑？');
  await expect(page.getByRole('dialog')).toContainText('卷挂载草稿');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('容器挂载路径', { exact: true })).toHaveValue('/workspace-data');
  expect(state.writes).toHaveLength(0);
});

test('旧日志深链保留实例与容器、读取参数，关闭后回到原页签', async ({ page }) => {
  const state = await imageFixture(page);
  const podUid = state.service.observation!.pods[0]!.uid;
  await page.goto(state.pathFor('logs') + `&view=usage&podUid=${podUid}&container=sidecar`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('运行日志');
  await expect(dialog.getByLabel('实例', { exact: true })).toHaveValue(podUid);
  await expect(dialog.getByLabel('容器', { exact: true })).toHaveValue('sidecar');
  await dialog.getByLabel('尾部行数', { exact: true }).selectOption('500');
  await dialog.getByRole('checkbox', { name: '上次退出的容器' }).check();
  await dialog.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await expect(dialog.getByText('workspace controlled log', { exact: true })).toBeVisible();
  const request = state.reads.find((entry) => entry.path.endsWith('/logs'));
  expect(request?.query).toMatchObject({
    podUid,
    container: 'sidecar',
    previous: 'true',
    tailLines: '500',
    follow: 'false',
  });
  await dialog.getByRole('button', { name: '返回服务', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-service-usage]')).toBeVisible();
  await page.goto(state.pathFor('deployments'));
  await expect(page.getByRole('dialog')).toHaveAccessibleName('部署记录');
  await expect(page.getByRole('dialog').getByRole('link').first()).toBeVisible();
});

test('正在读取 Git 提交预览时阻止 Escape、返回和浏览器后退，完成后可关闭', async ({ page }) => {
  const state = await gitFixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.gitState.beforePreviewReply = () => gate;
  await page.goto(state.pathFor());
  await page.locator('[data-service-deploy]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '返回服务', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByText('部署请求正在处理，请稍后再离开。', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/tab=review/);
  release();
  await expect(dialog.getByRole('button', { name: '返回服务', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '重新读取提交预览', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '返回服务', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.writes.filter((entry) => entry.path.endsWith('/git-source/preview'))).toHaveLength(
    1,
  );
  expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
});

test('部署受理中不能关闭或重复提交，受理成功后进入对应任务', async ({ page }) => {
  const state = await imageFixture(page);
  let release!: () => void;
  let received = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.controls.beforeDeploymentReply = async () => {
    received = true;
    await gate;
  };
  await page.goto(state.pathFor('review'));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '确认发布', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await expect(dialog.getByRole('button', { name: '返回服务', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '正在受理…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  release();
  await expect(page).toHaveURL(/\/deployments\/52000000-/);
  const deployments = state.writes.filter((entry) => entry.path.endsWith('/deployments'));
  expect(deployments).toHaveLength(1);
  expect(deployments[0]!.key).toBeTruthy();
});

test('数据库变量保护和删除影响审查仍从明确入口可达', async ({ page }) => {
  const state = await imageFixture(page);
  state.imageState.deleteBlocked = true;
  await page.goto(state.pathFor('variables', true, state.databaseServiceId));
  await expect(page.locator('[data-database-variable-protection]')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加变量', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导入 .env', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '更多服务操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除服务…', exact: true }).click();
  const review = page.locator('[data-service-deletion-review]');
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: '审阅服务删除', exact: true }).click();
  await expect(page.locator('[data-service-deletion-preview]')).toContainText(
    '仍有应用引用此数据库。',
  );
  await expect(
    review.getByRole('button', { name: '确认删除服务并保留数据卷', exact: true }),
  ).toBeDisabled();
  expect(state.writes.every((entry) => entry.path.endsWith('/deletion-preview'))).toBe(true);
});

test('390px 下六页签、设置与三个侧面板均可操作且页面不横向溢出', async ({ page }) => {
  const state = await imageFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(state.pathFor());
  await expect(page.locator('[data-service-status]')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('service-status-390.png'),
    fullPage: true,
    animations: 'disabled',
  });
  for (const name of tabNames) {
    await selectTab(page, name);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, name + ' 页面宽度').toBeLessThanOrEqual(1);
  }
  await selectTab(page, '服务状态');
  for (const name of ['日志', '部署记录']) {
    await page.locator('[data-service-status]').getByRole('link', { name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual(390.5);
    await dialog.getByRole('button', { name: '返回服务', exact: true }).click();
  }
  await page.locator('[data-service-deploy]').click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('部署服务');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '确认发布', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
