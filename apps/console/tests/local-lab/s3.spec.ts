import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { components } from '@ozz/api-client';
import { api, login, suffix } from '../e2e/helpers';

type Service = components['schemas']['ServiceResponseDto'];
type Deployment = components['schemas']['DeploymentDetailDto'];
type Operation = components['schemas']['OperationDto'];
const lab = fileURLToPath(new URL('../../../../.local/local-lab/', import.meta.url));
const serviceState = JSON.parse(readFileSync(`${lab}service-product-state.json`, 'utf8')) as {
  services: { a: string; b: string };
};
const productState = JSON.parse(readFileSync(`${lab}product-state.json`, 'utf8')) as {
  projects: { a: string; b: string };
  clusters: { a: string; b: string };
};
const serviceIds = serviceState.services;
type LogLifetime = { id: string; url: string; phase: 'opened' | 'aborted' };
type LogProbeWindow = Window & { __s3LogLifetime?: (event: LogLifetime) => Promise<void> };
const lifetimes = new WeakMap<Page, Map<string, { url: string; aborted: boolean }>>();

async function observeLogLifetime(page: Page) {
  const records = new Map<string, { url: string; aborted: boolean }>();
  lifetimes.set(page, records);
  await page.exposeBinding('__s3LogLifetime', (_source, event: LogLifetime) => {
    records.set(event.id, { url: event.url, aborted: event.phase === 'aborted' });
  });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/\/services\/[^/]+\/logs\?/.test(url) && init?.signal) {
        const id = crypto.randomUUID();
        void (window as LogProbeWindow).__s3LogLifetime?.({ id, url, phase: 'opened' });
        init.signal.addEventListener(
          'abort',
          () => {
            void (window as LogProbeWindow)
              .__s3LogLifetime?.({ id, url, phase: 'aborted' })
              .catch(() => undefined);
          },
          { once: true },
        );
      }
      // Observe the actual request signal; preserve native fetch and its body.
      return nativeFetch(input, init);
    };
  });
}

test.beforeAll(() => {
  if (!serviceIds.a || !serviceIds.b || serviceIds.a === serviceIds.b)
    throw new Error('S3 requires the two distinct, preserved local lab services.');
});

function pathFor(service: Service, tab?: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    environment: service.environment.slug,
    ...(tab ? { tab } : {}),
    ...extra,
  });
  return `/projects/${service.projectId}/services/${service.id}?${query}`;
}
async function getService(page: Page, id: string): Promise<Service> {
  return api(page.request, `/services/${id}`);
}
function preserved(service: Service) {
  return {
    id: service.id,
    revision: service.revision,
    configRevision: service.configRevision,
    desiredState: service.desiredState,
    published: service.published?.deploymentId,
    hasUnpublishedChanges: service.hasUnpublishedChanges,
  };
}
async function evidence(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}
async function settle(page: Page) {
  await page.locator('.skeleton').first().waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
async function noPageOverflow(page: Page) {
  await settle(page);
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width + 1);
  expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width + 1);
  return overflow;
}
async function theme(page: Page, value: 'light' | 'dark') {
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page
    .getByRole('menuitemradio', { name: value === 'dark' ? '深色' : '浅色', exact: true })
    .click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', value);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}
function logResponse(page: Page, id: string, follow: boolean) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/services/${id}/logs` &&
      url.searchParams.get('follow') === String(follow)
    );
  });
}
async function finiteLogs(page: Page, id: string) {
  const responseReady = logResponse(page, id, false);
  await page.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  const response = await responseReady;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/event-stream');
  // Chrome does not retain a fetch-SSE response body after the reader closes it.
  // Assert the actual parsed end reason and visible output from that same request.
  await expect(page.locator('[data-log-end-reason="eof"]')).toBeVisible();
  await expect(page.locator('.runtime-log-output pre')).not.toHaveText('');
  const output = await page.locator('.runtime-log-output pre').innerText();
  await expect(page.getByRole('button', { name: '读取日志尾部', exact: true })).toBeEnabled();
  return {
    status: response.status(),
    renderedBytes: Buffer.byteLength(output),
    endReason: 'eof',
    follow: new URL(response.url()).searchParams.get('follow'),
  };
}
async function beginFollow(page: Page, id: string) {
  await page.getByRole('checkbox', { name: '持续跟随输出', exact: true }).check();
  const ready = logResponse(page, id, true);
  await page.getByRole('button', { name: '开始跟随日志', exact: true }).click();
  const response = await ready;
  expect(response.status()).toBe(200);
  const records = lifetimes.get(page)!;
  const requestPath = new URL(response.url()).pathname + new URL(response.url()).search;
  const recordId = [...records].reverse().find(([, record]) => record.url === requestPath)?.[0];
  expect(recordId, '真实 fetch 的日志信号应可观察').toBeTruthy();
  await expect(page.getByRole('button', { name: '断开日志连接', exact: true })).toBeVisible();
  return { isClosed: () => records.get(recordId!)!.aborted };
}
async function expectClosed(connection: Awaited<ReturnType<typeof beginFollow>>) {
  await expect
    .poll(connection.isClosed, {
      timeout: 10_000,
      message: '切换日志目标后真实 fetch 信号应立即中止',
    })
    .toBe(true);
}

test('保留的 A/B 服务展示真实草稿、发布、运行和持久部署记录', async ({ page }, info) => {
  await login(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const results = [];
  for (const key of ['a', 'b'] as const) {
    const service = await getService(page, serviceIds[key]);
    const before = preserved(service);
    expect(service.projectId).toBe(productState.projects[key]);
    expect(service.clusterId).toBe(productState.clusters[key]);
    expect(service.runtimeState).toBe('running');
    expect(service.published).not.toBeNull();
    if (key === 'a') {
      expect(service.hasUnpublishedChanges).toBe(true);
      expect(service.configRevision).toBeGreaterThan(service.published!.configRevision);
    }
    await page.goto(pathFor(service));
    await expect(
      page.getByRole('heading', { name: service.name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.locator('.page-head .badge')).toHaveText('运行中');
    const summary = page.locator('.configuration-summary');
    await expect(summary.locator(':scope > div').nth(0)).toContainText(
      `r${service.configRevision}`,
    );
    await expect(summary.locator(':scope > div').nth(1)).toContainText(
      `r${service.published!.configRevision}`,
    );
    await expect(page.locator('[data-service-runtime]')).toContainText(
      service.observation!.pods[0]!.name,
    );
    await page
      .locator('.breadcrumbs')
      .getByRole('link', { name: service.project.name, exact: true })
      .click();
    await expect(page.locator(`[data-service-id="${service.id}"]`)).toContainText(service.name);
    await page
      .locator(`[data-service-id="${service.id}"]`)
      .getByRole('link', { name: service.name, exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/services/${service.id}\\?environment=${service.environment.slug}$`),
    );
    await page.getByRole('link', { name: '查看这次部署', exact: true }).click();
    const deployment: Deployment = await api(
      page.request,
      `/deployments/${service.published!.deploymentId}`,
    );
    expect(deployment.status).toBe('succeeded');
    expect(deployment.target.serviceId).toBe(service.id);
    expect(deployment.stages.map((stage) => stage.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    await expect(page.locator('.page-head .badge')).toHaveText('已完成');
    const stages = page.locator('[data-deployment-stages]');
    for (const name of ['解析镜像', '应用配置', '等待健康检查'])
      await expect(
        stages.locator('.deployment-stages').getByText(name, { exact: true }),
      ).toBeVisible();
    await expect(stages.getByText('已完成', { exact: true })).toHaveCount(3);
    const records = (await api(page.request, `/deployments/${deployment.id}/logs?limit=100`)) as {
      sequence: number;
      message: string;
    }[];
    expect(records.length).toBeGreaterThan(0);
    await expect(page.locator('[data-deployment-logs]')).toContainText(records[0]!.message);
    await page.reload();
    await expect(page.locator('[data-deployment-logs]')).toContainText(records[0]!.message);
    await page.getByRole('link', { name: '返回服务', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: service.name, exact: true, level: 1 }),
    ).toBeVisible();
    expect(preserved(await getService(page, service.id))).toEqual(before);
    results.push({
      service: before,
      target: {
        projectId: service.projectId,
        environmentId: service.environmentId,
        clusterId: service.clusterId,
      },
      deploymentId: deployment.id,
      stages: deployment.stages.map((stage) => ({ name: stage.name, status: stage.status })),
      persistentLogRows: records.length,
    });
  }
  expect(errors).toEqual([]);
  await evidence(info, 'preserved-services', { passed: true, results, browserErrors: errors });
});

test('真实 Pod 日志有限读取，暂停只影响滚动且切换目标清理旧输出', async ({ page }, info) => {
  await observeLogLifetime(page);
  await login(page);
  const a = await getService(page, serviceIds.a);
  const b = await getService(page, serviceIds.b);
  const before = [preserved(a), preserved(b)];
  await page.goto(pathFor(a, 'logs'));
  await expect(page.getByRole('heading', { name: '容器日志', exact: true })).toBeVisible();
  const finite = await finiteLogs(page, a.id);
  await page.setViewportSize({ width: 390, height: 1000 });
  const first = await beginFollow(page, a.id);
  await expect(page.locator('.runtime-log-output pre')).not.toHaveText('');
  await page.getByRole('button', { name: '暂停滚动', exact: true }).click();
  await expect(page.getByRole('button', { name: /回到最新/ })).toBeVisible();
  await page.locator('.runtime-log-output').evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(page.locator('.log-toolbar')).toContainText('自动滚动已暂停');
  await page.waitForTimeout(500); // Observe that pause keeps the real open SSE connection alive.
  expect(first.isClosed()).toBe(false);
  await noPageOverflow(page);
  await screenshot(page, info, 'runtime-log-paused-390-light');
  await page.getByRole('checkbox', { name: '上次退出的容器', exact: true }).check();
  await expectClosed(first);
  await expect(page.locator('.runtime-log-output pre')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '上次退出的容器', exact: true }).uncheck();
  const second = await beginFollow(page, a.id);
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '服务', exact: true })
    .click();
  await expectClosed(second);
  await page
    .locator(`[data-service-id="${b.id}"]`)
    .getByRole('link', { name: b.name, exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '服务页面' })
    .getByRole('link', { name: '容器日志', exact: true })
    .click();
  await expect(page.locator('[data-service-logs]')).toContainText(b.name);
  await expect(page.locator('.runtime-log-output pre')).toHaveCount(0);
  const pod = b.observation!.pods[0]!;
  await page.goto(pathFor(b, 'logs', { podUid: pod.uid, container: 'removed-container' }));
  await expect(page.getByRole('button', { name: '读取日志尾部', exact: true })).toBeDisabled();
  await expect(
    page.getByText('原容器已不可用，请选择当前实例中的容器后读取。', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('容器', { exact: true }).selectOption(pod.containers[0]!.name);
  await finiteLogs(page, b.id);
  expect([
    preserved(await getService(page, a.id)),
    preserved(await getService(page, b.id)),
  ]).toEqual(before);
  await evidence(info, 'runtime-log-lifecycle', {
    passed: true,
    finite,
    pausePreservedConnection: true,
    previousSelectionClosedConnection: true,
    serviceChangeClosedConnection: true,
    staleContainerBlocked: true,
    preserved: before,
  });
});

test('1440、1024、390 的明暗主题覆盖真实服务配置、部署、日志和操作页', async ({ page }, info) => {
  test.setTimeout(600_000);
  await login(page);
  const a = await getService(page, serviceIds.a);
  const before = preserved(a);
  const operations: Operation[] = await api(page.request, `/operations?serviceId=${a.id}&limit=50`);
  const operation = operations.find(
    (value) => value.kind === 'service_resume' && value.status === 'succeeded',
  );
  expect(operation).toBeTruthy();
  const surfaces: { name: string; path: string; group?: string; logs?: boolean }[] = [
    { name: 'project', path: `/projects/${a.projectId}?environment=${a.environment.slug}` },
    { name: 'service-list', path: '/services' },
    { name: 'service-overview', path: pathFor(a) },
    { name: 'configuration-image', path: pathFor(a, 'configuration') },
    { name: 'configuration-ports', path: pathFor(a, 'configuration'), group: '端口与探针' },
    { name: 'configuration-variables', path: pathFor(a, 'configuration'), group: '环境变量' },
    { name: 'deployment-review', path: pathFor(a, 'review') },
    { name: 'deployment', path: `/deployments/${a.published!.deploymentId}` },
    { name: 'runtime-logs', path: pathFor(a, 'logs'), logs: true },
    { name: 'service-operations', path: `/operations?serviceId=${a.id}` },
    { name: 'service-operation-result', path: `/operations/${operation!.id}` },
  ];
  const reports = [];
  for (const mode of ['light', 'dark'] as const) {
    await theme(page, mode);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const surface of surfaces) {
        await page.goto(surface.path);
        await expect(page.locator('h1')).toBeVisible();
        await settle(page);
        if (surface.group)
          await page
            .getByRole('navigation', { name: '配置分组' })
            .getByRole('button', { name: surface.group, exact: true })
            .click();
        if (surface.logs) await finiteLogs(page, a.id);
        const overflow = await page.evaluate(() => ({
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        expect
          .soft(overflow.document, `${surface.name} ${mode} ${width}: document width`)
          .toBeLessThanOrEqual(width + 1);
        expect
          .soft(overflow.body, `${surface.name} ${mode} ${width}: body width`)
          .toBeLessThanOrEqual(width + 1);
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const violations = axe.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
        }));
        reports.push({ surface: surface.name, mode, width, overflow, violations });
        expect.soft(violations, `${surface.name} ${mode} ${width}`).toEqual([]);
        if ((mode === 'light' && width === 1440) || (mode === 'dark' && width === 390))
          await screenshot(page, info, `${surface.name}-${mode}-${width}`);
      }
    }
  }
  expect(preserved(await getService(page, a.id))).toEqual(before);
  await evidence(info, 'viewport-accessibility-matrix', {
    samples: reports.length,
    reports,
    longDurationPerformance: 'not_run',
  });
});

test('独立测试服务通过 UI 保存、发布健康、停止、恢复和删除', async ({ page }, info) => {
  await observeLogLifetime(page);
  await login(page);
  const a = await getService(page, serviceIds.a);
  const b = await getService(page, serviceIds.b);
  const before = [preserved(a), preserved(b)];
  const slug = `s3-browser-${suffix()}`;
  const name = `S3浏览器验收-${slug}-${'longname'.repeat(5)}`;
  const events: { action: string; id: string; status: string }[] = [];
  let owned: Service | undefined;
  let deleted = false;
  try {
    await page.goto(`/projects/${a.projectId}?environment=${a.environment.slug}`);
    await page.getByRole('link', { name: '添加服务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '从镜像添加服务', exact: true })).toBeVisible();
    await page.getByLabel('服务名称', { exact: true }).fill(name);
    await page.getByLabel('服务标识', { exact: true }).fill(slug);
    await page.getByLabel('镜像地址', { exact: true }).fill(a.published!.image!.deployReference);
    await page
      .getByRole('navigation', { name: '配置分组' })
      .getByRole('button', { name: '启动与资源', exact: true })
      .click();
    await page.getByLabel('副本数', { exact: true }).fill('2');
    await page
      .getByRole('navigation', { name: '配置分组' })
      .getByRole('button', { name: '端口与探针', exact: true })
      .click();
    await page.getByLabel('容器端口', { exact: true }).fill('9898');
    const readiness = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '就绪探针', exact: true }) });
    await readiness.getByLabel('检查方式', { exact: true }).selectOption('http');
    await readiness.getByLabel('HTTP 路径', { exact: true }).fill('/readyz');
    await page.getByLabel('发布健康等待上限（秒）', { exact: true }).fill('180');
    await page
      .getByRole('navigation', { name: '配置分组' })
      .getByRole('button', { name: '环境变量', exact: true })
      .click();
    await page.getByRole('button', { name: '导入 .env', exact: true }).click();
    await page.getByLabel('.env 文件内容', { exact: true }).fill(`PODINFO_UI_MESSAGE=${slug}`);
    await page.getByRole('checkbox', { name: '将导入的值全部作为秘密保存', exact: true }).uncheck();
    await page.getByRole('button', { name: '解析并检查', exact: true }).click();
    await expect(page.getByRole('button', { name: '加入当前草稿', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '加入当前草稿', exact: true }).click();
    await expect(page.getByLabel('变量名', { exact: true })).toHaveValue('PODINFO_UI_MESSAGE');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/services',
    );
    await page.getByRole('button', { name: '保存并预览发布', exact: true }).click();
    const savedResponse = await saved;
    expect(savedResponse.status()).toBe(201);
    owned = (await savedResponse.json()).data as Service;
    expect([a.id, b.id]).not.toContain(owned.id);
    expect(owned.slug).toBe(slug);
    expect(owned.configuration.replicas).toBe(2);
    expect(owned.published).toBeNull();
    expect(owned.runtimeState).toBe('unpublished');
    expect(owned.configuration.environment).toContainEqual(
      expect.objectContaining({
        name: 'PODINFO_UI_MESSAGE',
        value: slug,
        secret: false,
      }),
    );
    await expect(page.locator('[data-deployment-review]')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1000 });
    await noPageOverflow(page);
    await screenshot(page, info, 'new-service-review-390-light');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/services/${owned!.id}/deployments`,
    );
    await page.getByRole('button', { name: '确认发布', exact: true }).click();
    const accepted = await submitted;
    expect(accepted.status()).toBe(202);
    const deployment = (await accepted.json()).data as Deployment;
    expect(deployment.target.serviceId).toBe(owned.id);
    expect(deployment.target.projectId).toBe(a.projectId);
    await expect(page).toHaveURL(new RegExp(`/deployments/${deployment.id}$`));
    await expect(page.locator('.page-head .badge')).toHaveText('已完成', { timeout: 210_000 });
    const finished: Deployment = await api(page.request, `/deployments/${deployment.id}`);
    expect(finished.status).toBe('succeeded');
    expect(finished.stages.every((stage) => stage.status === 'succeeded')).toBe(true);
    await expect(page.locator('[data-deployment-logs] .log-line').first()).toBeVisible();
    events.push({ action: 'deploy', id: finished.id, status: finished.status });
    await screenshot(page, info, 'new-service-deployment-healthy-1440-light');
    await page.getByRole('link', { name: '返回服务', exact: true }).click();
    await expect(page.locator('.page-head .badge')).toHaveText('运行中');
    owned = await getService(page, owned.id);
    expect(owned.observation!.deployment!.readyReplicas).toBe(2);
    expect(owned.published!.deploymentId).toBe(deployment.id);
    expect(owned.observation!.pods.filter((pod) => !pod.deletionTimestamp)).toHaveLength(2);
    await page
      .getByRole('navigation', { name: '服务页面' })
      .getByRole('link', { name: '容器日志', exact: true })
      .click();
    const stream = await beginFollow(page, owned.id);
    const originalPod = await page.getByLabel('实例', { exact: true }).inputValue();
    const nextPod = owned.observation!.pods.find(
      (pod) => pod.uid !== originalPod && !pod.deletionTimestamp,
    )!;
    await page.getByLabel('实例', { exact: true }).selectOption(nextPod.uid);
    await expectClosed(stream);
    await expect(page.locator('.runtime-log-output pre')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`podUid=${nextPod.uid}`));
    await page
      .getByRole('navigation', { name: '服务页面' })
      .getByRole('link', { name: '概览', exact: true })
      .click();
    for (const action of ['stop', 'resume'] as const) {
      await page.setViewportSize({ width: action === 'stop' ? 390 : 1440, height: 1000 });
      const trigger = action === 'stop' ? '停止' : '恢复运行';
      const confirm = action === 'stop' ? '停止服务' : '恢复运行';
      await page.locator('.page-head').getByRole('button', { name: trigger, exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText(name);
      expect((await getService(page, owned.id)).desiredState).toBe(
        action === 'stop' ? 'running' : 'stopped',
      );
      await noPageOverflow(page);
      const dialog = page.getByRole('dialog');
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      const responseReady = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/services/${owned!.id}/${action}`,
      );
      await page.getByRole('dialog').getByRole('button', { name: confirm, exact: true }).click();
      const response = await responseReady;
      expect(response.status()).toBe(202);
      const operation = (await response.json()).data as Operation;
      expect(operation.serviceId).toBe(owned.id);
      await expect(page).toHaveURL(new RegExp(`/operations/${operation.id}$`));
      await expect(page.locator('.page-head .badge')).toHaveText('已完成', { timeout: 120_000 });
      expect((await api(page.request, `/operations/${operation.id}`)).status).toBe('succeeded');
      const updated = await getService(page, owned.id);
      expect(updated.configuration.replicas).toBe(2);
      expect(updated.published!.deploymentId).toBe(deployment.id);
      expect(updated.published!.configuration.replicas).toBe(2);
      expect(updated.desiredState).toBe(action === 'stop' ? 'stopped' : 'running');
      expect(updated.observation!.deployment!.replicas).toBe(action === 'stop' ? 0 : 2);
      events.push({ action, id: operation.id, status: 'succeeded' });
      await page.getByRole('link', { name: '查看服务当前运行状态', exact: true }).click();
      await expect(page.locator('.page-head .badge')).toHaveText(
        action === 'stop' ? '已停止' : '运行中',
      );
      if (action === 'stop')
        await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
    }
    await page
      .getByRole('navigation', { name: '服务页面' })
      .getByRole('link', { name: '配置草稿', exact: true })
      .click();
    await page.getByRole('button', { name: '删除服务', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('此操作完成后不能撤销');
    expect((await getService(page, owned.id)).id).toBe(owned.id);
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    expect((await getService(page, owned.id)).id).toBe(owned.id);
    await page.getByRole('button', { name: '删除服务', exact: true }).click();
    const deletion = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname === `/api/services/${owned!.id}`,
    );
    await page.getByRole('dialog').getByRole('button', { name: '删除服务', exact: true }).click();
    const deleteResponse = await deletion;
    expect(deleteResponse.status()).toBe(202);
    const removal = (await deleteResponse.json()).data as Operation;
    await expect(page).toHaveURL(new RegExp(`/operations/${removal.id}$`));
    await expect(page.locator('.page-head .badge')).toHaveText('已完成', { timeout: 120_000 });
    expect((await page.request.get(`/api/services/${owned.id}`)).status()).toBe(404);
    deleted = true;
    events.push({ action: 'delete', id: removal.id, status: 'succeeded' });
    await expect(
      page.getByText('服务已删除，原任务目标与结果仍保留。', { exact: true }),
    ).toBeVisible();
    await page.goto(`/deployments/${deployment.id}`);
    await expect(page.locator('.page-head .badge')).toHaveText('已完成');
    await expect(
      page.getByText('服务已删除，此部署作为历史记录保留。', { exact: true }),
    ).toBeVisible();
    expect([
      preserved(await getService(page, a.id)),
      preserved(await getService(page, b.id)),
    ]).toEqual(before);
    await evidence(info, 'ui-service-lifecycle', {
      passed: true,
      ownedServiceId: owned.id,
      slug,
      events,
      podSelectionClosedStream: true,
      deletionPreservedHistory: true,
      preservedServices: before,
    });
  } finally {
    if (owned && !deleted) {
      // Cleanup is limited to the unique service created by this test, using the
      // same visible confirmation flow. A/B identifiers are never eligible.
      const current = await page.request.get(`/api/services/${owned.id}`);
      if (current.status() === 200) {
        const resource = (await current.json()).data as Service;
        expect(resource.slug, 'Refused cleanup outside this browser test.').toBe(slug);
        expect([a.id, b.id], 'Preserved services are never cleanup targets.').not.toContain(
          resource.id,
        );
        if (!resource.activeTask) {
          await page.goto(pathFor(resource, 'configuration'));
          await page.getByRole('button', { name: '删除服务', exact: true }).click();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '删除服务', exact: true })
            .click();
          await expect(page.locator('.page-head .badge')).toHaveText('已完成', {
            timeout: 120_000,
          });
        }
      }
    }
  }
});
