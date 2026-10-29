import { readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { test, expect } from '@playwright/test';
import { login } from '../e2e/helpers';
import { installObservers, interaction, paint, snapshot } from '../../scripts/measure-browser.mjs';
import {
  buildFrontendFixtures,
  installControlledSource,
  serveFrontendFixtures,
} from './s3-performance-fixtures.mjs';

const durationMs = Number(process.env.S3_PERFORMANCE_DURATION_MS ?? 600_000);
const round = (value) => Math.round(value * 100) / 100;
const servicePath = (service, tab = 'overview') =>
  `/projects/${service.projectId}/services/${service.id}?environment=${service.environment.slug}&tab=${tab}`;

async function readApi(page, path) {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `Read-only template ${path}`).toBe(true);
  return response.json();
}

function interactionSummary(metrics) {
  const grouped = new Map();
  for (const event of metrics.eventTimings)
    grouped.set(
      event.interactionId,
      Math.max(grouped.get(event.interactionId) ?? 0, event.duration),
    );
  const durations = [...grouped.values()].sort((a, b) => b - a);
  const ids = [...grouped.keys()];
  const count =
    metrics.interactionCount ?? (ids.length ? (Math.max(...ids) - Math.min(...ids)) / 7 + 1 : 0);
  const index = Math.floor(count / 50);
  return {
    interactions: count,
    countSource:
      metrics.interactionCount === null
        ? 'Chromium interactionId spacing estimate'
        : 'performance.interactionCount',
    sampledInteractionsAtLeast16ms: grouped.size,
    sessionInpEstimateMs: durations[index] ?? (count ? 16 : null),
    estimateIsUpperBound16ms: count > 0 && index >= durations.length,
    maxSampledInteractionMs: durations[0] ?? null,
    cls: metrics.clsSessionWindowMax,
  };
}

async function memory(cdp, collect = false) {
  if (collect) await cdp.send('HeapProfiler.collectGarbage');
  const [performanceMetrics, dom] = await Promise.all([
    cdp.send('Performance.getMetrics'),
    cdp.send('Memory.getDOMCounters'),
  ]);
  const values = Object.fromEntries(
    performanceMetrics.metrics.map((item) => [item.name, item.value]),
  );
  return {
    jsHeapUsedBytes: values.JSHeapUsedSize,
    jsHeapTotalBytes: values.JSHeapTotalSize,
    nodes: dom.nodes,
    documents: dom.documents,
    listeners: dom.jsEventListeners,
  };
}

async function logState(page) {
  return page.evaluate(() => {
    const text = globalThis.document.querySelector('.runtime-log-output pre')?.textContent ?? '';
    const output = globalThis.document.querySelector('.runtime-log-output');
    const source = globalThis.__s3PerformanceSource;
    return {
      observedAt: globalThis.performance.now(),
      documentVisibility: globalThis.document.visibilityState,
      documentHasFocus: globalThis.document.hasFocus(),
      characters: Number(output?.getAttribute('data-buffer-characters') ?? 0),
      lines: Number(output?.getAttribute('data-buffer-lines') ?? 0),
      utf8Bytes: Number(output?.getAttribute('data-buffer-bytes') ?? 0),
      renderedCharacters: text.length,
      renderedRows: output?.querySelectorAll('.virtual-log-line').length ?? 0,
      truncated: [...globalThis.document.querySelectorAll('[data-service-logs] p')].some((item) =>
        item.textContent.includes('视图已裁剪'),
      ),
      source: {
        active: source.active,
        activeTimers: source.activeTimers,
        generatedLines: source.generatedLines,
        generatedBytes: source.generatedBytes,
        connections: source.connections.map((item) => ({ ...item })),
      },
    };
  });
}

test('S3 受控前端大样本与双日志窗口持续性能', async ({ page, context, browser }, info) => {
  const report = {
    source: 'CONTROLLED_FRONTEND_ONLY',
    startedAt: new Date().toISOString(),
    qualifyingTenMinuteRun: false,
    requestedDurationMs: durationMs,
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
      physicalMemoryBytes: totalmem(),
      browser: browser.version(),
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      headless: true,
      network:
        'Native production assets on local preview; native HTTP to an ephemeral loopback fixture API with 5ms delay; no CPU/network throttle.',
      cpuProfilerEnabled: Boolean(process.env.S3_PERFORMANCE_PROFILE),
      concurrentWorkloads: process.env.S3_PERFORMANCE_CONTEXT ?? 'Not specified by runner.',
    },
    limits: [
      'Exactly 100 service metadata and 10,000 deployment history fixtures, generated in test-runner memory. No real metadata writes, remote workloads or backend capacity inference.',
      'Production UI honors 50-row cursor pagination. The fixture has 100 histories per service; the test loads 100 for one service and applies status filtering to the full fixture scope.',
      'Two concurrent browser pages use controlled SSE-shaped ReadableStreams at 10 chunks/second. Each connection ends by 55 seconds or 1 MiB and is restarted through the normal UI; no backend limit is changed.',
      'The actual native finite SSE and cancellation contract is covered separately by s3.spec.ts; this source is only frontend pressure.',
      'The existing 200,000 UTF-16 character cap is stricter than 5 MiB. The additional 10,000-line cap applies first when shorter lines fill it.',
      'Feedback is trusted-input to DOM condition and next-rAF estimate, not compositor presentation time. INP is an Event Timing estimate for this scripted interactive session, not field INP.',
      'Event Timing has a 16ms threshold and 8ms quantization. A missing fast sample gives an upper bound of 16ms, not zero.',
      'Chinese composition uses Chromium CDP IME events; it is not a physical IME or screen-reader certification.',
      'Cold/warm means cleared/reused HTTP cache; each hard navigation has a new Vue Query cache. Controlled API responses do not measure network or database latency.',
      'Memory is Chromium renderer heap/DOM counters. GC is forced only at baseline and post-run cleanup; Node fixture memory and operating-system RSS are separate.',
    ],
    navigations: [],
    interactions: [],
    documents: [],
    logSamples: [],
    memory: [],
    compositionChecks: [],
    screenshots: [],
    errors: [],
  };
  const extraPages = [];
  let fixtures;
  let fixtureServer;
  const recordInteraction = async (target, label, condition, action) => {
    report.interactions.push(await interaction(target, label, condition, action));
  };
  const recordDocument = async (target, label) => {
    const metrics = await snapshot(target);
    report.documents.push({ label, summary: interactionSummary(metrics), metrics });
  };
  const recordScreenshot = async (target, label) => {
    const path = info.outputPath(`${label}.png`);
    await target.screenshot({ path, animations: 'disabled' });
    await info.attach(label, { path, contentType: 'image/png' });
    report.screenshots.push(label);
  };
  try {
    context.setDefaultTimeout(15_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await login(page);
    const lab = JSON.parse(
      await readFile(
        new URL('../../../../.local/local-lab/service-product-state.json', import.meta.url),
        'utf8',
      ),
    );
    const service = (await readApi(page, `/services/${lab.services.a}`)).data;
    const seedParts = await Promise.all([
      readApi(page, '/auth/me'),
      readApi(page, `/deployments/${service.published.deploymentId}`),
      readApi(page, `/projects/${service.projectId}`),
      readApi(page, '/clusters?limit=100'),
      readApi(page, `/environments?projectId=${service.projectId}&limit=100`),
      readApi(page, `/deployments/${service.published.deploymentId}/logs?limit=100`),
    ]);
    fixtures = buildFrontendFixtures({
      service,
      session: seedParts[0],
      deployment: seedParts[1].data,
      project: seedParts[2],
      clusters: seedParts[3],
      environments: seedParts[4],
      logs: seedParts[5],
    });
    report.fixtureCounts = {
      services: fixtures.services.length,
      deployments: fixtures.deployments.length,
    };
    fixtureServer = await serveFrontendFixtures(fixtures, new URL(page.url()).origin);
    report.environment.fixtureOrigin = fixtureServer.origin;
    await context.addInitScript(installObservers);
    await context.addInitScript(installControlledSource, {
      shortServiceId: fixtures.services[1].id,
      metadataOrigin: fixtureServer.origin,
    });
    const watchErrors = (target) =>
      target.on('pageerror', (error) => report.errors.push(error.message));
    watchErrors(page);
    const controlCdp = await context.newCDPSession(page);
    await controlCdp.send('Performance.enable');
    await controlCdp.send('Network.clearBrowserCache');
    for (const cache of ['cold', 'warm']) {
      const started = performance.now();
      await page.goto('/services', { waitUntil: 'load' });
      await expect(page.locator('.service-row')).toHaveCount(50);
      await page.evaluate(() => globalThis.document.fonts.ready);
      await paint(page);
      const scripts = await page.evaluate(() =>
        [...globalThis.document.scripts]
          .filter((item) => item.src)
          .map((item) => new URL(item.src).pathname),
      );
      expect(scripts.some((path) => path.includes('@vite/client') || path.includes('/src/'))).toBe(
        false,
      );
      report.environment.entryScripts = scripts;
      expect(scripts.some((path) => path.startsWith('/assets/') && path.endsWith('.js'))).toBe(
        true,
      );
      const metrics = await snapshot(page);
      report.navigations.push({
        cache,
        runnerToReadyMs: round(performance.now() - started),
        metrics,
      });
    }
    await recordInteraction(
      page,
      'load-100-service-metadata',
      { selector: '.service-row:nth-child(100)' },
      () => page.getByRole('button', { name: '载入更多服务', exact: true }).click(),
    );
    await expect(page.locator('.service-row')).toHaveCount(100);
    await recordInteraction(
      page,
      'service-filter-full-scope',
      { selector: '.service-row .service-name', text: '前端性能样本 100' },
      () => page.getByRole('textbox', { name: '搜索服务', exact: true }).fill('前端性能样本 100'),
    );
    await expect(page.locator('.service-row')).toHaveCount(1);
    await recordInteraction(
      page,
      'service-filter-clear',
      { selector: '.service-row:nth-child(100)' },
      () => page.getByRole('textbox', { name: '搜索服务', exact: true }).fill(''),
    );
    await recordScreenshot(page, 'controlled-100-service-metadata');
    await recordInteraction(
      page,
      'service-navigation',
      { selector: '#main-content h1', text: fixtures.services[0].name },
      () => page.locator(`[data-service-id="${fixtures.services[0].id}"] .service-name`).click(),
    );
    await recordInteraction(
      page,
      'deployment-history-navigation',
      { selector: '.deployment-row' },
      () =>
        page
          .getByRole('navigation', { name: '服务页面' })
          .getByRole('link', { name: '部署记录', exact: true })
          .click(),
    );
    await expect(page.locator('.deployment-row')).toHaveCount(50);
    await recordInteraction(
      page,
      'deployment-history-second-page',
      { selector: '.deployment-row:nth-child(100)' },
      () => page.getByRole('button', { name: '载入更多部署', exact: true }).click(),
    );
    // selectOption dispatches synthetic change events; verify it but do not report it as
    // trusted-input latency. The text-search filters above supply trusted filter timings.
    await page.getByRole('combobox', { name: '筛选部署状态', exact: true }).selectOption('failed');
    await expect(page.locator('.deployment-row')).toHaveCount(20);
    await page
      .getByRole('combobox', { name: '筛选部署状态', exact: true })
      .selectOption('succeeded');
    await recordInteraction(
      page,
      'historical-task-open',
      { selector: '[data-deployment-stages]' },
      () => page.locator('.deployment-row').first().click(),
    );
    await recordScreenshot(page, 'controlled-deployment-history-task');
    await page.getByRole('link', { name: '返回服务', exact: true }).click();
    await recordInteraction(
      page,
      'configuration-editor-open',
      { selector: '.configuration-editor' },
      () =>
        page
          .getByRole('navigation', { name: '服务页面' })
          .getByRole('link', { name: '配置草稿', exact: true })
          .click(),
    );
    await recordInteraction(
      page,
      'configuration-draft-input',
      { selector: '[aria-label="有未保存修改"]' },
      () => page.getByLabel('服务名称', { exact: true }).fill('中文性能草稿'),
    );
    await page.getByLabel('服务名称', { exact: true }).fill(fixtures.services[0].name);
    await recordDocument(page, 'large-fixture-navigation-edit-task');

    const logPages = [];
    for (let index = 0; index < 2; index++) {
      const target = await context.newPage();
      extraPages.push(target);
      watchErrors(target);
      await target.goto(servicePath(fixtures.services[index], 'logs'));
      await expect(target.getByRole('button', { name: '读取日志尾部', exact: true })).toBeEnabled();
      const cdp = await context.newCDPSession(target);
      await cdp.send('Performance.enable');
      if (process.env.S3_PERFORMANCE_PROFILE) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      logPages.push({
        page: target,
        cdp,
        label: index ? 'short-lines' : 'long-lines',
        clipsSeen: 0,
      });
      report.memory.push({
        label: index ? 'short-lines-baseline' : 'long-lines-baseline',
        ...(await memory(cdp, true)),
      });
      await target.getByRole('checkbox', { name: '持续跟随输出', exact: true }).check();
    }
    // Five concurrent controlled management reads every second throughout the dual-log run.
    await page.evaluate(() => {
      const source = globalThis.__s3PerformanceSource;
      const batch = async () => {
        source.management.batches++;
        source.management.active++;
        try {
          const responses = await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
              globalThis
                .fetch(`/api/services?limit=50&performanceRequest=${index}`)
                .then(async (response) => {
                  await response.json();
                  return response.status;
                }),
            ),
          );
          source.management.responses += responses.length;
          source.management.errors += responses.filter((status) => status !== 200).length;
        } catch {
          source.management.errors++;
        } finally {
          source.management.active--;
        }
      };
      globalThis.__s3ManagementTimer = globalThis.setInterval(() => void batch(), 1000);
      void batch();
    });
    console.log(
      `CONTROLLED FRONTEND: dual log stress started, requested ${durationMs}ms; independent of API/Worker.`,
    );
    for (const item of logPages) {
      await item.page.getByRole('button', { name: '开始跟随日志', exact: true }).click();
      await expect(item.page.locator('.runtime-log-output pre')).not.toHaveText('');
    }
    const started = performance.now();
    report.logStartedAt = new Date().toISOString();
    let cycle = 0;
    let nextInteraction = 0;
    while (performance.now() - started < durationMs) {
      for (const item of logPages) {
        const startButton = item.page.getByRole('button', { name: '开始跟随日志', exact: true });
        if (await startButton.isVisible()) await startButton.click();
      }
      const elapsed = performance.now() - started;
      if (elapsed >= nextInteraction) {
        for (const item of logPages) {
          const target = item.page;
          const output = target.locator('.runtime-log-output');
          const jump = target.getByRole('button', { name: /^回到最新/ });
          if (await jump.isVisible()) await jump.click();
          const pause = target.getByRole('button', { name: '暂停滚动', exact: true });
          if (await pause.isVisible()) {
            await recordInteraction(
              target,
              `${item.label}-pause-${cycle}`,
              { selector: '.log-toolbar [role="status"]', text: '自动滚动已暂停' },
              () => pause.click(),
            );
            const before = await logState(target);
            await output.evaluate((element) => {
              element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 150);
            });
            const anchor = await output.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const row = [...element.querySelectorAll('.virtual-log-line')].find(
                (item) => item.getBoundingClientRect().top >= bounds.top + 1,
              );
              return row
                ? {
                    key: row.getAttribute('data-line-key'),
                    top: row.getBoundingClientRect().top - bounds.top,
                  }
                : null;
            });
            await target.waitForTimeout(240);
            expect((await logState(target)).source.generatedLines).toBeGreaterThan(
              before.source.generatedLines,
            );
            await expect(jump).toContainText('条新输出');
            if (anchor) {
              const offset = await output.evaluate((element, key) => {
                const row = element.querySelector(`[data-line-key="${key}"]`);
                return row
                  ? row.getBoundingClientRect().top - element.getBoundingClientRect().top
                  : null;
              }, anchor.key);
              expect(offset, '暂停时同一行应保持在同一位置').not.toBeNull();
              expect(Math.abs(offset - anchor.top)).toBeLessThan(2);
            }
            if (item.label === 'long-lines') {
              await output.evaluate((element) => {
                element.scrollLeft = 120;
              });
              expect(await output.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
              await expect(target.locator('.log-toolbar [role="status"]')).toContainText(
                '自动滚动已暂停',
              );
            }
            await recordInteraction(
              target,
              `${item.label}-wrap-${cycle}`,
              { selector: '.runtime-log-output.wrap-lines' },
              () => target.getByRole('checkbox', { name: '长行换行', exact: true }).check(),
            );
            await expect(output.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
            await target.getByRole('checkbox', { name: '长行换行', exact: true }).uncheck();
            await recordInteraction(
              target,
              `${item.label}-resume-${cycle}`,
              { selector: '.log-toolbar button', text: '暂停滚动' },
              () => jump.click(),
            );
          }
          if (cycle % 3 === 0) {
            const originalUrl = target.url();
            await recordInteraction(
              target,
              `${item.label}-command-open-${cycle}`,
              { selector: '[role="combobox"][aria-label="搜索资源或操作"]', focused: true },
              () => target.keyboard.press('ControlOrMeta+k'),
            );
            await item.cdp.send('Input.imeSetComposition', {
              text: '服务',
              selectionStart: 2,
              selectionEnd: 2,
            });
            await target.keyboard.press('Enter');
            await expect(
              target.getByRole('dialog', { name: '快速打开', exact: true }),
            ).toBeVisible();
            await target.keyboard.press('Escape');
            await expect(
              target.getByRole('dialog', { name: '快速打开', exact: true }),
            ).toBeVisible();
            expect(target.url()).toBe(originalUrl);
            await item.cdp.send('Input.insertText', { text: '服务' });
            await expect(
              target.getByRole('combobox', { name: '搜索资源或操作', exact: true }),
            ).toHaveValue('服务');
            report.compositionChecks.push({
              window: item.label,
              cycle,
              enterKeptRoute: true,
              escapeKeptDialog: true,
              committedChinese: true,
            });
            await recordInteraction(
              target,
              `${item.label}-command-close-${cycle}`,
              { selector: '[role="dialog"]', hidden: true },
              () => target.keyboard.press('Escape'),
            );
          }
          const state = await logState(target);
          if (cycle === 0 && process.env.S3_PERFORMANCE_PROFILE) {
            const { profile } = await item.cdp.send('Profiler.stop');
            const path = info.outputPath(`${item.label}-startup.cpuprofile`);
            await writeFile(path, JSON.stringify(profile));
            await info.attach(`${item.label}-startup-profile`, {
              path,
              contentType: 'application/json',
            });
          }
          expect(state.characters).toBeLessThanOrEqual(200_000);
          expect(state.lines).toBeLessThanOrEqual(10_000);
          expect(state.utf8Bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
          expect(state.renderedRows).toBeLessThanOrEqual(80);
          if (state.truncated) item.clipsSeen++;
          report.logSamples.push({
            window: item.label,
            elapsedMs: round(performance.now() - started),
            ...state,
          });
          if (cycle % 3 === 0)
            report.memory.push({
              label: `${item.label}-minute-${Math.floor(elapsed / 60_000)}`,
              ...(await memory(item.cdp)),
            });
          if (
            state.truncated &&
            !report.screenshots.includes(`controlled-${item.label}-truncation`)
          )
            await recordScreenshot(target, `controlled-${item.label}-truncation`);
        }
        await recordInteraction(
          page,
          `concurrent-Chinese-draft-${cycle}`,
          { selector: '.configuration-editor input[id$="-name"]', value: `中文性能草稿 ${cycle}` },
          () => page.getByLabel('服务名称', { exact: true }).fill(`中文性能草稿 ${cycle}`),
        );
        console.log(
          `Dual log stress ${Math.floor((performance.now() - started) / 1000)}s / ${durationMs / 1000}s; bounded buffers and interaction cycle ${cycle} checked.`,
        );
        cycle++;
        nextInteraction = elapsed + 20_000;
      }
      await page.waitForTimeout(500);
    }
    report.actualLogDurationMs = round(performance.now() - started);
    report.qualifyingTenMinuteRun = report.actualLogDurationMs >= 600_000;
    report.logEndedAt = new Date().toISOString();
    await page.evaluate(() => globalThis.clearInterval(globalThis.__s3ManagementTimer));
    await expect
      .poll(() => page.evaluate(() => globalThis.__s3PerformanceSource.management.active))
      .toBe(0);
    report.management = await page.evaluate(() => globalThis.__s3PerformanceSource.management);
    expect(report.management.errors).toBe(0);
    for (const item of logPages) {
      const peak = await memory(item.cdp, true);
      const finalState = await logState(item.page);
      expect(item.clipsSeen, `${item.label} must visibly truncate`).toBeGreaterThan(0);
      await item.page.getByRole('button', { name: '复制缓冲日志', exact: true }).click();
      const copied = await item.page.evaluate(() => globalThis.navigator.clipboard.readText());
      expect(copied.length).toBe(finalState.characters);
      expect(copied.split('\n').length).toBeLessThanOrEqual(10_000);
      report.copyChecks ??= [];
      report.copyChecks.push({
        window: item.label,
        copiedCharacters: copied.length,
        renderedCharacters: finalState.renderedCharacters,
        fullBufferedText: true,
      });
      await item.page.getByRole('checkbox', { name: '上次退出的容器', exact: true }).check();
      await expect(item.page.locator('.runtime-log-output pre')).toHaveCount(0);
      const cleared = await memory(item.cdp, true);
      report.memory.push({
        label: `${item.label}-cleared-forced-gc`,
        ...cleared,
        reclaimedBufferHeapBytes: peak.jsHeapUsedBytes - cleared.jsHeapUsedBytes,
      });
      await item.page
        .getByRole('navigation', { name: '服务页面' })
        .getByRole('link', { name: '概览', exact: true })
        .click();
      await expect(item.page.locator('.runtime-log-output')).toHaveCount(0);
      const cleaned = await logState(item.page);
      expect(cleaned.source.active).toBe(0);
      expect(cleaned.source.activeTimers).toBe(0);
      const after = await memory(item.cdp, true);
      report.memory.push(
        { label: `${item.label}-active-forced-gc`, ...peak },
        {
          label: `${item.label}-unmounted-forced-gc`,
          ...after,
          reclaimedHeapBytes: peak.jsHeapUsedBytes - after.jsHeapUsedBytes,
        },
      );
      report.logSamples.push({
        window: item.label,
        final: true,
        ...finalState,
        cleanup: cleaned.source,
      });
      for (const connection of cleaned.source.connections) {
        expect(connection.bytes).toBeLessThanOrEqual(1024 * 1024);
        expect(connection.endedAt - connection.startedAt).toBeLessThanOrEqual(60_000);
      }
      await recordDocument(item.page, `${item.label}-ten-minute-interactive-session`);
    }
    await recordDocument(page, 'concurrent-management-and-editor-session');
    await page.getByLabel('服务名称', { exact: true }).fill(fixtures.services[0].name);
    report.fixtureRequests = fixtures.stats;
    expect(fixtures.stats.peakConcurrent).toBeGreaterThanOrEqual(5);
    expect(fixtures.stats.unexpectedWrites).toBe(0);
    expect(fixtures.stats.unknownReads).toEqual([]);
    expect(report.errors).toEqual([]);
    const feedback = report.interactions
      .map((item) => item.inputToNextFrameEstimateMs)
      .sort((a, b) => a - b);
    report.summary = {
      feedbackSamples: feedback.length,
      maxFeedbackEstimateMs: round(feedback.at(-1)),
      p95FeedbackEstimateMs: round(feedback[Math.ceil(feedback.length * 0.95) - 1]),
      feedbackWithin100ms: feedback.filter((value) => value <= 100).length,
      maxSessionInpEstimateMs: Math.max(
        ...report.documents.map((item) => item.summary.sessionInpEstimateMs ?? 0),
      ),
      maxSessionCls: Math.max(
        ...report.documents.map((item) => item.summary.cls),
        ...report.navigations.map((item) => item.metrics.clsSessionWindowMax),
      ),
      maxBufferedCharacters: Math.max(...report.logSamples.map((item) => item.characters)),
      maxBufferedLines: Math.max(...report.logSamples.map((item) => item.lines)),
      maxBufferedUtf8Bytes: Math.max(...report.logSamples.map((item) => item.utf8Bytes)),
      maxRenderedRows: Math.max(...report.logSamples.map((item) => item.renderedRows)),
    };
    report.targets = {
      feedback100ms: report.summary.maxFeedbackEstimateMs <= 100,
      sessionInp200ms: report.summary.maxSessionInpEstimateMs <= 200,
      clsPointOne: report.summary.maxSessionCls <= 0.1,
    };
    expect.soft(report.summary.maxSessionInpEstimateMs).toBeLessThanOrEqual(200);
    expect.soft(report.summary.maxSessionCls).toBeLessThanOrEqual(0.1);
    report.status = 'completed';
  } finally {
    report.completedAt = new Date().toISOString();
    if (fixtures) report.fixtureRequests = fixtures.stats;
    const path = info.outputPath('frontend-performance.json');
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await info.attach('frontend-performance', { path, contentType: 'application/json' });
    console.log(
      JSON.stringify({
        source: report.source,
        status: report.status ?? 'incomplete',
        requestedDurationMs: durationMs,
        summary: report.summary,
        targets: report.targets,
      }),
    );
    await Promise.all(extraPages.map((target) => target.close()));
    await fixtureServer?.close();
  }
});
