import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { installS5Fixture, s5Ids, s5ServicePath } from './s5-fixture';
import { makeDatabase, makeDeployment, timestamp, s5Namespace } from '../fixtures/s5-data';
import type { VolumeMaintenance } from '../../src/components/storage/types';
import type { WorkloadObservation } from '../../src/components/services/types';

type State = Awaited<ReturnType<typeof installS5Fixture>>;
const runs = new WeakMap<Page, { state: State; errors: string[] }>();
async function fixture(page: Page) {
  const state = await installS5Fixture(page);
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
const servicePath = (tab: string) =>
  `/projects/${s5Ids.project}/services/${s5Ids.service}?environment=staging&tab=${tab}`;
const projectPath = `/projects/${s5Ids.project}?environment=staging`;
const creation = (page: Page) => page.getByRole('dialog', { name: '添加服务', exact: true });
const templatePath = (id = 'postgresql') =>
  `${projectPath}&createService=1&source=template&category=database&template=${id}&version=1.0.0`;
const createVolumePath = `/volumes/new?projectId=${s5Ids.project}&environmentId=${s5Ids.environment}&serviceId=${s5Ids.service}`;
function addDraftReferences(state: State) {
  const service = state.services[0];
  const volume = state.volumes[0];
  const database = state.databases[0];
  service.controller = { kind: 'Deployment', strategy: 'Recreate' };
  const mount = {
    id: s5Ids.mount,
    serviceId: service.id,
    service: { id: service.id, name: service.name, slug: service.slug },
    volumeId: volume.id,
    volume: {
      id: volume.id,
      name: volume.name,
      slug: volume.slug,
      revision: volume.revision,
      destroyedAt: null,
    },
    mountPath: '/draft-data',
    readOnly: false,
    desired: true,
    lastPublishedDeploymentId: null,
    detachedAt: null,
  };
  state.mounts[service.id] = {
    data: [mount],
    serviceRevision: service.revision,
    configRevision: service.configRevision,
  };
  volume.mounts.desired = [mount];
  state.bindings[service.id] = {
    data: [
      {
        id: s5Ids.binding,
        databaseInstanceId: database.id,
        revision: 1,
        profile: 'url',
        mapping: { url: 'DRAFT_DATABASE_URL' },
        desired: true,
        provider: {
          serviceId: database.service!.id,
          name: database.service!.name,
          engine: database.engine,
          ready: true,
        },
        published: false,
        issues: [],
      },
    ],
    serviceRevision: service.revision,
    configRevision: service.configRevision,
  };
}
function maintenance(overrides: Partial<VolumeMaintenance> = {}): VolumeMaintenance {
  return {
    id: '57000000-0000-4000-8000-000000000001',
    purpose: 'backup',
    state: 'active',
    revision: 1,
    enteredAt: timestamp(),
    expiresAt: '2026-01-01T00:00:00.000Z',
    releasedAt: null,
    overdue: true,
    lastErrorCode: null,
    exitBlockers: [],
    ...overrides,
  };
}
async function prepareTemplate(page: Page, id: 'postgresql' | 'redis' = 'postgresql') {
  await page.goto(`${projectPath}&createService=1&source=template&category=database`);
  await creation(page)
    .getByRole('link', {
      name: `使用 ${id === 'redis' ? 'Redis' : 'PostgreSQL'} 模板`,
      exact: true,
    })
    .click();
  await creation(page).getByLabel('服务名称', { exact: true }).fill('受控模板服务');
  await creation(page).locator('summary').filter({ hasText: '标识与描述' }).click();
  await creation(page).getByLabel('服务标识', { exact: true }).fill('controlled-template');
  await expect(creation(page).getByLabel('所属环境', { exact: true })).toHaveCount(0);
  await expect(
    creation(page).getByRole('button', { name: '核对部署配置', exact: true }),
  ).toBeEnabled();
}

test('模板目录、参数核对与响应丢失：冻结本次输入并复用同一持久键', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${projectPath}&createService=1`);
  await expect(creation(page).locator('.source-option')).toHaveCount(4);
  await creation(page)
    .getByRole('link', { name: /添加数据库/ })
    .click();
  await expect(creation(page).locator('[data-template-gallery] article')).toHaveCount(2);
  await creation(page).getByLabel('模板类别', { exact: true }).selectOption('');
  await expect(creation(page).locator('[data-template-gallery] article')).toHaveCount(5);
  await creation(page).getByRole('link', { name: '使用 PostgreSQL 模板', exact: true }).click();
  await creation(page).getByLabel('服务名称', { exact: true }).fill('模板数据库');
  await creation(page).locator('summary').filter({ hasText: '标识与描述' }).click();
  await creation(page).getByLabel('服务标识', { exact: true }).fill('template-database');
  await creation(page).getByLabel('数据库名称', { exact: true }).fill('changed_database');
  const save = creation(page).getByRole('button', { name: '核对部署配置', exact: true });
  await expect(save).toBeEnabled();
  expect(state.operations).toHaveLength(0);
  expect(state.services).toHaveLength(2);
  let releasePreview!: () => void;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let previewStarted = false;
  state.beforeTemplateReply = async () => {
    previewStarted = true;
    await previewGate;
  };
  state.templateSaveReplyLoss = true;
  try {
    await save.click();
    await expect.poll(() => previewStarted).toBe(true);
    await expect(creation(page).getByLabel('数据库名称', { exact: true })).toBeDisabled();
    await expect(creation(page).getByRole('button', { name: '关闭添加服务' })).toBeDisabled();
    expect(state.writes.filter((entry) => entry.path === '/services')).toHaveLength(0);
    releasePreview();
    await expect(creation(page).locator('[data-mutation-error]')).toBeVisible();
    const retry = creation(page).getByRole('button', { name: '重试确认保存结果', exact: true });
    await expect(retry).toBeEnabled();
    await expect(creation(page).getByLabel('数据库名称', { exact: true })).toBeDisabled();
    await retry.click();
    await expect(creation(page).locator('[data-deployment-review]')).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/projects/${s5Ids.project}` &&
        url.searchParams.get('createService') === '1' &&
        url.searchParams.get('createdService') === s5Ids.createdService &&
        url.searchParams.get('environment') === 'staging',
    );
  } finally {
    releasePreview();
  }
  const saves = state.writes.filter((entry) => entry.path === '/services');
  expect(saves).toHaveLength(2);
  expect(saves[0].key).toBeTruthy();
  expect(saves[1].key).toBe(saves[0].key);
  expect(saves[1].body).toEqual(saves[0].body);
  expect(saves[1].body).toMatchObject({
    environmentId: s5Ids.environment,
    projectId: s5Ids.project,
    template: {
      id: 'postgresql',
      version: '1.0.0',
      parameters: { databaseName: 'changed_database', requestedBytes: '1073741824' },
    },
  });
  expect(saves[1].body).not.toHaveProperty('configuration');
  expect(state.services.filter((item) => item.id === s5Ids.createdService)).toHaveLength(1);
  expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
});

test('能力阻止、WFFC 与分步挂载：创建重试不复制卷，挂载冲突保留原卷与输入', async ({ page }) => {
  const state = await fixture(page);
  state.storageStale = true;
  await page.goto(createVolumePath);
  await page.getByLabel('卷名称', { exact: true }).fill('创建保留样本');
  await page.getByLabel('卷标识', { exact: true }).fill('created-kept');
  const create = page.getByRole('button', { name: '创建卷并查看任务', exact: true });
  await expect(create).toBeDisabled();
  state.storageStale = false;
  for (const field of ['permissionsReady', 'capabilitiesTruncated', 'provisionerReady'] as const) {
    state[field] = field === 'capabilitiesTruncated';
    await page.getByRole('button', { name: '刷新存储能力', exact: true }).click();
    await expect(create).toBeDisabled();
    state[field] = field !== 'capabilitiesTruncated';
  }
  await page.getByRole('button', { name: '刷新存储能力', exact: true }).click();
  await expect(create).toBeEnabled();
  state.createReplyLoss = true;
  await create.click();
  await expect(page.locator('[data-mutation-error]')).toBeVisible();
  await create.click();
  await expect(page).toHaveURL(new RegExp(`/volumes/${s5Ids.createdVolume}\\?`));
  const creates = state.writes.filter((entry) => entry.path === '/volumes');
  expect(creates).toHaveLength(2);
  expect(creates[1].key).toBe(creates[0].key);
  expect(creates[0].body).toEqual({
    environmentId: s5Ids.environment,
    name: '创建保留样本',
    slug: 'created-kept',
    requestedBytes: '1073741824',
    storageClassName: 'local-path',
  });
  const created = state.volumes.find((item) => item.id === s5Ids.createdVolume)!;
  created.activeTask = null;
  state.operations[0].status = 'succeeded';
  await page.getByRole('button', { name: '刷新卷详情', exact: true }).click();
  await expect(page.locator('[data-volume-observations]')).toContainText('Pending');
  state.mountConflict = true;
  await page.goto(`${s5ServicePath}&volumeId=${created.id}`);
  const mounts = page.locator('[data-service-volume-mounts]');
  await expect(mounts).toContainText('等待首次消费者，可先保存挂载草稿');
  await mounts.getByLabel('容器挂载路径', { exact: true }).fill('/uploads');
  await mounts.getByRole('button', { name: '保存挂载草稿', exact: true }).click();
  await expect(mounts.locator('[data-mutation-error]')).toContainText('挂载版本冲突');
  await expect(mounts.getByLabel('数据卷', { exact: true })).toHaveValue(created.id);
  await expect(mounts.getByLabel('容器挂载路径', { exact: true })).toHaveValue('/uploads');
  state.mountConflict = false;
  await mounts.getByRole('button', { name: '保存挂载草稿', exact: true }).click();
  await expect(mounts.locator('.mount-list')).toContainText('/uploads');
  expect(state.volumes.filter((item) => item.id === created.id)).toHaveLength(1);
  const mountSaves = state.writes.filter((entry) => entry.path.endsWith('/volume-mounts'));
  expect(mountSaves).toHaveLength(2);
  expect(mountSaves[1].body).toEqual({
    revision: 7,
    volumeId: created.id,
    volumeRevision: created.revision,
    mountPath: '/uploads',
    readOnly: false,
  });
  expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
});

test('同环境数据库分页、变量冲突和过期审阅都保留连接输入', async ({ page }) => {
  const state = await fixture(page);
  state.pageLimit = 1;
  state.databases.unshift(makeDatabase({ id: s5Ids.orphan, service: null, databaseReady: false }));
  state.bindingConflict = true;
  await page.goto(s5ServicePath);
  const bindings = page.locator('[data-service-database-bindings]');
  await expect(
    bindings.getByLabel('数据库', { exact: true }).locator(`option[value="${s5Ids.orphan}"]`),
  ).toBeDisabled();
  await bindings.getByRole('button', { name: '载入更多同环境数据库', exact: true }).click();
  await bindings.getByLabel('数据库', { exact: true }).selectOption(s5Ids.database);
  await bindings.getByRole('button', { name: '预览连接变更', exact: true }).click();
  const save = bindings.getByRole('button', { name: '保存连接草稿', exact: true });
  await expect(bindings.locator('[data-database-binding-preview]')).toContainText(
    '变量 DB_HOST 已由手工配置定义',
  );
  await expect(save).toBeDisabled();
  state.bindingConflict = false;
  await bindings.getByLabel('注入方式', { exact: true }).selectOption('url');
  await bindings.getByRole('button', { name: '预览连接变更', exact: true }).click();
  await expect(save).toBeEnabled();
  await bindings
    .getByLabel('完整连接 URI（秘密引用） → 环境变量', { exact: true })
    .fill('APPLICATION_DATABASE_URL');
  await expect(save).toBeDisabled();
  await bindings.getByRole('button', { name: '预览连接变更', exact: true }).click();
  state.bindingSaveConflict = true;
  await save.click();
  await expect(bindings.locator('[data-mutation-error]')).toContainText('连接版本冲突');
  await expect(
    bindings.getByLabel('完整连接 URI（秘密引用） → 环境变量', { exact: true }),
  ).toHaveValue('APPLICATION_DATABASE_URL');
  state.bindingSaveConflict = false;
  state.services[0].revision++;
  await bindings.getByRole('button', { name: '刷新数据库连接', exact: true }).click();
  await expect(bindings).toContainText('应用版本已变化');
  await expect(save).toBeDisabled();
  await bindings.getByRole('button', { name: '载入当前版本', exact: true }).click();
  await bindings.getByRole('button', { name: '预览连接变更', exact: true }).click();
  await save.click();
  await expect(bindings.locator('.binding-list')).toContainText('APPLICATION_DATABASE_URL');
  const reads = state.reads.filter(
    (entry) => entry.path === '/databases' && !entry.query.serviceId,
  );
  expect(
    reads.every(
      (entry) =>
        entry.query.projectId === s5Ids.project &&
        entry.query.environmentId === s5Ids.environment &&
        entry.query.clusterId === s5Ids.cluster,
    ),
  ).toBe(true);
  expect(reads.some((entry) => entry.query.cursor)).toBe(true);
  const submitted = state.writes
    .filter((entry) => entry.path.endsWith('/database-bindings'))
    .at(-1)!;
  expect(submitted.body).toEqual({
    revision: 8,
    databaseInstanceId: s5Ids.database,
    profile: 'url',
    mapping: { url: 'APPLICATION_DATABASE_URL' },
  });
  expect(JSON.stringify(submitted.body)).not.toContain('postgresql://');
});

test('新数据库首次发布使用明确的未写入身份；已有初始化意图和未知卷仍阻止', async ({ page }) => {
  const state = await fixture(page);
  const service = state.services[1];
  const database = state.databases[0];
  const volume = state.volumes[1];
  service.published = null;
  service.configurationState = 'unpublished';
  database.dataVolume.pvcUid = null;
  database.protection.active = false;
  database.protection.fencedAt = null;
  database.initialization = { state: 'not_started', initializedAt: null, pvcUid: null };
  volume.pvc.uid = null;
  volume.pvc.resourceVersion = null;
  volume.pvc.phase = 'Unknown';
  volume.pv = null;
  volume.manualDataIdentity = null;
  volume.lastAttemptAt = null;
  volume.lastErrorCode = null;
  volume.retainedDatabase!.initializationFenceAt = null;
  volume.retainedDatabase!.initializedAt = null;
  volume.observation = {
    state: 'unknown',
    observedAt: null,
    stale: true,
    code: null,
    message: '尚未完成实际卷观察。',
  };
  state.mounts[service.id] = {
    data: [
      {
        id: s5Ids.mount,
        serviceId: service.id,
        service: { id: service.id, name: service.name, slug: service.slug },
        volumeId: volume.id,
        volume: {
          id: volume.id,
          name: volume.name,
          slug: volume.slug,
          revision: volume.revision,
          destroyedAt: null,
        },
        mountPath: '/data',
        readOnly: false,
        desired: true,
        lastPublishedDeploymentId: null,
        detachedAt: null,
      },
    ],
    serviceRevision: service.revision,
    configRevision: service.configRevision,
  };
  await page.goto(
    `/projects/${service.projectId}/services/${service.id}?environment=staging&tab=review`,
  );
  const review = page.locator('[data-deployment-review]');
  const confirm = review.getByRole('button', { name: '确认发布', exact: true });
  await expect(confirm).toBeEnabled();
  await expect(review).toContainText('数据卷尚未创建。确认首次发布后');

  database.protection.active = true;
  database.protection.fencedAt = timestamp();
  database.initialization.state = 'pending';
  volume.retainedDatabase!.initializationFenceAt = database.protection.fencedAt;
  await review.getByRole('button', { name: '重新核对引用', exact: true }).click();
  await expect(confirm).toBeDisabled();
  await expect(review).toContainText('存储观察需要重新核对');

  database.protection.active = false;
  database.protection.fencedAt = null;
  volume.retainedDatabase!.initializationFenceAt = null;
  await review.getByRole('button', { name: '重新核对引用', exact: true }).click();
  await expect(confirm).toBeDisabled();

  database.initialization.state = 'not_started';
  volume.observation.code = 'STORAGE_CONNECTION_UNAVAILABLE';
  await review.getByRole('button', { name: '重新核对引用', exact: true }).click();
  await expect(confirm).toBeDisabled();
  volume.observation.code = null;
  volume.retainedDatabase = null;
  await review.getByRole('button', { name: '重新核对引用', exact: true }).click();
  await expect(confirm).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('保留数据库可读取；服务删除列明数据卷并拒绝仍有消费者的删除', async ({ page }) => {
  const state = await fixture(page);
  state.databases[0].service = null;
  state.databases[0].databaseReady = false;
  const lockedFields = [
    'configuration.image',
    'configuration.replicas',
    'volumeMounts',
    'credential',
    'configuration.futureFence',
  ];
  state.databases[0].protection.lockedFields = [...lockedFields];
  await page.goto(`/databases/${s5Ids.database}`);
  await expect(page.locator('[data-database-identity]')).toContainText(
    '原服务已删除，数据库数据与身份仍保留',
  );
  await expect(page.locator('[data-database-identity]')).toContainText('应用数据库样本');
  await expect(page.locator('[data-database-protected-fields] > li')).toHaveText([
    '镜像版本',
    '副本数',
    '数据卷挂载',
    '数据库凭证',
  ]);
  const technical = page.locator('[data-database-protection-details]');
  await expect(technical.locator('code')).not.toBeVisible();
  await technical.getByText('其他保护项的技术详情', { exact: true }).click();
  await expect(technical.locator('code')).toHaveText('configuration.futureFence');
  await expect(technical.locator('code')).toBeVisible();
  expect(state.databases[0].protection.lockedFields).toEqual(lockedFields);
  await expect(page.getByRole('link', { name: '打开数据库服务', exact: true })).toHaveCount(0);
  state.deleteBlocked = true;
  await page.goto(servicePath('configuration'));
  await page
    .getByRole('navigation', { name: '服务设置分组' })
    .getByRole('link', { name: '危险操作', exact: true })
    .click();
  const review = page.locator('[data-service-deletion-review]');
  await review.getByRole('button', { name: '审阅服务删除', exact: true }).click();
  await expect(review).toContainText(state.volumes[0].name);
  await expect(review).toContainText(state.volumes[0].pvc.uid!);
  await expect(review).toContainText('仍有应用引用此数据库');
  const confirm = review.getByRole('button', { name: '确认删除服务并保留数据卷', exact: true });
  await expect(confirm).toBeDisabled();
  state.deleteBlocked = false;
  await review.getByRole('button', { name: '重新审阅删除影响', exact: true }).click();
  await confirm.click();
  await expect(page).toHaveURL(/\/operations\//);
  const deletion = state.writes.find((entry) => entry.method === 'DELETE')!;
  expect(deletion.path).toBe(`/services/${s5Ids.service}`);
  expect(deletion.body).toEqual({ revision: 7 });
  expect(deletion.key).toBeTruthy();
  expect(state.volumes).toHaveLength(2);
});

test('卷销毁绑定完整名称、原修订与PVC身份；阻止原因和过期预览不能提交', async ({ page }) => {
  const state = await fixture(page);
  const volume = state.volumes[0];
  volume.deletionBlockers = [
    { code: 'PV_RECLAIM_RETAIN', message: 'Retain 回收策略需要先人工处理数据。' },
  ];
  await page.goto(`/volumes/${volume.id}`);
  await page.getByRole('button', { name: '审阅卷销毁', exact: true }).click();
  const review = page.locator('[data-volume-deletion-preview]');
  const confirm = review.getByRole('button', { name: '确认销毁卷', exact: true });
  await expect(confirm).toBeDisabled();
  await expect(review).toContainText('Retain 回收策略');
  volume.deletionBlockers = [];
  await page.getByRole('button', { name: '审阅卷销毁', exact: true }).click();
  const name = review.getByLabel(/输入完整卷名/);
  await name.fill('不匹配名称');
  await expect(confirm).toBeDisabled();
  await name.fill(volume.name);
  await expect(confirm).toBeEnabled();
  volume.revision++;
  volume.pvc.uid = 'fixture-replaced-pvc-uid';
  await page.getByRole('button', { name: '刷新卷详情', exact: true }).click();
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: '审阅卷销毁', exact: true }).click();
  await name.fill(volume.name);
  await confirm.click();
  await expect(page.locator('[data-volume-operation-context]')).toContainText(
    'fixture-replaced-pvc-uid',
  );
  const deletion = state.writes.find((entry) => entry.method === 'DELETE')!;
  expect(deletion.body).toEqual({
    revision: 4,
    confirmation: {
      volumeId: volume.id,
      pvcUid: 'fixture-replaced-pvc-uid',
      reclaimPolicy: 'Delete',
      previewDigest: 'b'.repeat(64),
      volumeName: volume.name,
    },
  });
  expect(deletion.key).toBeTruthy();
});

test('维护任务与持久锁分离；超时仍锁定，退出与取消后重试保持原会话', async ({ page }) => {
  const state = await fixture(page);
  const volume = state.volumes[0];
  volume.maintenance = maintenance({
    exitBlockers: [{ code: 'HELPER_STILL_PRESENT', message: '辅助 Pod 仍占用卷。' }],
  });
  await page.goto(`/volumes/${volume.id}?tab=manual`);
  const panel = page.locator('[data-volume-maintenance]');
  await expect(panel).toContainText('维护超时 · 仍锁定');
  await expect(panel.getByRole('button', { name: '核验并退出维护', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '核验并进入维护', exact: true })).toHaveCount(0);
  volume.maintenance.exitBlockers = [];
  await page.getByRole('button', { name: '刷新卷详情', exact: true }).click();
  await panel.getByRole('button', { name: '核验并退出维护', exact: true }).click();
  await expect(page.locator('[data-volume-operation-context]')).toContainText(
    '维护锁独立于任务状态保存',
  );
  const operation = state.operations[0];
  operation.status = 'cancelled';
  operation.finishedAt = timestamp();
  await page.getByRole('button', { name: '刷新任务状态', exact: true }).click();
  await page.getByRole('button', { name: '创建重试任务', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(volume.id);
  await page.getByRole('dialog').getByRole('button', { name: '创建重试任务', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/operations/${state.operations[0].id}$`));
  expect(state.operations[0].input).toEqual(operation.input);
  expect(state.operations[0].input).toHaveProperty('maintenanceId', volume.maintenance.id);
  await page.goto(`/volumes/${volume.id}?tab=manual`);
  await expect(panel).toContainText('维护超时 · 仍锁定');
});

test('手工记录明确操作者报告；恢复继承源清单并选择不同的新目标', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/volumes/${s5Ids.volume}?tab=manual`);
  await page.getByRole('button', { name: '添加手工记录', exact: true }).click();
  const form = page.locator('[data-manual-data-record-form]');
  await form.getByLabel('备份清单 ID', { exact: true }).fill('fixture-backup-manifest');
  await form.getByLabel('引擎或数据版本', { exact: true }).fill('files-v1');
  await form.getByLabel('数据布局', { exact: true }).fill('uploads-v1');
  await form.getByLabel('备份格式', { exact: true }).fill('tar');
  await form.getByLabel('清单大小（字节）', { exact: true }).fill('4096');
  await form.getByLabel('SHA256', { exact: true }).fill('a'.repeat(64));
  await form.getByLabel('离机副本位置标签', { exact: true }).fill('fixture-vault/off-host-copy');
  await form.getByLabel('可恢复的数据时间点说明', { exact: true }).fill('受控样本数据时间点');
  await fillExecution(form, 'tar 1.35');
  await form.getByRole('button', { name: '保存手工记录', exact: true }).click();
  await expect(page.locator('[data-manual-data-records]')).toContainText('操作者报告');
  await expect(form).toHaveCount(0);
  const backup = state.manualRecords[0];
  expect(backup.verificationSource).toBe('operator_reported');
  expect(backup.source).toEqual(state.volumes[0].manualDataIdentity);
  await page.getByRole('button', { name: '添加手工记录', exact: true }).click();
  await form.getByLabel('记录类型', { exact: true }).selectOption('restore');
  await form.getByLabel('已登记的备份清单', { exact: true }).selectOption(backup.id);
  await expect(
    form.getByLabel('恢复目标', { exact: true }).locator(`option[value="${s5Ids.volume}"]`),
  ).toHaveCount(0);
  await form.getByLabel('恢复目标', { exact: true }).selectOption(s5Ids.databaseVolume);
  await expect(form.getByLabel('SHA256', { exact: true })).toHaveCount(0);
  await fillExecution(form, 'tar 1.36');
  await form.getByRole('button', { name: '保存手工记录', exact: true }).click();
  await expect(form).toHaveCount(0);
  const restore = state.manualRecords[0];
  expect(restore).toMatchObject({
    type: 'restore',
    backupId: backup.backupId,
    source: backup.source,
    sizeBytes: backup.sizeBytes,
    sha256: backup.sha256,
    toolVersion: 'tar 1.36',
    target: state.volumes[1].manualDataIdentity,
    verificationSource: 'operator_reported',
  });
  expect(
    state.writes
      .filter((entry) => entry.path.endsWith('/manual-data-records'))
      .every((entry) => entry.path === `/volumes/${s5Ids.volume}/manual-data-records`),
  ).toBe(true);
});
async function fillExecution(form: ReturnType<Page['locator']>, tool: string) {
  await form.getByLabel('本次执行工具与版本', { exact: true }).fill(tool);
  await form.getByLabel('执行开始时间（本地时间）', { exact: true }).fill('2026-10-26T10:00');
  await form.getByLabel('执行结束时间（本地时间）', { exact: true }).fill('2026-10-26T10:01');
  await form.getByLabel('完整性校验结果', { exact: true }).selectOption('passed');
  await form.getByLabel('本次数据验证结果', { exact: true }).selectOption('passed');
  await form.getByLabel('实际验证步骤', { exact: true }).fill('检查受控清单散列与新目标数据计数');
  await form.getByLabel('证据引用', { exact: true }).fill('fixture://manual-data-evidence');
}

test('发布审阅核对独立引用集合版本，读取失败与维护中都禁止发布', async ({ page }) => {
  const state = await fixture(page);
  addDraftReferences(state);
  state.refsError = true;
  await page.goto(servicePath('review'));
  const review = page.locator('[data-deployment-review]');
  const submit = review.getByRole('button', { name: '确认发布', exact: true });
  await expect(submit).toBeDisabled();
  await expect(review).toContainText('受控挂载集合读取失败');
  state.refsError = false;
  state.refsMismatch = true;
  await page.goto(servicePath('review'));
  await expect(review).toContainText('数据引用集合与这次服务预览版本不一致');
  await expect(submit).toBeDisabled();
  state.refsMismatch = false;
  state.volumes[0].maintenance = maintenance();
  await review.getByRole('button', { name: '重新核对引用', exact: true }).click();
  await expect(review).toContainText('仍处于数据维护锁定状态');
  await expect(submit).toBeDisabled();
  state.volumes[0].maintenance = null;
  await review.getByRole('button', { name: '重新核对引用', exact: true }).click();
  await expect(review).toContainText('/draft-data');
  await expect(review).toContainText('DRAFT_DATABASE_URL');
  await expect(review).toContainText(s5Ids.credential);
  await expect(review).toContainText('发布期间服务会中断');
  await expect(submit).toBeEnabled();
  state.services[0].revision++;
  // The service keeps polling while its deployment panel is open. Its original preview must expire.
  await expect(review).toContainText('服务资料已更新，需要重新审阅', { timeout: 15_000 });
  await expect(submit).toBeDisabled();
  await review.getByRole('button', { name: '载入最新预览', exact: true }).click();
  await expect(submit).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});

test('持久维护和未完成的卷任务阻止新增挂载，WFFC解除任务后可保存', async ({ page }) => {
  const state = await fixture(page);
  const volume = state.volumes[0];
  volume.maintenance = maintenance();
  const path = `${s5ServicePath}&volumeId=${volume.id}`;
  await page.goto(path);
  const panel = page.locator('[data-service-volume-mounts]');
  const save = panel.getByRole('button', { name: '保存挂载草稿', exact: true });
  await expect(panel).toContainText('仍处于持久维护锁定状态');
  await expect(save).toBeDisabled();
  volume.maintenance = null;
  volume.activeTask = {
    type: 'operation',
    id: '53000000-0000-4000-8000-000000000001',
    kind: 'volume_create',
    status: 'running',
  };
  await page.goto(path);
  await expect(panel).toContainText('未完成的存储任务');
  await expect(save).toBeDisabled();
  volume.activeTask = null;
  await page.goto(path);
  await expect(panel).toContainText('等待首次消费者，可先保存挂载草稿');
  await expect(save).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});

test('数据库服务的初始化配置只读，名称和资源仍可编辑', async ({ page }) => {
  await fixture(page);
  await page.goto(
    `/projects/${s5Ids.project}/services/${s5Ids.databaseService}?environment=staging&tab=configuration`,
  );
  await expect(page.locator('[data-database-config-protection]')).toContainText(
    '本页不能执行密码轮换或主版本升级',
  );
  await expect(page.getByLabel('镜像地址', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('镜像拉取凭证', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('服务名称', { exact: true })).toBeEditable();
  await page.locator('summary').filter({ hasText: '启动方式与资源' }).click();
  await expect(page.getByLabel('启动命令（JSON 数组）', { exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await expect(page.getByLabel('副本数', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('每副本 CPU（mCPU）', { exact: true }).first()).toBeEditable();
  await expect(page.getByLabel('容器端口', { exact: true })).toBeDisabled();
});

test('v2部署重试只读取原控制器、卷和数据库快照，不载入当前挂载草稿', async ({ page }) => {
  const state = await fixture(page);
  addDraftReferences(state);
  const original = state.deployments[0];
  await page.goto(`/deployments/${original.id}`);
  await expect(page.locator('[data-deployment-storage-snapshot]')).toContainText('/original-data');
  await page.getByRole('button', { name: '审阅原部署重试', exact: true }).click();
  const retry = page.locator('[data-deployment-review]');
  await expect(retry).toContainText('ORIGINAL_DATABASE_URL');
  await expect(retry).toContainText('fixture-original-provider-service-uid');
  await expect(retry).not.toContainText('/draft-data');
  await expect(retry).not.toContainText('DRAFT_DATABASE_URL');
  expect(
    state.reads.some(
      (entry) => entry.path.endsWith('/volume-mounts') || entry.path.endsWith('/database-bindings'),
    ),
  ).toBe(false);
  await retry.getByRole('button', { name: '确认创建重试部署', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`/deployments/${original.id}$`));
  expect(state.deployments[0].snapshot).toEqual(original.snapshot);
  const request = state.writes.at(-1)!;
  expect(request.path).toBe(`/deployments/${original.id}/retry`);
  expect(request.key).toBeTruthy();
  expect(request.body).toEqual({
    revision: 7,
    deployAndStart: false,
    allowConfigurationRepair: false,
  });
});

test('StatefulSet运行与失败证据显示实际控制器及Pod归属', async ({ page }) => {
  const state = await fixture(page);
  const observation = statefulObservation();
  state.services[0].controller = { kind: 'StatefulSet', strategy: 'RollingUpdate' };
  state.services[0].observation = observation;
  state.services[0].lastObservedAt = observation.observedAt;
  state.services[0].observationStale = false;
  await page.goto(servicePath('usage'));
  const runtime = page.locator('[data-service-runtime]');
  await expect(runtime.locator('[data-workload-controller]')).toContainText('StatefulSet');
  await expect(runtime.locator('.runtime-summary')).toContainText('1 / 1');
  await runtime.getByText('实例身份', { exact: true }).click();
  await expect(runtime).toContainText('StatefulSet / fixture-statefulset-uid');
  const deployment = state.deployments[0];
  deployment.failureObservation = {
    attempt: 1,
    errorCode: 'FIXTURE_HEALTH_TIMEOUT',
    capturedAt: timestamp(),
    observedAt: timestamp(),
    configurationState: 'consistent',
    drift: [],
    resources: [],
    deployment: null,
    controller: observation.controller,
    pods: observation.pods,
    truncated: { drift: false, resources: false, pods: false },
  };
  await page.goto(`/deployments/${deployment.id}`);
  const failure = page.locator('[data-deployment-failure-observation]');
  await failure.getByText('失败时的运行状态', { exact: true }).click();
  await expect(failure).toContainText('StatefulSet / fixture-statefulset-uid');
  await expect(failure).toContainText('1 / 1');
  await expect(failure).not.toContainText('ReplicaSet');
});
function statefulObservation(): WorkloadObservation {
  return {
    observedAt: timestamp(),
    configurationState: 'consistent',
    drift: [],
    resources: [],
    deployment: null,
    controller: {
      kind: 'StatefulSet',
      strategy: 'RollingUpdate',
      uid: 'fixture-statefulset-uid',
      resourceVersion: '1',
      generation: 1,
      observedGeneration: 1,
      replicas: 1,
      currentReplicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      snapshotId: makeDeployment().id,
      configRevision: 3,
      mutationRevision: 1,
      rolloutId: 'fixture-rollout',
      image: 'example.test/postgres@sha256:' + 'a'.repeat(64),
      templateFingerprint: 'fixture-template',
      workloadFingerprint: 'fixture-workload',
      progressDeadlineExceeded: false,
      deleting: false,
      currentRevision: 'fixture-revision',
      updateRevision: 'fixture-revision',
    },
    pods: [
      {
        uid: 'fixture-pod-uid',
        name: 'database-0',
        namespace: s5Namespace,
        nodeName: 'fixture-node',
        createdAt: timestamp(),
        deletionTimestamp: null,
        phase: 'Running',
        ready: true,
        snapshotId: makeDeployment().id,
        configRevision: 3,
        rolloutId: 'fixture-rollout',
        replicaSetUid: null,
        owner: { kind: 'StatefulSet', uid: 'fixture-statefulset-uid' },
        matchesControllerTemplate: true,
        matchesDeploymentTemplate: false,
        containers: [],
      },
    ],
    podsTruncated: false,
    events: [],
    eventsState: 'available',
    eventsTruncated: false,
    metrics: {
      state: 'unknown',
      cpuCores: null,
      memoryBytes: null,
      observedAt: null,
      windowSeconds: null,
    },
    metricsErrorCode: null,
    serviceDns: null,
  };
}

test('恢复只读阻止预览和写入；模板受理中禁止离开，结果回到同一服务复核', async ({ page }) => {
  const state = await fixture(page);
  state.restoreMode = true;
  await page.goto(templatePath('redis'));
  await expect(
    creation(page).getByRole('button', { name: '核对部署配置', exact: true }),
  ).toBeDisabled();
  await page.goto(`/volumes/${s5Ids.volume}?tab=manual`);
  await expect(page.getByRole('button', { name: '核验并进入维护', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加手工记录', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  state.restoreMode = false;
  await prepareTemplate(page, 'redis');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.beforeTemplateSaveReply = () => gate;
  try {
    await creation(page).getByRole('button', { name: '核对部署配置', exact: true }).click();
    await expect
      .poll(() => state.writes.filter((entry) => entry.path === '/services').length)
      .toBe(1);
    await expect(
      creation(page).getByRole('button', { name: '关闭添加服务', exact: true }),
    ).toBeDisabled();
    await expect(creation(page).getByLabel('服务名称', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(creation(page).getByLabel('服务名称', { exact: true })).toHaveValue(
      '受控模板服务',
    );
    await page.goBack();
    await expect(creation(page)).toBeVisible();
    await expect(page).toHaveURL(/createService=1/);
    const reply = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/services',
    );
    release();
    await reply;
    await expect(creation(page).locator('[data-deployment-review]')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`createdService=${s5Ids.createdService}`));
    expect(state.services.filter((item) => item.id === s5Ids.createdService)).toHaveLength(1);
    expect(state.writes.filter((entry) => entry.path === '/services')).toHaveLength(1);
    expect(state.writes.some((entry) => entry.path.endsWith('/deployments'))).toBe(false);
  } finally {
    release();
  }
});

test('light/dark × 1440/1024/390：模板、数据库、卷与数据表单可操作且无页面溢出', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const state = await fixture(page);
  addDraftReferences(state);
  state.volumes[0].maintenance = maintenance();
  const artifactDir = fileURLToPath(new URL('../artifacts/s5-interface', import.meta.url));
  await mkdir(artifactDir, { recursive: true });
  const results: {
    width: number;
    dark: boolean;
    path: string;
    overflow: number;
  }[] = [];
  const paths = [
    '/templates',
    templatePath(),
    '/databases',
    `/databases/${s5Ids.database}`,
    '/volumes',
    createVolumePath,
    `/volumes/${s5Ids.volume}`,
    `/volumes/${s5Ids.volume}?tab=manual`,
    s5ServicePath,
    servicePath('review'),
    `/deployments/${state.deployments[0].id}`,
  ];
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const dark of [false, true]) {
      await page.goto('/templates');
      await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
      await page.getByRole('menuitemradio', { name: dark ? '深色' : '浅色', exact: true }).click();
      await expect(page.locator('html')).toHaveCSS('color-scheme', dark ? 'dark' : 'light');
      for (const path of paths) {
        await page.goto(path);
        if (path === servicePath('review')) {
          await expect(page.getByRole('dialog', { name: '部署服务', exact: true })).toBeVisible();
          await expect(page.locator('[data-deployment-review]')).toBeVisible();
        } else if (path === templatePath()) {
          await expect(creation(page).getByRole('heading', { level: 1 })).toBeVisible();
          await expect(
            creation(page).getByRole('button', { name: '核对部署配置', exact: true }),
          ).toBeVisible();
        } else await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('status', { name: '正在载入', exact: true })).toHaveCount(0);
        if (path === `/volumes/${s5Ids.volume}?tab=manual`) {
          await page.getByRole('button', { name: '添加手工记录', exact: true }).click();
          await expect(page.locator('[data-manual-data-record-form]')).toBeVisible();
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        results.push({ width, dark, path, overflow });
        expect(overflow, `${width} ${dark} ${path}`).toBeLessThanOrEqual(1);
      }
      if ((width === 1440 && !dark) || (width === 390 && dark))
        await page.screenshot({
          path: `${artifactDir}/snapshot-${width}-${dark ? 'dark' : 'light'}.png`,
          fullPage: true,
        });
    }
  }
  await writeFile(
    `${artifactDir}/responsive-results.json`,
    JSON.stringify({ source: state.source, realInfrastructure: false, results }, null, 2),
  );
});
