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
async function workspaceFixture(page: Page) {
  const state = await installImageWorkspaceFixture(page);
  track(page, state.unexpected);
  return state;
}
async function creationFixture(page: Page) {
  const state = await installCreationFixture(page);
  track(page, state.core.unexpected);
  return state;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function settleReply(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
const projectPath = `/projects/${s5Ids.project}?environment=staging`;
const creationDialog = (page: Page) => page.getByRole('dialog', { name: '添加服务', exact: true });
const addService = (page: Page) =>
  page.locator('.app-sidebar').getByRole('link', { name: '添加服务', exact: true });
const confirmLeave = (page: Page) =>
  page.getByRole('dialog').filter({ hasText: '离开前保留当前编辑？' });
const reloadConfirmation = (page: Page) =>
  page.getByRole('dialog').filter({ hasText: '载入最新的已保存草稿？' });
test.afterEach(({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors, '浏览器脚本错误').toEqual([]);
    expect(run.unexpected, '未声明的 API 请求').toEqual([]);
  }
});

test('.env 清空重开后，迟到的旧结果不会替换新解析，导入仍默认保护秘密', async ({ page }) => {
  const state = await workspaceFixture(page);
  const older = gate();
  await page.route('**/api/services/parse-env', async (route) => {
    if (route.request().postDataJSON().text === 'OLDER=discarded') await older.promise;
    return route.fallback();
  });
  try {
    await page.goto(state.pathFor('variables'));
    await page.getByRole('button', { name: '导入 .env', exact: true }).click();
    const source = page.getByLabel('.env 文件内容', { exact: true });
    await expect(source).toBeFocused();
    await source.fill('OLDER=discarded');
    await page.getByRole('button', { name: '解析并检查', exact: true }).click();
    await expect(page.getByRole('button', { name: '正在校验…', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '清空并关闭 .env 导入', exact: true }).click();
    await page.getByRole('button', { name: '导入 .env', exact: true }).click();
    await expect(source).toHaveValue('');
    await source.fill('CURRENT=fixture-secret-current');
    await page.getByRole('button', { name: '解析并检查', exact: true }).click();
    await expect(page.getByText('已解析 1 个变量：CURRENT', { exact: true })).toBeVisible();
    const lateReply = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/services/parse-env') &&
        response.request().postDataJSON().text === 'OLDER=discarded',
    );
    older.release();
    await (await lateReply).finished();
    await settleReply(page);
    await expect(page.getByText('已解析 1 个变量：CURRENT', { exact: true })).toBeVisible();
    await expect(page.getByText(/已解析.*OLDER/)).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '将导入的值全部作为秘密保存' })).toBeChecked();
    await page.getByRole('button', { name: '加入当前草稿', exact: true }).click();
    await expect(page.getByLabel('变量名', { exact: true })).toHaveValue('CURRENT');
    await expect(page.getByLabel('保存方式', { exact: true })).toHaveValue('secret');
    await expect(page.getByLabel('秘密值', { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('秘密值', { exact: true })).toHaveValue('fixture-secret-current');
    expect(state.writes.every((write) => write.path === '/services/parse-env')).toBe(true);
  } finally {
    older.release();
  }
});

test('.env 校验时可修改文本，旧请求失败不会污染新解析或停掉当前反馈', async ({ page }) => {
  const state = await workspaceFixture(page);
  const older = gate();
  await page.route('**/api/services/parse-env', async (route) => {
    if (route.request().postDataJSON().text !== 'OLDER=invalidated') return route.fallback();
    await older.promise;
    return route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 422,
        code: 'OLD_PARSE_REJECTED',
        detail: '旧文本的受控错误。',
      }),
    });
  });
  try {
    await page.goto(state.pathFor('variables'));
    await page.getByRole('button', { name: '导入 .env', exact: true }).click();
    const source = page.getByLabel('.env 文件内容', { exact: true });
    await source.fill('OLDER=invalidated');
    await page.getByRole('button', { name: '解析并检查', exact: true }).click();
    await expect(page.getByRole('button', { name: '正在校验…', exact: true })).toBeDisabled();
    await expect(source).toBeEditable();
    await source.fill('EDITED=retained');
    await expect(page.getByRole('button', { name: '解析并检查', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '加入当前草稿', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '解析并检查', exact: true }).click();
    await expect(page.getByText('已解析 1 个变量：EDITED', { exact: true })).toBeVisible();
    const lateReply = page.waitForResponse(
      (response) => response.status() === 422 && response.url().endsWith('/api/services/parse-env'),
    );
    older.release();
    await (await lateReply).finished();
    await settleReply(page);
    await expect(page.getByText('旧文本的受控错误。', { exact: true })).toHaveCount(0);
    await expect(source).toHaveValue('EDITED=retained');
    await expect(page.getByText('已解析 1 个变量：EDITED', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '加入当前草稿', exact: true })).toBeEnabled();
  } finally {
    older.release();
  }
});

test('.env 收起保留输入和离开保护，重开不接纳关闭前的校验回复', async ({ page }) => {
  const state = await workspaceFixture(page);
  const older = gate();
  await page.route('**/api/services/parse-env', async (route) => {
    await older.promise;
    return route.fallback();
  });
  try {
    await page.goto(state.pathFor('variables'));
    const toggle = page.getByRole('button', { name: '导入 .env', exact: true });
    await toggle.click();
    await page.getByLabel('.env 文件内容', { exact: true }).fill('FOLDED=kept');
    await page.getByRole('button', { name: '解析并检查', exact: true }).click();
    await expect(page.getByRole('button', { name: '正在校验…', exact: true })).toBeDisabled();
    await toggle.click();
    await expect(page.getByLabel('.env 文件内容', { exact: true })).toHaveCount(0);
    await page
      .getByRole('navigation', { name: '面包屑' })
      .getByRole('link', { name: '项目', exact: true })
      .click();
    await expect(confirmLeave(page)).toContainText('.env 导入内容');
    await confirmLeave(page).getByRole('button', { name: '取消', exact: true }).click();
    await toggle.click();
    await expect(page.getByLabel('.env 文件内容', { exact: true })).toHaveValue('FOLDED=kept');
    const lateReply = page.waitForResponse((response) =>
      response.url().endsWith('/api/services/parse-env'),
    );
    older.release();
    await (await lateReply).finished();
    await settleReply(page);
    await expect(page.getByText(/已解析.*FOLDED/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '加入当前草稿', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '解析并检查', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '清空并关闭 .env 导入', exact: true }).click();
    await page
      .getByRole('navigation', { name: '面包屑' })
      .getByRole('link', { name: '项目', exact: true })
      .click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(confirmLeave(page)).toHaveCount(0);
  } finally {
    older.release();
  }
});

test('载入最新草稿有等待反馈且禁止重复，失败保留编辑，重试成功才替换', async ({ page }) => {
  const state = await workspaceFixture(page);
  await page.goto(state.pathFor('configuration'));
  const name = page.getByLabel('服务名称', { exact: true });
  await name.fill('失败也要保留的草稿');
  const read = gate();
  let fail = true;
  let requested = 0;
  await page.route(`**/api/services/${state.service.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    requested++;
    await read.promise;
    if (!fail) return route.fallback();
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 403,
        code: 'DRAFT_READ_REJECTED',
        detail: '最新草稿暂时不能读取。',
      }),
    });
  });
  try {
    await page.getByRole('button', { name: '载入最新草稿', exact: true }).click();
    await reloadConfirmation(page)
      .getByRole('button', { name: '载入最新草稿', exact: true })
      .click();
    const pending = page.getByRole('button', { name: '正在载入…', exact: true });
    await expect(pending).toBeDisabled();
    await expect(page.getByText('正在更新，保留当前内容', { exact: true })).toBeVisible();
    await pending.dispatchEvent('click');
    expect(requested).toBe(1);
    read.release();
    await expect(page.getByRole('button', { name: '载入最新草稿', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert').filter({ hasText: '没有载入最新数据' })).toContainText(
      '最新草稿暂时不能读取。',
    );
    await expect(name).toHaveValue('失败也要保留的草稿');
    await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
    fail = false;
    state.service.name = '服务器的新草稿';
    state.service.revision++;
    await page.getByRole('button', { name: '载入最新草稿', exact: true }).click();
    await reloadConfirmation(page)
      .getByRole('button', { name: '载入最新草稿', exact: true })
      .click();
    await expect(name).toHaveValue('服务器的新草稿');
    await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: '最新草稿暂时不能读取。' })).toHaveCount(
      0,
    );
    expect(requested).toBe(2);
    expect(state.writes).toEqual([]);
  } finally {
    read.release();
  }
});

test('慢速载入期间继续编辑会保留新值和原版本，保存仍核对真实冲突', async ({ page }) => {
  const state = await workspaceFixture(page);
  const originalRevision = state.service.revision;
  await page.goto(state.pathFor('configuration'));
  await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue(state.service.name);
  const read = gate();
  await page.route(`**/api/services/${state.service.id}`, async (route) => {
    if (route.request().method() === 'GET') await read.promise;
    return route.fallback();
  });
  try {
    state.service.name = '远端已更新';
    state.service.revision++;
    await page.getByRole('button', { name: '载入最新草稿', exact: true }).click();
    await expect(page.getByRole('button', { name: '正在载入…', exact: true })).toBeDisabled();
    const name = page.getByLabel('服务名称', { exact: true });
    await expect(name).toBeEditable();
    await name.fill('读取期间的新编辑');
    await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
    read.release();
    await expect(page.getByRole('button', { name: '载入最新草稿', exact: true })).toBeEnabled();
    await expect(name).toHaveValue('读取期间的新编辑');
    await expect(
      page.getByText('读取期间有新的修改，已保留当前编辑。需要时可再次载入最新草稿。', {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '受控版本冲突。' })).toBeVisible();
    const saves = state.writes.filter((write) => write.method === 'PATCH');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.body).toMatchObject({ name: '读取期间的新编辑', revision: originalRevision });
    await expect(name).toHaveValue('读取期间的新编辑');
  } finally {
    read.release();
  }
});

test('来源、配置和复核各有自然焦点，IME 与浏览器返回保留来源草稿', async ({ page }) => {
  const state = await creationFixture(page);
  await page.goto(projectPath);
  await addService(page).click();
  const dialog = creationDialog(page);
  await expect(dialog.locator('.source-option').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const name = dialog.getByLabel('服务名称', { exact: true });
  await expect(name).toBeFocused();
  await name.fill('来回仍保留的镜像');
  await dialog.getByLabel('镜像地址', { exact: true }).fill('nginx:1.28.0-alpine');
  await name.dispatchEvent('compositionstart', { data: '中' });
  await page.keyboard.press('Escape');
  await expect(
    dialog.getByRole('heading', { name: '部署 Docker 镜像', exact: true }),
  ).toBeVisible();
  await name.dispatchEvent('compositionend', { data: '中' });
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('link', { name: /部署 Docker 镜像/ })).toBeFocused();
  await dialog.getByRole('link', { name: /从 GitHub 部署/ }).click();
  await expect(name).toBeFocused();
  await name.fill('独立的 Git 草稿');
  await page.goBack();
  await expect(dialog.getByRole('link', { name: /从 GitHub 部署/ })).toBeFocused();
  await dialog.getByRole('link', { name: /部署 Docker 镜像/ }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('来回仍保留的镜像');
  await expect(dialog.getByLabel('镜像地址', { exact: true })).toHaveValue('nginx:1.28.0-alpine');
  await dialog.getByRole('button', { name: '核对部署配置', exact: true }).click();
  await expect(dialog.locator('[data-deployment-review]')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '核对部署配置', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '返回配置', exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('来回仍保留的镜像');
  expect(state.core.writes.filter((write) => write.path === '/services')).toHaveLength(1);
});

test('确认放弃后关闭恢复添加入口，背景草稿保留，再开创建无旧输入', async ({ page }) => {
  const state = await creationFixture(page);
  await page.goto(`${projectPath}&tab=settings`);
  await page.getByLabel('项目名称', { exact: true }).fill('后台项目编辑');
  await addService(page).click();
  const dialog = creationDialog(page);
  await dialog.getByRole('link', { name: /部署 Docker 镜像/ }).click();
  await dialog.getByLabel('服务名称', { exact: true }).fill('准备放弃的输入');
  await dialog.getByRole('button', { name: '关闭添加服务', exact: true }).click();
  await confirmLeave(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog.getByLabel('服务名称', { exact: true })).toHaveValue('准备放弃的输入');
  await dialog.getByRole('button', { name: '关闭添加服务', exact: true }).click();
  await expect(confirmLeave(page)).not.toContainText('项目资料有尚未保存');
  await confirmLeave(page).getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  await expect(page.locator('.creation-dialog')).toHaveCount(0);
  await expect(addService(page)).toBeFocused();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('后台项目编辑');
  await addService(page).click();
  await expect(dialog.locator('.source-option').first()).toBeFocused();
  await dialog.getByRole('link', { name: /部署 Docker 镜像/ }).click();
  await expect(dialog.getByLabel('服务名称', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: '关闭添加服务', exact: true }).click();
  await expect(page.locator('.creation-dialog')).toHaveCount(0);
  await expect(confirmLeave(page)).toHaveCount(0);
  expect(state.core.writes).toEqual([]);
});

test('退出保留复核画面并停止交互，动画中重开创建使用新会话与新草稿', async ({ page }) => {
  const state = await creationFixture(page);
  await page.goto(projectPath);
  await addService(page).click();
  const dialog = creationDialog(page);
  await dialog.getByRole('link', { name: /部署 Docker 镜像/ }).click();
  await dialog.getByLabel('服务名称', { exact: true }).fill('已经保存的原服务');
  await dialog.getByLabel('镜像地址', { exact: true }).fill('nginx:1.28.0-alpine');
  await dialog.getByRole('button', { name: '核对部署配置', exact: true }).click();
  await expect(dialog.locator('[data-deployment-review]')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`createdService=${s5Ids.createdService}`));
  const delay = await page.addStyleTag({
    content:
      '.creation-dialog[data-state="closed"], .creation-overlay[data-state="closed"] { animation-duration: 1s !important; }',
  });
  await dialog.getByRole('button', { name: '关闭添加服务', exact: true }).click();
  const closing = page.locator('.creation-dialog[data-state="closed"]');
  await expect(closing).toHaveAttribute('inert', '');
  await expect(closing.locator('[data-creation-step]')).toHaveAttribute(
    'data-creation-step',
    'review',
  );
  await expect(closing.locator('[data-deployment-review]')).toHaveCount(1);
  await expect(closing).toHaveCSS('pointer-events', 'none');
  expect(await closing.evaluate((element) => getComputedStyle(element).animationName)).not.toBe(
    'none',
  );
  // A global route action can arrive before Presence finishes removing the old content.
  await page
    .locator('.app-sidebar')
    .getByRole('link', { name: '添加服务', exact: true, includeHidden: true })
    .dispatchEvent('click');
  await expect(dialog.locator('.source-option')).toHaveCount(4);
  await expect(dialog.locator('.source-option').first()).toBeFocused();
  expect(new URL(page.url()).searchParams.has('createdService')).toBe(false);
  await delay.evaluate((element) => element.parentNode?.removeChild(element));
  await dialog.getByRole('link', { name: /部署 Docker 镜像/ }).click();
  await expect(dialog.getByLabel('服务名称', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('镜像地址', { exact: true })).toHaveValue('');
  expect(new URL(page.url()).searchParams.has('createdService')).toBe(false);
  await expect(dialog.getByRole('button', { name: '关闭添加服务', exact: true })).toBeEnabled();
  expect(state.core.writes.filter((write) => write.path === '/services')).toHaveLength(1);
});

test('模板选择聚焦搜索，进入配置聚焦服务名称，返回仍保留类别与选择位置', async ({ page }) => {
  await creationFixture(page);
  await page.goto(`${projectPath}&createService=1`);
  const dialog = creationDialog(page);
  await dialog.getByRole('link', { name: /添加数据库/ }).click();
  await expect(dialog.getByLabel('搜索模板', { exact: true })).toBeFocused();
  await dialog.getByRole('link', { name: '使用 Redis 模板', exact: true }).click();
  await expect(dialog.getByLabel('服务名称', { exact: true })).toBeFocused();
  await dialog.getByLabel('服务名称', { exact: true }).fill('模板草稿');
  await page.goBack();
  await expect(dialog.getByLabel('模板类别', { exact: true })).toHaveValue('database');
  await expect(dialog.getByRole('link', { name: '使用 Redis 模板', exact: true })).toBeFocused();
  await dialog.getByRole('link', { name: '使用 Redis 模板', exact: true }).click();
  await expect(dialog.getByLabel('服务名称', { exact: true })).toHaveValue('模板草稿');
});
