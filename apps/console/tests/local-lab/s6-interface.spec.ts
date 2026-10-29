import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { installS6Fixture, s6Ids, s6ServicePath } from './s6-fixture';
import { makeBuild, makeBuildRun, makeGitPreview, s6Commit, s6Time } from '../fixtures/s6-data';

type State = Awaited<ReturnType<typeof installS6Fixture>>;
const runs = new WeakMap<Page, { state: State; errors: string[] }>();
const createPath = `/projects/${s6Ids.project}?environment=staging&createService=1&source=github`;
const creation = (page: Page) => page.getByRole('dialog', { name: '添加服务', exact: true });
const deploymentPath = '/deployments/' + s6Ids.deployment;
async function fixture(page: Page) {
  const state = await installS6Fixture(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { state, errors });
  return state;
}
test.afterEach(async ({ page }) => {
  const run = runs.get(page);
  if (run) {
    expect(run.errors, '浏览器运行错误').toEqual([]);
    expect(run.state.unexpected, '未声明的 API 请求').toEqual([]);
  }
});
const writesAt = (state: State, path: string) =>
  state.writes.filter((entry) => entry.path === path);

test('G04：保存 GitHub 凭证引用不注册 Hook，授权仓库分页后明确注册', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings?tab=git&integration=github');
  await page.getByRole('button', { name: '编辑或替换凭证', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('已核对 GitHub 连接');
  await page.getByRole('button', { name: '保存连接配置', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '已核对 GitHub 连接', exact: true }),
  ).toBeVisible();
  expect(state.operations).toHaveLength(0);
  expect(
    state.writes.some((entry) => entry.path.endsWith('/verify') || entry.path.endsWith('/webhook')),
  ).toBe(false);
  await page.getByRole('button', { name: '验证当前授权', exact: true }).click();
  await expect
    .poll(() => writesAt(state, `/integrations/github/${s6Ids.connection}/verify`).length)
    .toBe(1);
  await page.getByRole('button', { name: '查看授权仓库与 Webhook', exact: true }).click();
  const repositories = page.locator('[data-github-repositories]');
  await expect(repositories.locator('.repository-list > li')).toHaveCount(1);
  await repositories.getByRole('button', { name: '载入更多授权仓库', exact: true }).click();
  await expect(repositories.locator('.repository-list > li')).toHaveCount(2);
  await repositories.getByRole('button', { name: '配置 Webhook', exact: true }).first().click();
  await repositories
    .getByLabel('Webhook 验签凭证', { exact: true })
    .selectOption(s6Ids.webhookSecret);
  expect(state.operations).toHaveLength(0);
  await repositories.getByRole('button', { name: '确认在 GitHub 注册或更新', exact: true }).click();
  await expect(
    repositories.getByRole('link', { name: '查看注册或更新结果', exact: true }),
  ).toBeVisible();
  const registration = writesAt(
    state,
    `/integrations/github/${s6Ids.connection}/repositories/${s6Ids.repository}/webhook`,
  );
  expect(registration).toHaveLength(1);
  expect(registration[0]!.body).toEqual({ revision: 2, secretRefId: s6Ids.webhookSecret });
  expect(registration[0]!.key).toBeTruthy();
  expect(state.operations[0]!.kind).toBe('github_webhook_register');
  expect(
    state.reads
      .filter((entry) => entry.path.includes('/repositories'))
      .every((entry) => !('limit' in entry.query)),
  ).toBe(true);
});

test('G04：Registry 双身份与持久检查分开，Builder 显示代际不匹配', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings?tab=git&integration=registries');
  await page.getByRole('button', { name: '编辑或替换凭证', exact: true }).click();
  await page.getByLabel('运行时镜像拉取凭证', { exact: true }).selectOption(s6Ids.pushSecret);
  await page.getByRole('button', { name: '保存连接配置', exact: true }).click();
  await expect(page.locator('[data-mutation-error]')).toContainText('两个不同的凭证引用');
  expect(state.writes).toHaveLength(0);
  await page.getByLabel('运行时镜像拉取凭证', { exact: true }).selectOption(s6Ids.pullSecret);
  await page.getByRole('button', { name: '保存连接配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存连接配置', exact: true })).toHaveCount(0);
  expect(state.operations).toHaveLength(0);
  await page.getByRole('button', { name: '执行推送与拉取检查', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('拉取身份确实不能推送');
  expect(state.operations).toHaveLength(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '执行推送与拉取检查', exact: true })
    .click();
  await expect(page.getByRole('link', { name: '查看真实检查结果', exact: true })).toBeVisible();
  expect(state.operations[0]!.kind).toBe('registry_validate');
  expect(state.operations[0]!.scope).toBe('integration');
  state.builders[0]!.verification = {
    state: 'failed',
    checkedAt: s6Time,
    errorCode: 'BUILDER_GENERATION_MISMATCH',
  };
  state.builders[0]!.capabilities!.highGeneration = 5;
  await page
    .getByRole('navigation', { name: 'Git 与构建集成', exact: true })
    .getByRole('link', { name: '独立 Builder', exact: true })
    .click();
  await expect(page.getByText('Builder 代际 5 / 控制面核对代际 4', { exact: true })).toBeVisible();
  await expect(page.getByText('BUILDER_GENERATION_MISMATCH', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '验证身份与能力', exact: true }).click();
  await expect
    .poll(() => writesAt(state, `/integrations/builders/${s6Ids.builder}/verify`).length)
    .toBe(1);
  expect(state.builders[0]!.capabilities!.highGeneration).toBe(5);
});

test('B03：Git 创建只发送运行配置，授权仓库与分支切换清空旧选择，响应丢失复用持久键', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(createPath);
  await creation(page).getByLabel('服务名称', { exact: true }).fill('Git 创建样本');
  await creation(page).locator('summary').filter({ hasText: '标识与描述' }).click();
  await creation(page).getByLabel('服务标识', { exact: true }).fill('created-git');
  await expect(page.getByRole('heading', { name: 'Docker 镜像', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('镜像地址', { exact: true })).toHaveCount(0);
  const source = creation(page).locator('[data-git-source-editor]');
  await source.getByLabel('GitHub 授权', { exact: true }).selectOption(s6Ids.connection);
  await source.getByLabel('授权仓库', { exact: true }).selectOption(s6Ids.repository);
  await source.getByLabel('跟踪分支', { exact: true }).selectOption('refs/heads/main');
  await source.getByRole('button', { name: '载入更多仓库', exact: true }).click();
  await source.getByLabel('授权仓库', { exact: true }).selectOption(s6Ids.secondRepository);
  await expect(source.getByLabel('跟踪分支', { exact: true })).toHaveValue('');
  await source.getByLabel('跟踪分支', { exact: true }).selectOption('refs/heads/main');
  await source.getByRole('button', { name: '载入更多分支', exact: true }).click();
  await source.getByLabel('跟踪分支', { exact: true }).selectOption('refs/heads/release');
  await source.getByLabel('独立 Builder', { exact: true }).selectOption(s6Ids.builder);
  await source.getByLabel('产物 Registry', { exact: true }).selectOption(s6Ids.registry);
  await source.getByLabel('镜像名称', { exact: true }).fill('created-git');
  await source.getByLabel('Linux / arm64', { exact: true }).check();
  state.failCreateReplyOnce = true;
  await creation(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
  await expect(creation(page).locator('[data-mutation-error]')).toBeVisible();
  await expect(creation(page).getByLabel('服务名称', { exact: true })).toBeDisabled();
  await creation(page).getByRole('button', { name: '重试确认保存结果', exact: true }).click();
  await expect(creation(page).locator('[data-deployment-review]')).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === `/projects/${s6Ids.project}` &&
      url.searchParams.get('environment') === 'staging' &&
      url.searchParams.get('createService') === '1' &&
      url.searchParams.get('createdService') === s6Ids.createdService,
  );
  const saves = writesAt(state, '/services');
  expect(saves).toHaveLength(2);
  expect(saves[0]!.key).toBeTruthy();
  expect(saves[1]!.key).toBe(saves[0]!.key);
  expect(saves[1]!.body).toEqual(saves[0]!.body);
  expect(saves[1]!.body).toMatchObject({
    source: {
      kind: 'github',
      repositoryId: s6Ids.secondRepository,
      branchRef: 'refs/heads/release',
      platforms: [{ os: 'linux', architecture: 'arm64' }],
    },
    configuration: { replicas: 1 },
  });
  expect(saves[1]!.body).not.toHaveProperty('configuration.image');
  expect(saves[1]!.body).not.toHaveProperty('registryCredentialRefId');
  expect(state.services.filter((item) => item.id === s6Ids.createdService)).toHaveLength(1);
  expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
});

test('C03：过期预览阻止发布，固定 previewId 需要明确启动与修复确认', async ({ page }) => {
  const state = await fixture(page);
  state.services[0]!.configurationState = 'unknown';
  state.preview = makeGitPreview({ expiresAt: '2020-01-01T00:00:00.000Z' });
  await page.goto(s6ServicePath('review'));
  const review = page.locator('[data-deployment-review]');
  await review.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
  await expect(review).toContainText('提交预览已过期，需要重新审阅');
  const publish = review.getByRole('button', { name: '确认发布并启动', exact: true });
  await expect(publish).toBeDisabled();
  state.preview = makeGitPreview();
  await review.getByRole('button', { name: '载入最新预览', exact: true }).click();
  await review.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
  await expect(review.locator('[data-git-source-summary]')).toContainText(s6Commit);
  await expect(publish).toBeDisabled();
  await review.getByRole('checkbox', { name: /发布并启动这个已停止的服务/ }).check();
  await expect(publish).toBeDisabled();
  await review.getByRole('checkbox', { name: /按此完整配置修复当前不一致状态/ }).check();
  await expect(publish).toBeEnabled();
  expect(writesAt(state, `/services/${s6Ids.service}/deployments`)).toHaveLength(0);
  await publish.click();
  await expect(page).toHaveURL(deploymentPath);
  const request = writesAt(state, `/services/${s6Ids.service}/deployments`)[0]!;
  expect(request.body).toEqual({
    revision: 7,
    previewId: s6Ids.preview,
    deployAndStart: true,
    allowConfigurationRepair: true,
  });
  expect(request.key).toBeTruthy();
});

test('C03：编辑 commit 废弃请求中的旧预览，迟到响应不能覆盖新的固定提交', async ({ page }) => {
  const state = await fixture(page);
  let releaseOld!: () => void;
  let started = false;
  const pending = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const first = '1'.repeat(40),
    second = '2'.repeat(40);
  state.beforePreviewReply = async (input) => {
    if (input.selection.kind === 'commit' && input.selection.commitSha === first) {
      started = true;
      await pending;
    }
  };
  await page.goto(s6ServicePath('review'));
  const review = page.locator('[data-deployment-review]');
  await review.getByLabel('指定完整 commit', { exact: true }).check();
  await review.getByLabel('完整 commit SHA', { exact: true }).fill(first);
  await review.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  try {
    await review.getByLabel('完整 commit SHA', { exact: true }).fill(second);
    await review.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
    await expect(review.locator('[data-git-source-summary]')).toContainText(second);
    releaseOld();
    await expect(review.locator('[data-git-source-summary]')).not.toContainText(first);
    await review.getByRole('checkbox', { name: /发布并启动这个已停止的服务/ }).check();
    await expect(review.getByRole('button', { name: '确认发布并启动', exact: true })).toBeEnabled();
  } finally {
    releaseOld();
  }
  expect(
    writesAt(state, `/services/${s6Ids.service}/git-source/preview`).map((entry) => entry.body),
  ).toEqual([
    { revision: 7, selection: { kind: 'commit', commitSha: first } },
    { revision: 7, selection: { kind: 'commit', commitSha: second } },
  ]);
});

test('B03/F04：来源与自动策略独立保存，停止期待办只通过明确审阅进入预览', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(s6ServicePath('source'));
  await page.getByLabel('Dockerfile 路径', { exact: true }).fill('deploy/Dockerfile');
  await page.getByRole('button', { name: '保存来源新版本', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存来源新版本', exact: true })).toBeDisabled();
  const save = writesAt(state, `/services/${s6Ids.service}/git-source`)[0]!;
  expect(save.method).toBe('PUT');
  expect(save.body).toMatchObject({ revision: 7, source: { dockerfilePath: 'deploy/Dockerfile' } });
  expect(save.body).not.toHaveProperty('source.autoDeploy');
  await page.getByRole('button', { name: '停用自动发布', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '停用自动发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用自动发布', exact: true })).toBeVisible();
  expect(writesAt(state, `/services/${s6Ids.service}/git-source/policy`)[0]!.body).toEqual({
    revision: 8,
    policyRevision: 2,
    autoDeploy: false,
  });
  expect(state.targets[0]!.state).toBe('pending');
  state.preview.serviceRevision = 9;
  await page.goto(s6ServicePath());
  const pending = page.locator('[data-service-pending-commits]');
  await expect(pending).toContainText('服务已停止');
  await pending.getByRole('link', { name: '审阅此提交', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`target=${s6Ids.target}`));
  await page.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
  await expect(page.locator('[data-deployment-review]')).toContainText('保留的来源版本');
  expect(writesAt(state, `/services/${s6Ids.service}/git-source/preview`)[0]!.body).toEqual({
    revision: 9,
    selection: { kind: 'pending_target', webhookTargetId: s6Ids.target },
  });
  expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
});

test('F04：恢复原发布只创建 resume 操作，Git 事件按服务独立分页保留原身份', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(s6ServicePath());
  await page.getByRole('button', { name: '更多服务操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '恢复原已发布版本', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('不消费待发布提交');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '恢复原已发布版本', exact: true })
    .click();
  await expect(page).toHaveURL(/\/operations\//);
  expect(state.operations[0]!.kind).toBe('service_resume');
  expect(state.targets[0]!.state).toBe('pending');
  expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
  await page.goto('/deployments?tab=events');
  await expect(page.getByText(/审计保留 24 小时/)).toBeVisible();
  await page.getByRole('link', { name: '查看各服务投递', exact: true }).click();
  await expect(page.locator('[data-git-targets] > li')).toHaveCount(1);
  await page.getByRole('button', { name: '载入更多服务投递', exact: true }).click();
  await expect(page.locator('[data-git-targets] > li')).toHaveCount(2);
  await expect(page.locator('[data-git-targets] > li').last()).toContainText('原服务已删除');
  await expect(
    page
      .locator('[data-git-targets] > li')
      .last()
      .getByRole('link', { name: '审阅此提交', exact: true }),
  ).toHaveCount(0);
  expect(
    state.reads
      .filter((entry) => entry.path.endsWith('/targets'))
      .some((entry) => entry.query.cursor === 'fixture:1'),
  ).toBe(true);
});

test('F01/F06：Registry 未核验仍复用原 digest，OCI 过期与远端未知均阻止重试', async ({ page }) => {
  const state = await fixture(page);
  state.services[0]!.desiredState = 'running';
  await page.goto(deploymentPath);
  await expect(page.locator('[data-build-summary]')).toContainText('已推送，等待独立镜像核验');
  await page.getByRole('button', { name: '审阅原部署重试', exact: true }).click();
  const review = page.locator('[data-deployment-review]');
  await expect(review).toContainText('原 Registry digest');
  await expect(review.getByRole('button', { name: '确认创建重试部署', exact: true })).toBeEnabled();
  state.deployments[0]!.build = makeBuild('oci');
  if (state.deployments[0]!.build!.artifact.state !== 'none')
    state.deployments[0]!.build!.artifact.availability = 'expired';
  await page.reload();
  await page.getByRole('button', { name: '审阅原部署重试', exact: true }).click();
  await expect(review).toContainText('不能通过重试重新构建');
  await expect(
    review.getByRole('button', { name: '确认创建重试部署', exact: true }),
  ).toBeDisabled();
  state.deployments[0]!.build = makeBuild('none');
  state.deployments[0]!.build!.runs = [
    makeBuildRun({ observationState: 'unknown', proofVerifiedAt: null }),
  ];
  await page.reload();
  await page.getByRole('button', { name: '审阅原部署重试', exact: true }).click();
  await expect(review).toContainText('暂不能创建新的重试');
  await expect(
    review.getByRole('button', { name: '确认创建重试部署', exact: true }),
  ).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('F06：构建日志保留大序号顺序、分页和过期状态，平台日志独立显示', async ({ page }) => {
  const state = await fixture(page);
  state.deployments[0]!.build!.runs.push(makeBuildRun({ id: s6Ids.secondRun, runNumber: 2 }));
  await page.goto(deploymentPath);
  const logs = page.locator('[data-build-logs]');
  await expect(logs).toContainText('已超过保留期限');
  await logs.getByLabel('选择构建执行', { exact: true }).selectOption(s6Ids.run);
  await expect(logs.locator('.build-chunk pre')).toHaveText([
    'large-sequence-first',
    'large-sequence-second',
  ]);
  await logs.getByRole('button', { name: '暂停跟随', exact: true }).click();
  await logs.getByRole('button', { name: '载入后续构建日志', exact: true }).click();
  await expect(logs.getByRole('button', { name: /新增 1 段/ })).toBeVisible();
  await expect(logs).toContainText('服务端已按保留上限截断部分构建输出');
  await expect(logs.locator('.build-chunk pre')).toHaveText([
    'large-sequence-first',
    'large-sequence-second',
    'retained-registry-digest',
  ]);
  await expect(page.getByText('controlled-platform-deployment-log', { exact: true })).toBeVisible();
  await logs.getByLabel('选择构建执行', { exact: true }).selectOption(s6Ids.secondRun);
  await expect(logs.locator('.build-chunk')).toHaveCount(0);
  await expect(logs).toContainText('已超过保留期限');
  await logs.getByLabel('选择构建执行', { exact: true }).selectOption(s6Ids.run);
  await expect(logs.locator('.build-chunk')).toHaveCount(2);
  state.logPages[0] = {
    ...state.logPages[0]!,
    available: false,
    unavailableReason: 'expired',
    items: [],
    pageInfo: { hasMore: false, nextCursor: null },
  };
  await logs.getByRole('button', { name: '刷新构建日志', exact: true }).click();
  await expect(logs.locator('.build-chunk')).toHaveCount(0);
  await expect(logs).toContainText('已超过保留期限');
});

test('F06：取消只记录意图，观察未知时保持运行并等待远端结束证明', async ({ page }) => {
  const state = await fixture(page);
  state.deployments[0]!.status = 'running';
  state.deployments[0]!.finishedAt = null;
  state.deployments[0]!.build!.runs = [
    makeBuildRun({
      executionState: 'open',
      executionClosedAt: null,
      proofVerifiedAt: null,
      observationState: 'unknown',
    }),
  ];
  await page.goto(deploymentPath);
  await expect(page.locator('[data-build-summary]')).toContainText('远端执行尚未确认结束');
  await page.getByRole('button', { name: '请求取消', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '请求取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消待确认', exact: true })).toBeDisabled();
  await expect(
    page.getByText('取消意图已记录，正在等待执行器确认结束。', { exact: true }),
  ).toBeVisible();
  expect(state.deployments[0]!.status).toBe('running');
  await expect(page.getByRole('button', { name: '审阅原部署重试', exact: true })).toHaveCount(0);
});

test('F06：活动日志逐页追到尾部，窗口有界且后续只轮询尾页', async ({ page }) => {
  const state = await fixture(page);
  state.deployments[0]!.status = 'running';
  state.deployments[0]!.finishedAt = null;
  const firstPage = state.logPages[0]!;
  state.logPages = Array.from({ length: 6 }, (_, index) => ({
    ...firstPage,
    items: Array.from({ length: 50 }, (_, item) => ({
      sequence: String(9007199254740992n + BigInt(index * 50 + item)),
      phase: 'building',
      timestamp: s6Time,
      content: `bounded-output-${index}-${item}:` + 'x'.repeat(1024),
      truncated: false,
    })),
    pageInfo: { hasMore: index < 5, nextCursor: index < 5 ? `fixture:${index + 1}` : null },
  }));
  await page.goto(deploymentPath);
  const logs = page.locator('[data-build-logs]');
  await expect(logs).toContainText('bounded-output-5-49:');
  await expect(logs).toContainText('较早输出已移出此窗口');
  const retained = await logs.locator('.build-chunk pre').allTextContents();
  expect(retained.length).toBeLessThanOrEqual(200);
  expect(retained.reduce((count, value) => count + value.length, 0)).toBeLessThanOrEqual(200_000);
  const requests = () => state.reads.filter((entry) => entry.path.endsWith('/build-logs'));
  await expect
    .poll(() => requests().filter((entry) => entry.query.cursor === 'fixture:5').length)
    .toBeGreaterThanOrEqual(2);
  expect(requests().filter((entry) => !entry.query.cursor)).toHaveLength(1);
  expect(requests().filter((entry) => entry.query.cursor === 'fixture:1')).toHaveLength(1);
});

test('G04/B03/C03/F01：深浅色、窄屏操作与当前导航保持可见', async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => localStorage.setItem('ozz.appearance', 'system'));
  state.deliveries[0]!.ref = 'refs/heads/' + 'long-release-name-'.repeat(12);
  const artifactDir = fileURLToPath(
    new URL(`../artifacts/s6-interface/${process.env.S6_UI_RUN_ID ?? 'latest'}`, import.meta.url),
  );
  await mkdir(artifactDir, { recursive: true });
  const results: Array<{
    path: string;
    width: number;
    dark: boolean;
    overflow: number;
  }> = [];
  const paths = [
    '/settings?tab=git&integration=builders',
    createPath,
    s6ServicePath('review'),
    deploymentPath,
    '/deployments?tab=events',
  ];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const dark = width === 390;
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    for (const [index, path] of paths.entries()) {
      await page.goto(path);
      if (dark) await expect(page.locator('html')).toHaveClass(/dark/);
      else await expect(page.locator('html')).not.toHaveClass(/dark/);
      if (path === s6ServicePath('review'))
        await expect(page.getByRole('dialog', { name: '部署服务', exact: true })).toBeVisible();
      else if (path === createPath)
        await expect(creation(page).getByRole('heading', { level: 1 })).toBeVisible();
      else await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('status', { name: '正在载入', exact: true })).toHaveCount(0);
      if (path === s6ServicePath('review')) {
        await page.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
        await expect(page.locator('[data-git-source-summary]')).toContainText(s6Commit);
      }
      if (path.includes('/settings')) {
        const current = page
          .getByRole('navigation', { name: 'Git 与构建集成', exact: true })
          .getByRole('link', { name: '独立 Builder', exact: true });
        const visible = await current.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const nav = element.parentElement!.getBoundingClientRect();
          return bounds.left >= nav.left - 1 && bounds.right <= nav.right + 1;
        });
        expect(visible, '当前集成导航应处于可视范围').toBe(true);
        await current.focus();
        await expect(current).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        const previous = page
          .getByRole('navigation', { name: 'Git 与构建集成', exact: true })
          .getByRole('link', { name: 'Registry 推送与拉取', exact: true });
        await expect(previous).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL('/settings?tab=git&integration=registries');
        await current.focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL('/settings?tab=git&integration=builders');
        await expect(
          page.getByRole('heading', { name: '独立 Builder', exact: true }),
        ).toBeVisible();
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      results.push({ path, width, dark, overflow });
      await writeFile(
        `${artifactDir}/responsive-results.json`,
        JSON.stringify({ source: state.source, results }, null, 2) + '\n',
      );
      expect(overflow, '页面不应出现整体横向溢出').toBeLessThanOrEqual(1);
      if ((width === 1440 && index === 1) || (width === 390 && index === 2))
        await page.screenshot({ path: `${artifactDir}/${width}-${index + 1}.png`, fullPage: true });
    }
  }
  await writeFile(
    `${artifactDir}/responsive-results.json`,
    JSON.stringify({ source: state.source, results }, null, 2) + '\n',
  );
});
