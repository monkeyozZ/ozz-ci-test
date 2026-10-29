import { expect, test, type Page, type Route } from '@playwright/test';
import { installCreationFixture } from './creation-v3-fixture';
import { s5Ids, timestamp } from '../fixtures/s5-data';
import type { Cluster, Operation, SecretReference, Server } from '../../src/lib/types';

const serverId = '57000000-0000-4000-8000-000000000001';
const secretId = '57000000-0000-4000-8000-000000000002';
const secondSecretId = '57000000-0000-4000-8000-000000000003';
const runs = new WeakMap<Page, { errors: string[]; unexpected: string[] }>();
const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
const list = (route: Route, data: unknown[]) =>
  json(route, { data, page: { hasMore: false, nextCursor: null } });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function fixture(page: Page) {
  const base = await installCreationFixture(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { errors, unexpected: base.core.unexpected });
  const secret: SecretReference = {
    id: secretId,
    name: 'SSH 连接样本',
    kind: 'ssh',
    revision: 1,
    keyVersion: 1,
    expiresAt: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
  const server: Server = {
    id: serverId,
    name: '服务器交互样本',
    revision: 2,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    initializationVersion: 'v1.34.1+k3s1',
    hostKey: {
      trustedFingerprint: 'SHA256:fixture-host-key',
      trustedAt: timestamp(),
      trustSource: '受控界面样本',
      observedFingerprint: 'SHA256:fixture-host-key',
      observedAlgorithm: 'ssh-ed25519',
      observedAt: timestamp(),
      discoveryOperationId: '57000000-0000-4000-8000-000000000004',
    },
    machineId: 'fixture-only-machine',
    preflight: null,
    preflightAt: null,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastOperationId: null,
    host: '192.0.2.77',
    sshPort: 22,
    sshUser: 'fixture-admin',
    credentialRefId: secretId,
    region: 'fixture',
    tags: [],
    connectionStatus: 'unverified',
    lastObservedAt: null,
  };
  const cluster: Cluster = {
    id: s5Ids.cluster,
    name: '集群交互样本',
    slug: 'polish-cluster',
    revision: 3,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    identity: { kubeSystemUid: 'fixture-system', caFingerprint: 'SHA256:fixture-ca' },
    observation: null,
    observationStale: true,
    nodeCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastOperationId: null,
    description: null,
    region: 'fixture',
    apiEndpoint: 'https://192.0.2.77:6443',
    credentialRefId: secondSecretId,
    connectionStatus: 'connected',
    lastObservedAt: timestamp(),
    projectCount: 0,
  };
  const state = {
    base,
    server,
    cluster,
    secrets: [secret, { ...secret, id: secondSecretId, name: '另一份凭证样本' }],
    writes: [] as { path: string; method: string; body: unknown; key: string | null }[],
    operations: new Map<string, Operation>(),
    beforeWrite: undefined as undefined | (() => Promise<void>),
    beforeSecretsRead: undefined as undefined | (() => Promise<void>),
    failWrite: false,
  };
  function queued(kind: Operation['kind'], scope: 'server' | 'cluster') {
    const id = `57000000-0000-4000-8000-${String(100 + state.operations.size).padStart(12, '0')}`;
    const operation: Operation = {
      id,
      kind,
      scope,
      serverId: scope === 'server' ? serverId : null,
      clusterId: scope === 'cluster' ? s5Ids.cluster : null,
      serviceId: null,
      status: 'queued',
      input: { targetId: scope === 'server' ? serverId : s5Ids.cluster, connectionRevision: 2 },
      result: null,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      retryOfId: null,
      cancelRequestedAt: null,
      pollUrl: `/api/operations/${id}`,
    };
    state.operations.set(id, operation);
    return operation;
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(4);
    const method = request.method();
    if (method === 'GET') {
      if (path === '/secrets') {
        await state.beforeSecretsRead?.();
        return list(route, state.secrets);
      }
      if (path === '/servers') return list(route, [state.server]);
      if (path === `/servers/${serverId}`) return json(route, { data: state.server });
      if (path === '/clusters') return list(route, [state.cluster]);
      if (path === `/clusters/${s5Ids.cluster}`) return json(route, { data: state.cluster });
      if (path === `/servers/${serverId}/nodes` || path === `/clusters/${s5Ids.cluster}/nodes`)
        return list(route, []);
      if (path.startsWith('/operations/') && state.operations.has(path.split('/')[2]!))
        return json(route, { data: state.operations.get(path.split('/')[2]!) });
      return route.fallback();
    }
    const action = path.startsWith(`/servers/${serverId}/`) ? path.split('/').at(-1) : '';
    const isSecret = path === '/secrets' && method === 'POST';
    const isDelete = path.startsWith('/secrets/') && method === 'DELETE';
    const isSync = path === `/clusters/${s5Ids.cluster}/sync` && method === 'POST';
    if (
      !isSecret &&
      !isDelete &&
      !isSync &&
      !['discover-host-key', 'trust-host-key', 'preflight'].includes(action || '')
    )
      return route.fallback();
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.writes.push({ path, method, body, key: request.headers()['idempotency-key'] ?? null });
    await state.beforeWrite?.();
    if (state.failWrite)
      return json(
        route,
        { code: 'FIXTURE_ACTION_FAILED', detail: '受控请求失败，请保留当前输入重试。' },
        403,
      );
    if (isSecret) {
      const created = {
        ...secret,
        id: '57000000-0000-4000-8000-000000000010',
        name: body.name,
        kind: body.kind,
      };
      state.secrets.push(created);
      return json(route, { data: created }, 201);
    }
    if (isDelete) {
      state.secrets = state.secrets.filter((value) => value.id !== path.split('/')[2]);
      return json(route, { data: null });
    }
    if (action === 'trust-host-key') {
      state.server.hostKey.trustedFingerprint = body.fingerprint;
      state.server.hostKey.trustSource = body.source;
      state.server.hostKey.trustedAt = timestamp();
      return json(route, { data: state.server });
    }
    const operation = queued(
      isSync ? 'cluster_sync' : action === 'preflight' ? 'server_preflight' : 'ssh_discover',
      isSync ? 'cluster' : 'server',
    );
    return json(route, { data: operation }, 202);
  });
  return state;
}

test.afterEach(({ page }) => {
  const run = runs.get(page);
  if (!run) return;
  expect(run.errors, '浏览器脚本错误').toEqual([]);
  expect(run.unexpected, '未声明的 API 请求').toEqual([]);
});

test('凭证类型切换先确认，取消保留输入，连续切换不把旧私钥带到其他类型', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: '新增凭证', exact: true }).click();
  await page.getByLabel('凭证名称', { exact: true }).fill('保留凭证名称');
  const kind = page.getByLabel('类型', { exact: true });
  const key = page.getByLabel('私钥内容', { exact: true });
  await key.fill('fixture-only-private-key');
  await page.getByLabel('私钥口令', { exact: false }).fill('fixture-only-passphrase');
  await kind.focus();
  await kind.selectOption('registry');
  const confirm = page.getByRole('dialog', { name: '切换凭证类型？', exact: true });
  await expect(confirm).toBeVisible();
  await expect(kind).toHaveValue('ssh');
  await expect(key).toHaveValue('fixture-only-private-key');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(kind).toBeFocused();
  await expect(key).toHaveValue('fixture-only-private-key');
  await kind.evaluate((element) => {
    const select = element as HTMLSelectElement;
    for (const value of ['registry', 'builder']) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await expect(confirm).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(kind).toHaveValue('ssh');
  await confirm.getByRole('button', { name: '清空并切换', exact: true }).click();
  await expect(kind).toHaveValue('registry');
  await expect(page.getByLabel('凭证名称', { exact: true })).toHaveValue('保留凭证名称');
  const password = page.getByLabel('仓库密码或令牌', { exact: true });
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('');
  expect(state.writes).toHaveLength(0);
});

test('凭证保存慢请求和失败保留输入，同一键重试成功才清空并回到新增入口', async ({ page }) => {
  const state = await fixture(page);
  state.secrets = [];
  const wait = deferred();
  const refreshed = deferred();
  state.beforeWrite = () => wait.promise;
  state.failWrite = true;
  try {
    await page.goto('/settings');
    await page.getByRole('button', { name: '新增凭证', exact: true }).last().click();
    await page.getByLabel('凭证名称', { exact: true }).fill('慢请求凭证');
    await page.getByLabel('类型', { exact: true }).selectOption('generic');
    await page.getByLabel('凭证内容', { exact: true }).fill('fixture-only-secret');
    await page.getByRole('button', { name: '加密保存凭证', exact: true }).click();
    const pending = page.getByRole('button', { name: '正在保存…', exact: true });
    await expect(pending).toBeDisabled();
    await expect(page.getByRole('button', { name: '取消并清空', exact: true })).toBeDisabled();
    await pending.click({ force: true });
    await expect.poll(() => state.writes.length).toBe(1);
    wait.release();
    await expect(page.getByRole('alert')).toContainText('受控请求失败');
    await expect(page.getByLabel('凭证内容', { exact: true })).toHaveValue('fixture-only-secret');
    state.beforeWrite = undefined;
    state.failWrite = false;
    state.beforeSecretsRead = () => refreshed.promise;
    await page.getByRole('button', { name: '加密保存凭证', exact: true }).click();
    const refreshing = page.getByRole('button', { name: '正在刷新凭证…', exact: true });
    await expect(refreshing).toHaveCount(2);
    await expect(refreshing.nth(0)).toBeDisabled();
    await expect(refreshing.nth(1)).toBeDisabled();
    await expect(page.locator('#secret-value')).toHaveCount(0);
    refreshed.release();
    await expect(page.getByRole('button', { name: '新增凭证', exact: true })).toBeFocused();
    expect(state.writes).toHaveLength(2);
    expect(state.writes[0]!.key).toBeTruthy();
    expect(state.writes[1]!.key).toBe(state.writes[0]!.key);
    expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
    await expect(page.locator('#secret-value')).toHaveCount(0);
    await page.getByRole('button', { name: '新增凭证', exact: true }).click();
    await page.getByLabel('凭证内容', { exact: true }).fill('discard-only-fixture');
    await page.getByRole('button', { name: '取消并清空', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '放弃凭证输入？', exact: true });
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByLabel('凭证内容', { exact: true })).toHaveValue('discard-only-fixture');
    await page.getByRole('button', { name: '取消并清空', exact: true }).click();
    await confirm.getByRole('button', { name: '清空并关闭', exact: true }).click();
    await expect(page.getByRole('button', { name: '新增凭证', exact: true })).toBeFocused();
  } finally {
    wait.release();
    refreshed.release();
  }
});

test('删除凭证只标记正在处理的行，失败后原行仍可重试', async ({ page }) => {
  const state = await fixture(page);
  const wait = deferred();
  state.beforeWrite = () => wait.promise;
  state.failWrite = true;
  try {
    await page.goto('/settings');
    const row = page.getByRole('row').filter({ hasText: 'SSH 连接样本' });
    const other = page.getByRole('row').filter({ hasText: '另一份凭证样本' });
    await row.getByRole('button', { name: '删除凭证 SSH 连接样本', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除凭证', exact: true }).click();
    await expect(row).toContainText('正在删除');
    await expect(row.locator('.animate-spin')).toHaveCount(1);
    await expect(other.locator('.animate-spin')).toHaveCount(0);
    await expect(other.getByRole('button')).toBeDisabled();
    await expect.poll(() => state.writes.length).toBe(1);
    wait.release();
    await expect(page.getByRole('alert')).toContainText('受控请求失败');
    await expect(row.getByRole('button')).toBeEnabled();
    expect(state.secrets).toHaveLength(2);
  } finally {
    wait.release();
  }
});

test('Builder 三项内容在取消类型切换时保留，确认后清空且不恢复可见原文', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/settings?new=builder');
  const labels = ['CA 证书', '客户端证书', '客户端私钥'];
  for (const [index, label] of labels.entries())
    await page.getByLabel(label, { exact: true }).fill(`fixture-certificate-${index}`);
  await page.getByRole('button', { name: '显示凭证内容', exact: true }).click();
  const kind = page.getByLabel('类型', { exact: true });
  await kind.selectOption('git');
  const confirmation = page.getByRole('dialog', { name: '切换凭证类型？', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  for (const [index, label] of labels.entries())
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(
      `fixture-certificate-${index}`,
    );
  await kind.selectOption('git');
  await confirmation.getByRole('button', { name: '清空并切换', exact: true }).click();
  await expect(page.getByLabel('Fine-grained PAT', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Fine-grained PAT', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await kind.selectOption('builder');
  for (const label of labels) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
    await expect(page.getByLabel(label, { exact: true })).toHaveClass(/masked-content/);
  }
  expect(state.writes).toHaveLength(0);
});

test('新集群内联登记取消确认保留输入，确认放弃后回到原登记入口', async ({ page }) => {
  const state = await fixture(page);
  state.cluster.identity = null;
  state.cluster.credentialRefId = null;
  state.cluster.connectionStatus = 'unverified';
  state.server.preflight = {
    observedAt: timestamp(),
    machineId: 'fixture-only-machine',
    hostname: 'fixture-server',
    os: 'ubuntu',
    osVersion: '24.04',
    architecture: 'arm64',
    kernel: 'fixture-kernel',
    init: 'systemd',
    cpuCount: 4,
    memoryBytes: 8_589_934_592,
    memoryAvailableBytes: 4_294_967_296,
    rootDiskBytes: 85_899_345_920,
    rootDiskAvailableBytes: 42_949_672_960,
    dataDiskBytes: 85_899_345_920,
    dataDiskAvailableBytes: 42_949_672_960,
    privileged: true,
    memoryCgroupAvailable: true,
    systemdAvailable: true,
    ports: [],
    firewall: 'inactive',
    k3s: {
      installed: false,
      version: null,
      installationId: null,
      installationPhase: null,
      secretsEncryption: 'unknown',
    },
    blockers: [],
    warnings: [],
  };
  await page.goto(`/servers/${serverId}`);
  const trigger = page.getByRole('button', { name: '先登记一个集群', exact: true });
  await trigger.click();
  const editor = page.locator('.inline-cluster-form');
  const name = editor.getByLabel('集群名称', { exact: true });
  await expect(name).toBeFocused();
  await name.fill('保留新集群名称');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '放弃新集群资料？', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(name).toHaveValue('保留新集群名称');
  await expect(editor.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.getByRole('button', { name: '清空并关闭', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.writes).toHaveLength(0);
});

for (const action of ['discover-host-key', 'preflight'] as const) {
  test(`${action === 'preflight' ? 'SSH 预检' : '主机指纹'}慢请求显示受理状态，失败重试保持原任务键`, async ({
    page,
  }) => {
    const state = await fixture(page);
    const wait = deferred();
    state.beforeWrite = () => wait.promise;
    state.failWrite = true;
    try {
      await page.goto(`/servers/${serverId}`);
      const trigger = page.getByRole('button', {
        name: action === 'preflight' ? '执行只读预检' : '重新读取指纹',
        exact: true,
      });
      await trigger.click();
      const pending = page.getByRole('button', {
        name: action === 'preflight' ? '正在受理预检…' : '正在受理指纹读取…',
        exact: true,
      });
      await expect(pending).toBeDisabled();
      await expect(pending.locator('.animate-spin')).toHaveCount(1);
      await pending.click({ force: true });
      await expect.poll(() => state.writes.length).toBe(1);
      wait.release();
      await expect(page.getByRole('alert')).toContainText('受控请求失败');
      state.beforeWrite = undefined;
      state.failWrite = false;
      await trigger.click();
      await expect(page.locator('[data-infrastructure-task]')).toContainText('等待执行器处理');
      expect(state.writes).toHaveLength(2);
      expect(state.writes[0]!.path).toBe(`/servers/${serverId}/${action}`);
      expect(state.writes[0]!.key).toBeTruthy();
      expect(state.writes[1]!.key).toBe(state.writes[0]!.key);
      expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
    } finally {
      wait.release();
    }
  });
}

test('保存可信主机指纹有等待反馈，失败仍保留核对来源与确认', async ({ page }) => {
  const state = await fixture(page);
  state.server.hostKey.trustedFingerprint = null;
  const wait = deferred();
  state.beforeWrite = () => wait.promise;
  state.failWrite = true;
  try {
    await page.goto(`/servers/${serverId}`);
    const source = page.getByLabel('独立核对来源', { exact: true });
    const confirmed = page.getByRole('checkbox', {
      name: '我已与上述可信来源逐字核对，确认主机指纹一致。',
      exact: true,
    });
    await source.fill('通过受控样本控制台独立核对');
    await confirmed.check();
    await page.getByRole('button', { name: '确认并保存可信指纹', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '正在保存可信指纹…', exact: true }),
    ).toBeDisabled();
    await expect(source).toBeDisabled();
    wait.release();
    await expect(page.getByRole('alert')).toContainText('受控请求失败');
    await expect(source).toHaveValue('通过受控样本控制台独立核对');
    await expect(confirmed).toBeChecked();
    expect(state.writes).toHaveLength(1);
  } finally {
    wait.release();
  }
});

test('集群同步慢请求明确受理等待，不重复提交或提前报告同步完成', async ({ page }) => {
  const state = await fixture(page);
  const wait = deferred();
  state.beforeWrite = () => wait.promise;
  try {
    await page.goto(`/clusters/${s5Ids.cluster}`);
    await page.getByRole('button', { name: '重新检查与同步', exact: true }).click();
    const pending = page.getByRole('button', { name: '正在受理同步…', exact: true });
    await expect(pending).toBeDisabled();
    await expect(pending.locator('.animate-spin')).toHaveCount(1);
    await pending.click({ force: true });
    await expect.poll(() => state.writes.length).toBe(1);
    wait.release();
    await expect(page.locator('[data-infrastructure-task]')).toContainText('等待执行器处理');
    expect(state.writes[0]!.path).toBe(`/clusters/${s5Ids.cluster}/sync`);
    expect([...state.operations.values()][0]!.status).toBe('queued');
  } finally {
    wait.release();
  }
});
