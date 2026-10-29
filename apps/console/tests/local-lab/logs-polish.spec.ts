import { expect, test, type Page } from '@playwright/test';
import type { Operation, OperationLog } from '../../src/lib/types';
import { makeBuildRun, s6Ids, s6Time } from '../fixtures/s6-data';
import {
  installGitWorkspaceFixture,
  installImageWorkspaceFixture,
} from './service-workspace-v3-fixture';

type FixtureState = {
  unexpected: string[];
  writes: unknown[];
  reads: { path: string; query: Record<string, string> }[];
};
const runs = new WeakMap<Page, { errors: string[]; state: FixtureState }>();
function track(page: Page, state: FixtureState) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  runs.set(page, { errors, state });
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
test.afterEach(async ({ page }) => {
  const run = runs.get(page);
  if (!run) return;
  expect(run.errors, '浏览器运行错误').toEqual([]);
  expect(run.state.unexpected, '未声明的 API 请求').toEqual([]);
  expect(run.state.writes, '日志验证不写入资源').toEqual([]);
});

type ClipboardFixture = {
  snapshots: string[];
  settle: (success: boolean) => void;
};
type StreamFixture = {
  requests: {
    query: Record<string, string>;
    opened: boolean;
    aborted: boolean;
    cancelled: boolean;
  }[];
  open: (index: number) => void;
  append: (index: number, text: string) => void;
  end: (index: number, reason?: string) => void;
  fail: (index: number) => void;
};
declare global {
  interface Window {
    __polishClipboard: ClipboardFixture;
    __polishLogStream: StreamFixture;
  }
}

async function clipboardFixture(page: Page, deferred = false) {
  await page.addInitScript(
    ({ deferred }) => {
      const pending: { resolve: () => void; reject: (reason: Error) => void }[] = [];
      const snapshots: string[] = [];
      window.__polishClipboard = {
        snapshots,
        settle(success) {
          const write = pending.shift();
          if (!write) throw new Error('No controlled clipboard write is pending.');
          if (success) write.resolve();
          else write.reject(new Error('Controlled clipboard rejection.'));
        },
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(snapshot: string) {
            snapshots.push(snapshot);
            return deferred
              ? new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
              : Promise.resolve();
          },
        },
      });
    },
    { deferred },
  );
}

/** Native Response/ReadableStream only for this declared log GET; all other API
 * requests still reach the catch-all S5 fixture and fail if undeclared. */
async function streamFixture(page: Page, serviceId: string) {
  await page.addInitScript(
    ({ path }) => {
      const originalFetch = window.fetch.bind(window);
      const encoder = new TextEncoder();
      const requests: StreamFixture['requests'] = [];
      const streams: {
        controller: ReadableStreamDefaultController<Uint8Array>;
        response: Response;
        resolve: (response: Response) => void;
        reject: (error: Error) => void;
      }[] = [];
      window.__polishLogStream = {
        requests,
        open(index) {
          requests[index]!.opened = true;
          streams[index]!.resolve(streams[index]!.response);
        },
        append(index, text) {
          streams[index]!.controller.enqueue(
            encoder.encode(`event: log\ndata: ${JSON.stringify({ text })}\n\n`),
          );
        },
        end(index, reason = 'eof') {
          streams[index]!.controller.enqueue(
            encoder.encode(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`),
          );
          streams[index]!.controller.close();
        },
        fail(index) {
          const failure = new Error('Controlled log connection failure.');
          if (requests[index]!.opened) streams[index]!.controller.error(failure);
          else streams[index]!.reject(failure);
        },
      };
      window.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (url.origin !== location.origin || url.pathname !== path || method !== 'GET')
          return originalFetch(input, init);
        const record = {
          query: Object.fromEntries(url.searchParams),
          opened: false,
          aborted: false,
          cancelled: false,
        };
        requests.push(record);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          cancel() {
            record.cancelled = true;
          },
        });
        const response = new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        return new Promise<Response>((resolve, reject) => {
          streams.push({ controller, response, resolve, reject });
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
          const abort = () => {
            record.aborted = true;
            const error = new DOMException('Controlled stream aborted.', 'AbortError');
            if (record.opened) {
              try {
                controller.error(error);
              } catch {
                /* Already closed. */
              }
            } else reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      };
    },
    { path: `/api/services/${serviceId}/logs` },
  );
}

async function openStream(page: Page, index: number, text = '') {
  await expect
    .poll(() => page.evaluate(() => window.__polishLogStream.requests.length))
    .toBe(index + 1);
  await page.evaluate(
    ({ index, text }) => {
      window.__polishLogStream.open(index);
      if (text) window.__polishLogStream.append(index, text);
    },
    { index, text },
  );
}
const logPhase = (page: Page) => page.locator('[data-service-logs] [data-log-phase]');

test('已结束构建自动追完现有页，保持大序号、缓冲上限、搜索与复制', async ({ page }) => {
  const state = await gitFixture(page);
  await clipboardFixture(page);
  await page.clock.install();
  const template = state.gitState.logPages[0]!;
  state.gitState.logPages = Array.from({ length: 6 }, (_, pageIndex) => ({
    ...template,
    items: Array.from({ length: 50 }, (_, index) => ({
      sequence: String(9007199254740992n + BigInt(pageIndex * 50 + index)),
      phase: 'building',
      timestamp: s6Time,
      content: `bounded-output-${pageIndex}-${index}:` + 'x'.repeat(1100) + '\n',
      truncated: false,
    })),
    pageInfo: {
      hasMore: pageIndex < 5,
      nextCursor: pageIndex < 5 ? `fixture:${pageIndex + 1}` : null,
    },
  }));
  await page.goto(`/deployments/${s6Ids.deployment}`);
  const logs = page.locator('[data-build-logs]');
  await expect(logs).toContainText('bounded-output-5-49:');
  await expect(logs).toContainText('较早输出已移出此窗口');
  const retained = await logs.locator('.build-chunk pre').allTextContents();
  expect(retained.length).toBeLessThanOrEqual(200);
  expect(retained.reduce((count, value) => count + value.length, 0)).toBeLessThanOrEqual(200_000);
  expect(retained.at(-1)).toBe(state.gitState.logPages[5]!.items[49]!.content);
  const reads = () => state.reads.filter((entry) => entry.path.endsWith('/build-logs'));
  expect(reads()).toHaveLength(6);
  await page.clock.fastForward(6500);
  expect(reads(), '终态追到尾部后不再轮询').toHaveLength(6);
  await logs.getByLabel('搜索构建日志', { exact: true }).fill('BOUNDED-OUTPUT-5-49:');
  await expect(logs.locator('.build-chunk')).toHaveCount(1);
  await logs.getByRole('button', { name: '复制匹配输出', exact: true }).click();
  expect(await page.evaluate(() => window.__polishClipboard.snapshots)).toEqual([retained.at(-1)]);
  state.gitState.deployments[0]!.build!.runs.push(
    makeBuildRun({ id: s6Ids.secondRun, runNumber: 2 }),
  );
  await page.getByRole('button', { name: '刷新部署状态', exact: true }).click();
  await logs.getByLabel('选择构建执行', { exact: true }).selectOption(s6Ids.secondRun);
  await expect(logs).toContainText('已超过保留期限');
  await expect(logs.locator('.build-chunk')).toHaveCount(0);
  await logs.getByLabel('选择构建执行', { exact: true }).selectOption(s6Ids.run);
  await expect(logs).toContainText('bounded-output-5-49:');
  await expect(logs.getByLabel('搜索构建日志', { exact: true })).toHaveValue('');
  expect(
    reads().filter(
      (entry) => entry.query.runId === s6Ids.run && entry.query.cursor === 'fixture:5',
    ),
  ).toHaveLength(2);
});

test('运行构建结束时补齐最后分页，暂停阅读保持且收尾后停止轮询', async ({ page }) => {
  const state = await gitFixture(page);
  await page.clock.install();
  const deployment = state.gitState.deployments[0]!;
  deployment.status = 'running';
  deployment.finishedAt = null;
  const initial = {
    ...state.gitState.logPages[0]!,
    pageInfo: { hasMore: false, nextCursor: null },
  };
  state.gitState.logPages = [initial];
  await page.goto(`/deployments/${s6Ids.deployment}`);
  const logs = page.locator('[data-build-logs]');
  await expect(logs.locator('.build-chunk')).toHaveCount(2);
  await logs.getByRole('button', { name: '暂停跟随', exact: true }).click();
  state.gitState.logPages = [
    { ...initial, pageInfo: { hasMore: true, nextCursor: 'fixture:1' } },
    {
      ...initial,
      items: [
        {
          sequence: '9007199254740994',
          phase: 'pushing',
          timestamp: s6Time,
          content: 'FINAL_PUSH_FAILURE\n',
          truncated: false,
        },
      ],
    },
  ];
  deployment.status = 'failed';
  deployment.finishedAt = new Date().toISOString();
  await page.getByRole('button', { name: '刷新部署状态', exact: true }).click();
  await expect(logs).toContainText('FINAL_PUSH_FAILURE');
  await expect(logs.getByRole('button', { name: /新增 1 段.*回到底部/ })).toBeVisible();
  await expect(logs.locator('.build-chunk pre')).toHaveText([
    'large-sequence-first',
    'large-sequence-second',
    'FINAL_PUSH_FAILURE\n',
  ]);
  const reads = () => state.reads.filter((entry) => entry.path.endsWith('/build-logs'));
  const completedReads = reads().length;
  await page.clock.fastForward(6500);
  expect(reads()).toHaveLength(completedReads);
  expect(reads().at(-1)?.query.cursor).toBe('fixture:1');
});

test('容器连接有真实等待态，同目标重连失败保留缓冲，换目标与关闭立即取消', async ({ page }) => {
  const state = await imageFixture(page);
  await streamFixture(page, state.service.id);
  await clipboardFixture(page);
  await page.goto(state.pathFor('logs'));
  const logs = page.locator('[data-service-logs]');
  const output = logs.locator('.runtime-log-output');
  const snapshot =
    Array.from({ length: 80 }, (_, index) => `previous-read-${index}`).join('\n') + '\n';
  await logs.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'connecting');
  await expect(logPhase(page)).not.toContainText('连接已建立');
  await expect(logs.getByRole('button', { name: '断开日志连接', exact: true })).toBeEnabled();
  await openStream(page, 0, snapshot);
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'streaming');
  await expect(output).toHaveAttribute('data-buffer-characters', String(snapshot.length));
  await page.evaluate(() => window.__polishLogStream.end(0));
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'ended');
  await output.press('Home');
  await expect(logs.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  // Chrome animates native Home scrolling even with scroll-behavior: auto.
  // Compare a settled reading position, not an intermediate animation frame.
  await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(0);
  const position = await output.evaluate((element) => element.scrollTop);
  await logs.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'connecting');
  await expect(output).toHaveAttribute('data-buffer-characters', String(snapshot.length));
  await expect(logs).toContainText('下方保留上次读取的日志');
  await expect.poll(() => page.evaluate(() => window.__polishLogStream.requests.length)).toBe(2);
  await page.evaluate(() => window.__polishLogStream.fail(1));
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'error');
  await expect(output).toHaveAttribute('data-buffer-characters', String(snapshot.length));
  expect(await output.evaluate((element) => element.scrollTop)).toBe(position);
  await logs.getByRole('button', { name: '复制缓冲日志', exact: true }).click();
  expect(await page.evaluate(() => window.__polishClipboard.snapshots)).toEqual([snapshot]);
  await logs.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__polishLogStream.requests.length)).toBe(3);
  await logs.getByLabel('容器', { exact: true }).selectOption('sidecar');
  await expect
    .poll(() => page.evaluate(() => window.__polishLogStream.requests[2]?.aborted))
    .toBe(true);
  await expect(output).toHaveAttribute('data-buffer-characters', '0');
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'idle');
  await expect(logs.getByRole('button', { name: '复制缓冲日志', exact: true })).toBeDisabled();
  await logs.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__polishLogStream.requests.length)).toBe(4);
  await page.getByRole('dialog').getByRole('button', { name: '返回服务', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__polishLogStream.requests[3]?.aborted))
    .toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('持续追加时复制等待真实 Promise，筛选保留原行标识且虚拟缓冲有界', async ({ page }) => {
  const state = await imageFixture(page);
  await streamFixture(page, state.service.id);
  await clipboardFixture(page, true);
  await page.goto(state.pathFor('logs'));
  const logs = page.locator('[data-service-logs]');
  const output = logs.locator('.runtime-log-output');
  const initial =
    Array.from({ length: 2000 }, (_, index) =>
      index === 7 ? 'needle first' : index === 1998 ? 'needle second' : `buffered-line-${index}`,
    ).join('\n') + '\n';
  await logs.getByRole('checkbox', { name: '持续跟随输出', exact: true }).check();
  await logs.getByRole('button', { name: '开始跟随日志', exact: true }).click();
  await openStream(page, 0, initial);
  await expect(output).toHaveAttribute('data-buffer-characters', String(initial.length));
  await logs.getByLabel('搜索容器日志', { exact: true }).fill('NEEDLE');
  await expect(output).toHaveAttribute('data-matching-lines', '2');
  await expect(output.locator('.virtual-log-line')).toHaveCount(2);
  expect(
    await output
      .locator('.virtual-log-line')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-line-key'))),
  ).toEqual(['7', '1998']);
  await logs.getByRole('button', { name: '复制匹配日志', exact: true }).click();
  await expect(logs.getByRole('button', { name: '正在复制', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__polishLogStream.append(0, 'needle appended\n'));
  await expect(output).toHaveAttribute('data-matching-lines', '3');
  await expect(logs.getByRole('button', { name: '正在复制', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__polishClipboard.snapshots)).toEqual([
    'needle first\nneedle second\n',
  ]);
  await page.evaluate(() => window.__polishClipboard.settle(true));
  await expect(logs.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await page.evaluate(() => window.__polishLogStream.append(0, 'needle after-copy\n'));
  await expect(output).toHaveAttribute('data-matching-lines', '4');
  await expect(logs.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await logs.getByLabel('搜索容器日志', { exact: true }).fill('appended');
  await logs.getByRole('button', { name: '复制匹配日志', exact: true }).click();
  await page.evaluate(() => window.__polishClipboard.settle(false));
  await expect(logs.getByText('复制失败，请选中文本后复制。', { exact: true })).toBeVisible();
  await logs.getByLabel('搜索容器日志', { exact: true }).fill('');
  const large =
    Array.from({ length: 12000 }, (_, index) => `bounded-live-${index}:` + 'x'.repeat(24)).join(
      '\n',
    ) + '\n';
  await page.evaluate((text) => window.__polishLogStream.append(0, text), large);
  await expect(logs).toContainText('视图已裁剪较早输出');
  await expect(output).toContainText('bounded-live-11999:');
  expect(Number(await output.getAttribute('data-buffer-characters'))).toBeLessThanOrEqual(200_000);
  expect(Number(await output.getAttribute('data-buffer-lines'))).toBeLessThanOrEqual(10_000);
  expect(await output.locator('.virtual-log-line').count()).toBeLessThan(120);
  await page.evaluate(() => window.__polishLogStream.end(0));
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'ended');
});

test('暂停后分段追加同一行只计一次，历史位置不被拉走，空快照明确替换旧输出', async ({ page }) => {
  const state = await imageFixture(page);
  await streamFixture(page, state.service.id);
  await page.goto(state.pathFor('logs'));
  const logs = page.locator('[data-service-logs]');
  const output = logs.locator('.runtime-log-output');
  const initial =
    Array.from({ length: 1200 }, (_, index) => `history-line-${index}`).join('\n') + '\n';
  await logs.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await openStream(page, 0, initial);
  await expect(output).toContainText('history-line-1199');
  await output.press('Home');
  await expect(logs.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(0);
  const position = await output.evaluate((element) => element.scrollTop);
  await page.evaluate(() => window.__polishLogStream.append(0, 'partial-first'));
  await expect(
    logs.getByRole('button', { name: '回到最新 · 1 条新输出', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__polishLogStream.append(0, '-second'));
  await expect(output).toHaveAttribute(
    'data-buffer-characters',
    String(initial.length + 'partial-first-second'.length),
  );
  await expect(
    logs.getByRole('button', { name: '回到最新 · 1 条新输出', exact: true }),
  ).toBeVisible();
  expect(await output.evaluate((element) => element.scrollTop)).toBe(position);
  await page.evaluate(() => window.__polishLogStream.append(0, '\nnext-complete-line\n'));
  await expect(
    logs.getByRole('button', { name: '回到最新 · 2 条新输出', exact: true }),
  ).toBeVisible();
  expect(await output.evaluate((element) => element.scrollTop)).toBe(position);
  await logs.getByRole('button', { name: '回到最新 · 2 条新输出', exact: true }).click();
  await expect(output).toContainText('partial-first-second');
  await expect(output).toContainText('next-complete-line');
  await expect
    .poll(() =>
      output.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThan(3);
  await page.evaluate(() => window.__polishLogStream.fail(0));
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'error');
  await expect(output).toContainText('next-complete-line');
  await logs.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await openStream(page, 1);
  await expect(output).toContainText('next-complete-line');
  await page.evaluate(() => window.__polishLogStream.end(1));
  await expect(logPhase(page)).toHaveAttribute('data-log-phase', 'ended');
  await expect(output).toHaveAttribute('data-buffer-characters', '0');
  await expect(output).toContainText('本次读取没有日志输出');
});

test('无实例文案区分期望停止、缺少观察和已观察到停止', async ({ page }) => {
  const state = await imageFixture(page);
  state.service.desiredState = 'stopped';
  state.service.runtimeState = 'stopped';
  state.service.observation!.pods = [];
  state.service.observationStale = true;
  state.service.lastObservedAt = new Date(Date.now() - 600_000).toISOString();
  await page.goto(state.pathFor('usage'));
  await expect(page.locator('[data-service-runtime]')).toContainText(
    '尚无最新观察确认实际是否已停止',
  );
  await page.getByRole('link', { name: '运行日志', exact: true }).click();
  await expect(page.locator('[data-service-logs]')).toContainText('尚无最新观察确认实际是否已停止');
  state.service.observationStale = false;
  state.service.lastObservedAt = new Date().toISOString();
  await page.reload();
  await expect(page.locator('[data-service-logs]')).toContainText('服务已停止，没有当前实例可读取');
  await page.getByRole('dialog').getByRole('button', { name: '返回服务', exact: true }).click();
  await expect(page.locator('[data-service-runtime]')).toContainText(
    '服务已停止，没有当前实例可连接',
  );
  state.service.observation = null;
  state.service.lastObservedAt = null;
  await page.reload();
  await expect(page.locator('[data-service-runtime]')).toContainText(
    '尚无最新观察确认实际是否已停止',
  );
});

test('部署状态筛选在后退和刷新后保留，并与另一个服务隔离', async ({ page }) => {
  const state = await imageFixture(page);
  state.imageState.deployments[0]!.status = 'failed';
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/deployments' || route.request().method() !== 'GET')
      return route.fallback();
    state.reads.push({ path: '/deployments', query: Object.fromEntries(url.searchParams) });
    const data = state.imageState.deployments.filter(
      (deployment) =>
        (!url.searchParams.get('serviceId') ||
          deployment.serviceId === url.searchParams.get('serviceId')) &&
        (!url.searchParams.get('status') || deployment.status === url.searchParams.get('status')),
    );
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, nextCursor: null } }),
    });
  });
  await page.goto(state.pathFor('deployments'));
  await page.getByLabel('筛选部署状态', { exact: true }).selectOption('failed');
  await expect.poll(() => new URL(page.url()).searchParams.get('deploymentStatus')).toBe('failed');
  const filteredUrl = page.url();
  await page.locator('.deployment-row').first().click();
  await expect(page).toHaveURL(/\/deployments\//);
  await page.goBack();
  await expect(page.getByLabel('筛选部署状态', { exact: true })).toHaveValue('failed');
  await page.reload();
  await expect(page.getByLabel('筛选部署状态', { exact: true })).toHaveValue('failed');
  const other = new URL(filteredUrl);
  other.pathname = other.pathname.replace(state.service.id, state.databaseServiceId);
  await page.goto(other.href);
  await expect(page.getByLabel('筛选部署状态', { exact: true })).toHaveValue('');
  await expect
    .poll(
      () => state.reads.filter((entry) => entry.path === '/deployments').at(-1)?.query.serviceId,
    )
    .toBe(state.databaseServiceId);
  expect(
    state.reads.filter((entry) => entry.path === '/deployments').at(-1)?.query.status,
  ).toBeUndefined();
  await page.goto(filteredUrl);
  await expect(page.getByLabel('筛选部署状态', { exact: true })).toHaveValue('failed');
  await page.getByLabel('筛选部署状态', { exact: true }).selectOption('');
  await expect.poll(() => new URL(page.url()).searchParams.has('deploymentStatus')).toBe(false);
  expect(new URL(page.url()).searchParams.get('environment')).toBe('staging');
});

for (const kind of ['deployment', 'operation'] as const) {
  test(`${kind === 'deployment' ? '部署' : '任务'}平台日志在刷新时保留历史阅读、支持搜索复制与恢复跟随`, async ({
    page,
  }) => {
    const state = await imageFixture(page);
    await clipboardFixture(page);
    const operation: Operation = {
      id: '73000000-0000-4000-8000-000000000001',
      kind: 'diagnostic',
      scope: 'control_plane',
      serverId: null,
      clusterId: null,
      serviceId: null,
      status: 'succeeded',
      input: { durationMs: 250 },
      result: null,
      createdAt: s6Time,
      updatedAt: s6Time,
      startedAt: s6Time,
      finishedAt: s6Time,
      attempts: 1,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      retryOfId: null,
      cancelRequestedAt: null,
      pollUrl: '/api/operations/73000000-0000-4000-8000-000000000001',
    };
    state.imageState.operations.push(operation);
    const id = kind === 'deployment' ? state.imageState.deployments[0]!.id : operation.id;
    const path = `/${kind === 'deployment' ? 'deployments' : 'operations'}/${id}`;
    const rows: OperationLog[] = Array.from({ length: 40 }, (_, index) => ({
      sequence: index + 1,
      timestamp: s6Time,
      level: 'info',
      message: `platform-history-${index}`,
      attempt: 1,
      ...(index === 10 ? { code: 'CONTROLLED_MATCH' } : {}),
    }));
    let delay: Promise<void> | undefined;
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== `/api${path}/logs` || route.request().method() !== 'GET')
        return route.fallback();
      state.reads.push({ path: `${path}/logs`, query: Object.fromEntries(url.searchParams) });
      await delay;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: rows,
          source: kind,
          available: true,
          unavailableReason: null,
          truncated: false,
          page: { hasMore: false, nextCursor: null },
        }),
      });
    });
    await page.goto(path);
    const logs = page.locator(`[data-${kind}-logs]`);
    const output = logs.locator(kind === 'deployment' ? '.deployment-log' : '.operation-log');
    await expect(output.locator('.log-line')).toHaveCount(40);
    const search = logs.getByLabel(kind === 'deployment' ? '搜索部署日志' : '搜索任务日志', {
      exact: true,
    });
    await search.fill('controlled_match');
    await expect(output.locator('.log-line')).toHaveCount(1);
    await logs.getByRole('button', { name: '复制匹配日志', exact: true }).click();
    expect(await page.evaluate(() => window.__polishClipboard.snapshots)).toEqual([
      `${s6Time} info platform-history-10 [CONTROLLED_MATCH]`,
    ]);
    await search.fill('');
    await output.press('Home');
    await expect(logs.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(0);
    const copy = logs.getByRole('button', {
      name: kind === 'deployment' ? '复制部署日志' : '复制任务日志',
      exact: true,
    });
    await expect(copy).toBeEnabled();
    await copy.click();
    const pausedSnapshot = await page.evaluate(() => window.__polishClipboard.snapshots.at(-1));
    expect(pausedSnapshot).toContain('platform-history-0');
    expect(pausedSnapshot).toContain('platform-history-39');
    const position = await output.evaluate((element) => element.scrollTop);
    let release!: () => void;
    delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    await logs
      .getByRole('button', {
        name: kind === 'deployment' ? '刷新部署日志' : '刷新任务日志',
        exact: true,
      })
      .click();
    await expect(logs.getByText('正在更新，保留当前内容', { exact: true })).toBeVisible();
    await expect(output.locator('.log-line')).toHaveCount(40);
    rows.push({
      sequence: 41,
      timestamp: s6Time,
      level: 'info',
      message: 'platform-final-output',
      attempt: 1,
    });
    delay = undefined;
    release();
    await expect(output.locator('.log-line')).toHaveCount(41);
    await expect(
      logs.getByRole('button', { name: '回到最新 · 1 条新输出', exact: true }),
    ).toBeVisible();
    expect(await output.evaluate((element) => element.scrollTop)).toBe(position);
    await logs.getByRole('button', { name: '回到最新 · 1 条新输出', exact: true }).click();
    await expect
      .poll(() =>
        output.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(3);
    await search.fill('no retained line matches this');
    await expect(output).toContainText('没有匹配内容');
    await expect(logs.getByRole('button', { name: '复制匹配日志', exact: true })).toBeDisabled();
  });
}
