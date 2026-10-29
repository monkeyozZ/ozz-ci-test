import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const baseURL = new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173');
const artifacts = new URL('../tests/artifacts/', import.meta.url);
const output = new URL('browser-baseline.json', artifacts);
const verify = expect.configure({ timeout: 12_000 });
const round = (value) => Math.round(value * 100) / 100;

class BaselineError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Runs before the app in each document. Only timings, event types and numeric IDs are collected;
// input values, key characters, DOM text, resource URLs and session material are never recorded.
export function installObservers() {
  const state = {
    supported: globalThis.PerformanceObserver.supportedEntryTypes,
    events: [],
    longTasks: [],
    layoutShifts: [],
    lcp: null,
    cls: 0,
    shiftSum: 0,
    droppedSamples: 0,
  };
  let sessionStart = 0;
  let lastShift = null;
  let sessionValue = 0;
  const observers = [];
  const append = (list, value) => {
    if (list.length < 2_000) list.push(value);
    else state.droppedSamples++;
  };
  const observe = (type, handle, options = {}) => {
    if (!state.supported.includes(type)) return;
    const observer = new globalThis.PerformanceObserver((list) => handle(list.getEntries()));
    observer.observe({ type, buffered: true, ...options });
    observers.push({ observer, handle });
  };
  observe(
    'event',
    (entries) => {
      for (const entry of entries) {
        if (!entry.interactionId) continue;
        append(state.events, {
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
          interactionId: entry.interactionId,
        });
      }
    },
    { durationThreshold: 16 },
  );
  observe('longtask', (entries) => {
    for (const entry of entries)
      append(state.longTasks, { startTime: entry.startTime, duration: entry.duration });
  });
  observe('largest-contentful-paint', (entries) => {
    for (const entry of entries) state.lcp = { startTime: entry.startTime, size: entry.size };
  });
  observe('layout-shift', (entries) => {
    for (const entry of entries) {
      append(state.layoutShifts, {
        startTime: entry.startTime,
        value: entry.value,
        hadRecentInput: entry.hadRecentInput,
        sources: (entry.sources ?? []).map((source) => ({
          tag: source.node?.tagName ?? null,
          class: typeof source.node?.className === 'string' ? source.node.className : null,
          previous: source.previousRect?.toJSON(),
          current: source.currentRect?.toJSON(),
        })),
      });
      if (entry.hadRecentInput) continue;
      state.shiftSum += entry.value;
      if (
        lastShift === null ||
        entry.startTime - lastShift >= 1_000 ||
        entry.startTime - sessionStart >= 5_000
      ) {
        sessionStart = entry.startTime;
        sessionValue = 0;
      }
      sessionValue += entry.value;
      lastShift = entry.startTime;
      state.cls = Math.max(state.cls, sessionValue);
    }
  });
  state.flush = () => {
    for (const { observer, handle } of observers) handle(observer.takeRecords());
  };
  globalThis.__ozzBrowserBaseline = state;
}

export async function paint(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
      ),
  );
}

async function ready(page, heading) {
  await verify(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
  await page.locator('.skeleton').first().waitFor({ state: 'hidden' });
  await page.evaluate(() => globalThis.document.fonts.ready);
  await paint(page);
}

export async function snapshot(page) {
  return page.evaluate(() => {
    const metrics = globalThis.__ozzBrowserBaseline;
    metrics.flush();
    const navigation = globalThis.performance.getEntriesByType('navigation')[0];
    const resources = globalThis.performance.getEntriesByType('resource');
    const paints = Object.fromEntries(
      globalThis.performance
        .getEntriesByType('paint')
        .map((entry) => [entry.name, entry.startTime]),
    );
    return {
      timeOrigin: globalThis.performance.timeOrigin,
      observedUntilMs: globalThis.performance.now(),
      navigation: navigation
        ? {
            type: navigation.type,
            responseStartMs: navigation.responseStart,
            responseEndMs: navigation.responseEnd,
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
            loadMs: navigation.loadEventEnd,
            transferBytes: navigation.transferSize,
          }
        : null,
      paints,
      largestContentfulPaintObserved: metrics.lcp,
      clsSessionWindowMax: metrics.cls,
      layoutShiftSumExcludingRecentInput: metrics.shiftSum,
      layoutShifts: metrics.layoutShifts,
      longTasks: metrics.longTasks,
      eventTimings: metrics.events,
      interactionCount: globalThis.performance.interactionCount ?? null,
      supportedEntryTypes: metrics.supported,
      droppedSamples: metrics.droppedSamples,
      resources: {
        count: resources.length,
        transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        encodedBodyBytes: resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        zeroTransferCount: resources.filter((entry) => entry.transferSize === 0).length,
        scriptTransferBytes: resources
          .filter((entry) => entry.initiatorType === 'script')
          .reduce((sum, entry) => sum + entry.transferSize, 0),
      },
    };
  });
}

// Observe a DOM condition in the browser from before the input. The next rAF is a paint estimate,
// not a compositor presentation timestamp. Runner wall time is reported separately.
export async function interaction(page, label, condition, act) {
  await page.evaluate((condition) => {
    const probe = { firstInputAt: null, domReadyAt: null, nextFrameAt: null, inputType: null };
    const eventTypes = ['pointerdown', 'keydown', 'input', 'change', 'click'];
    const capture = (event) => {
      if (!event.isTrusted || probe.firstInputAt !== null) return;
      probe.firstInputAt = event.timeStamp;
      probe.inputType = event.type;
    };
    const visible = (element) => {
      if (!element || !element.getClientRects().length) return false;
      const style = globalThis.getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const matches = () => {
      const document = globalThis.document;
      if (condition.path && globalThis.location.pathname !== condition.path) return false;
      if (
        condition.dark !== undefined &&
        document.documentElement.classList.contains('dark') !== condition.dark
      )
        return false;
      if (condition.selector) {
        const element = document.querySelector(condition.selector);
        if (condition.hidden ? visible(element) : !visible(element)) return false;
        if (condition.focused && element !== document.activeElement) return false;
        if (condition.value !== undefined && element?.value !== condition.value) return false;
        if (condition.text !== undefined && !element?.textContent?.includes(condition.text))
          return false;
      }
      if (condition.alsoSelector) {
        const related = document.querySelector(condition.alsoSelector);
        if (!visible(related) || !related.textContent?.includes(condition.alsoText)) return false;
      }
      return true;
    };
    const stop = () => {
      probe.stopped = true;
      for (const type of eventTypes) globalThis.document.removeEventListener(type, capture, true);
    };
    for (const type of eventTypes) globalThis.document.addEventListener(type, capture, true);
    const poll = () => {
      if (probe.stopped) return;
      if (probe.firstInputAt !== null && matches()) {
        probe.domReadyAt = globalThis.performance.now();
        globalThis.requestAnimationFrame(() => {
          probe.nextFrameAt = globalThis.performance.now();
          stop();
        });
      } else globalThis.requestAnimationFrame(poll);
    };
    probe.startedAt = globalThis.performance.now();
    probe.stop = stop;
    globalThis.__ozzFeedbackProbe = probe;
    globalThis.requestAnimationFrame(poll);
  }, condition);
  const startedAt = performance.now();
  try {
    await act();
    await page.waitForFunction(
      () => typeof globalThis.__ozzFeedbackProbe?.nextFrameAt === 'number',
      undefined,
      { timeout: 12_000 },
    );
    return await page.evaluate(
      ({ label, runnerElapsedMs }) => {
        const probe = globalThis.__ozzFeedbackProbe;
        const metrics = globalThis.__ozzBrowserBaseline;
        metrics.flush();
        const events = metrics.events.filter((entry) => entry.startTime >= probe.startedAt);
        return {
          label,
          documentTimeOrigin: globalThis.performance.timeOrigin,
          inputType: probe.inputType,
          inputToDomConditionMs: probe.domReadyAt - probe.firstInputAt,
          inputToNextFrameEstimateMs: probe.nextFrameAt - probe.firstInputAt,
          runnerActionAndVerificationMs: runnerElapsedMs,
          sampledEventDurationsMs: events.map((entry) => entry.duration),
          maxSampledEventDurationMs: events.length
            ? Math.max(...events.map((entry) => entry.duration))
            : null,
        };
      },
      { label, runnerElapsedMs: round(performance.now() - startedAt) },
    );
  } finally {
    await page.evaluate(() => globalThis.__ozzFeedbackProbe?.stop()).catch(() => undefined);
  }
}

async function countCollection(request, resource) {
  let count = 0;
  let cursor;
  const cursors = new Set();
  for (let pages = 1; pages <= 100; pages++) {
    const url = new URL(`/api/${resource}`, baseURL);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await request.get(url.href);
    if (!response.ok()) throw new BaselineError(`count-${resource}-http-${response.status()}`);
    const result = await response.json();
    if (!Array.isArray(result.data) || !result.page)
      throw new BaselineError(`count-${resource}-schema`);
    count += result.data.length;
    if (!result.page.hasMore) return { count, complete: true, pages };
    cursor = result.page.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new BaselineError(`count-${resource}-cursor`);
    cursors.add(cursor);
  }
  return {
    count,
    complete: false,
    pages: 100,
    reason: 'Read cap reached; this count is a lower bound.',
  };
}

async function run() {
  const startedAt = performance.now();
  const report = {
    startedAt: new Date().toISOString(),
    status: 'running',
    environment: {
      node: process.version,
      operatingSystem: { platform: platform(), release: release(), arch: arch() },
      cpu: { model: cpus()[0]?.model ?? null, logicalCores: cpus().length },
      memoryBytes: totalmem(),
      origin: baseURL.origin,
      network:
        'Unthrottled browser requests; no CPU throttling. Default target is a local preview and real local API.',
      headless: true,
      browserChannel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
      viewports: [
        { width: 1440, height: 1000 },
        { width: 390, height: 1000 },
      ],
      deviceScaleFactor: 1,
    },
    limits: [
      'S1 and the observed live record counts only; no seeded 100-service/10,000-deployment scale or Oracle hardware claim.',
      'Cold/warm means cleared versus reused HTTP cache on hard navigation. Each hard navigation starts a new Vue Query cache.',
      'Input-to-DOM condition and the next rAF are in-browser feedback estimates; they are not compositor paint timestamps.',
      'Event Timing uses a 16ms threshold and browser quantization. Missing event samples do not mean zero latency.',
      'This short scripted session is not field INP, a certified INP score or a percentile-based capacity benchmark.',
      'CLS uses the maximum 5-second session window with 1-second gaps, excluding recent-input shifts, over each sampled document.',
      'LCP is the largest candidate observed up to the snapshot; automated screenshots are not a physical-device or screen-reader test.',
    ],
    recordCounts: {},
    navigations: [],
    interactions: [],
    interactionDocuments: [],
    screenshots: [],
    skipped: [],
    unexpectedMetadataWrites: 0,
  };
  let phase = 'prepare';
  let browser;
  let context;
  let page;
  let authenticated = false;
  try {
    let password = process.env.E2E_PASSWORD;
    if (!password) {
      try {
        password = (
          await readFile(new URL('../../../.secrets/admin-password', import.meta.url), 'utf8')
        ).trim();
      } catch {
        throw new BaselineError('Set-E2E_PASSWORD-or-initialize-local-administrator');
      }
    }
    if (!password) throw new BaselineError('empty-password');
    await mkdir(artifacts, { recursive: true });
    browser = await chromium.launch({ channel: report.environment.browserChannel, headless: true });
    context = await browser.newContext({
      baseURL: baseURL.origin,
      viewport: report.environment.viewports[0],
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      colorScheme: 'light',
      reducedMotion: 'no-preference',
    });
    context.setDefaultTimeout(12_000);
    context.setDefaultNavigationTimeout(20_000);
    await context.addInitScript(installObservers);
    page = await context.newPage();
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.startsWith('/api/') &&
        !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
        !['/api/auth/login', '/api/auth/logout'].includes(path)
      )
        report.unexpectedMetadataWrites++;
    });
    phase = 'production-check';
    await page.goto('/login');
    await verify(page.getByLabel('管理员账号', { exact: true })).toBeVisible();
    const scripts = await page.evaluate(() =>
      [...globalThis.document.scripts]
        .filter((script) => script.src)
        .map((script) => new URL(script.src).pathname),
    );
    if (
      scripts.some((path) => path.includes('@vite/client') || path.includes('/src/')) ||
      !scripts.some((path) => path.startsWith('/assets/') && path.endsWith('.js'))
    )
      throw new BaselineError('serve-production-dist-before-measuring');
    report.environment.entryScripts = scripts;
    report.environment.browserVersion = browser.version();
    report.environment.browser = await page.evaluate(() => ({
      userAgent: globalThis.navigator.userAgent,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      reducedMotion: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
    }));
    phase = 'ui-login';
    await page.getByLabel('管理员账号', { exact: true }).fill(process.env.E2E_USERNAME ?? 'admin');
    await page.getByLabel('密码', { exact: true }).fill(password);
    password = undefined;
    const [loginResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/auth/login' &&
          response.request().method() === 'POST',
      ),
      page.getByRole('button', { name: '登录工作台', exact: true }).click(),
    ]);
    if (!loginResponse.ok()) throw new BaselineError(`login-http-${loginResponse.status()}`);
    authenticated = true;
    await verify(page).toHaveURL(new URL('/projects', baseURL).href);
    await ready(page, '我的项目');

    phase = 'count-live-resources';
    for (const resource of ['projects', 'clusters', 'servers', 'secrets', 'operations'])
      report.recordCounts[resource] = await countCollection(context.request, resource);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    for (const cache of ['cold-http-cache', 'warm-http-cache']) {
      phase = `navigation-${cache}`;
      const start = performance.now();
      await page.goto('/projects', { waitUntil: 'load' });
      await ready(page, '我的项目');
      report.navigations.push({
        path: '/projects',
        cache,
        runnerToReadyMs: round(performance.now() - start),
        metrics: await snapshot(page),
      });
    }
    await cdp.detach();

    const measure = async (label, condition, action) => {
      phase = label;
      report.interactions.push(await interaction(page, label, condition, action));
    };
    const command = page.getByRole('combobox', { name: '搜索资源或操作', exact: true });
    await measure(
      'command-open-keyboard',
      { selector: '[role="combobox"][aria-label="搜索资源或操作"]', focused: true },
      () => page.keyboard.press('ControlOrMeta+k'),
    );
    await measure(
      'command-search',
      { selector: '#command-results [role="option"]', text: '登记服务器' },
      () => command.fill('登记服务器'),
    );
    await measure('command-close-keyboard', { selector: '[role="dialog"]', hidden: true }, () =>
      page.keyboard.press('Escape'),
    );

    const search = page.getByRole('textbox', { name: '搜索已载入项目', exact: true });
    if (await search.isVisible()) {
      const unmatched = `__baseline_${randomUUID()}`;
      await measure(
        'project-search-no-match',
        { selector: '.empty-state', text: '没有匹配的项目' },
        () => search.fill(unmatched),
      );
      await measure('project-search-clear', { selector: '.project-card' }, () => search.fill(''));
    } else
      report.skipped.push({
        label: 'project-list-search',
        reason: 'The live project list is empty; no fixture was inserted.',
      });

    const changeTheme = async (theme, record = false) => {
      await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
      const action = () =>
        page
          .getByRole('menuitemradio', { name: theme === 'dark' ? '深色' : '浅色', exact: true })
          .click();
      if (record)
        await measure(
          `theme-${theme}`,
          { dark: theme === 'dark', selector: '.theme-menu', hidden: true },
          action,
        );
      else await action();
      await verify(page.locator('html')).toHaveCSS('color-scheme', theme);
    };
    await changeTheme('dark', true);
    await changeTheme('light', true);
    report.interactionDocuments.push({ label: 'projects-desktop', metrics: await snapshot(page) });

    phase = 'server-form-navigation';
    await page.goto('/servers/new');
    await ready(page, '登记服务器');
    const draft = '浏览器基线未保存草稿';
    const name = page.getByLabel('服务器名称', { exact: true });
    await measure(
      'form-draft-input',
      {
        selector: '#server-name',
        value: draft,
        alsoSelector: '.section-head .badge',
        alsoText: '尚未保存',
      },
      () => name.fill(draft),
    );
    const projectLink = page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '项目', exact: true });
    const confirm = page.getByRole('dialog', { name: '离开前保留当前编辑？', exact: true });
    await measure(
      'unsaved-guard-open',
      { selector: '[role="dialog"]', text: '离开前保留当前编辑？' },
      () => projectLink.click(),
    );
    await measure(
      'unsaved-guard-cancel',
      { path: '/servers/new', selector: '[role="dialog"]', hidden: true },
      () => confirm.getByRole('button', { name: '取消', exact: true }).click(),
    );
    await verify(name).toHaveValue(draft);
    await projectLink.click();
    await measure(
      'unsaved-guard-discard',
      { path: '/projects', selector: '#main-content h1', text: '我的项目' },
      () => confirm.getByRole('button', { name: '放弃修改并离开', exact: true }).click(),
    );
    await ready(page, '我的项目');
    report.interactionDocuments.push({
      label: 'server-draft-and-discard',
      metrics: await snapshot(page),
    });

    for (const width of [1440, 390]) {
      phase = `screenshots-${width}`;
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await changeTheme(theme);
        await paint(page);
        const overflow = await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth + 1,
        );
        const filename = `baseline-projects-${width}-${theme}.png`;
        await page.screenshot({
          path: fileURLToPath(new URL(filename, artifacts)),
          fullPage: true,
          animations: 'disabled',
        });
        report.screenshots.push({
          file: filename,
          width,
          height: 1000,
          theme,
          horizontalOverflow: overflow,
        });
        if (overflow) throw new BaselineError(`horizontal-overflow-${width}-${theme}`);
      }
    }
    await measure(
      'mobile-navigation-open',
      { selector: '[role="dialog"]', text: '工作台导航' },
      () => page.getByRole('button', { name: '打开导航', exact: true }).click(),
    );
    await measure('mobile-navigation-close', { selector: '[role="dialog"]', hidden: true }, () =>
      page.getByRole('button', { name: '关闭导航', exact: true }).click(),
    );
    await verify(page.getByRole('button', { name: '打开导航', exact: true })).toBeFocused();
    report.interactionDocuments.push({
      label: 'themes-and-mobile-navigation',
      metrics: await snapshot(page),
    });
    if (report.unexpectedMetadataWrites) throw new BaselineError('unexpected-metadata-write');
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    // Do not emit Playwright's raw error message: action logs can contain filled values.
    report.failure = {
      phase,
      code:
        error instanceof BaselineError
          ? error.code
          : error?.name === 'TimeoutError'
            ? 'timeout'
            : 'verification-or-browser-error',
    };
    process.exitCode = 1;
  } finally {
    if (authenticated && context) {
      try {
        const response = await context.request.get(new URL('/api/auth/me', baseURL).href);
        if (response.ok()) {
          const session = (await response.json()).data;
          const logout = await context.request.post(new URL('/api/auth/logout', baseURL).href, {
            headers: { Origin: baseURL.origin, 'X-CSRF-Token': session.csrfToken },
          });
          report.sessionRevoked = logout.status() === 204;
        } else report.sessionRevoked = response.status() === 401;
      } catch {
        report.sessionRevoked = false;
      }
    }
    await browser?.close().catch(() => undefined);
    report.completedAt = new Date().toISOString();
    report.durationMs = round(performance.now() - startedAt);
    const timings = report.interactions.map((item) => item.inputToNextFrameEstimateMs);
    report.summary = {
      navigationSamples: report.navigations.length,
      feedbackSamples: timings.length,
      maxInputToNextFrameEstimateMs: timings.length ? round(Math.max(...timings)) : null,
      maxSampledEventDurationMs: report.interactions.reduce(
        (max, item) =>
          item.maxSampledEventDurationMs === null
            ? max
            : Math.max(max ?? 0, item.maxSampledEventDurationMs),
        null,
      ),
      maxObservedDocumentCls: Math.max(
        0,
        ...[...report.navigations, ...report.interactionDocuments].map(
          (item) => item.metrics.clsSessionWindowMax,
        ),
      ),
    };
    await mkdir(artifacts, { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(
      JSON.stringify({
        status: report.status,
        report: fileURLToPath(output),
        summary: report.summary,
        ...(report.failure ? { failure: report.failure } : {}),
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log(
      'From the repository root, after serving a production Console build with its real /api proxy:',
    );
    console.log(
      'PLAYWRIGHT_CHANNEL=chrome node_modules/.bin/node apps/console/scripts/measure-browser.mjs',
    );
    console.log(
      'Optional: E2E_BASE_URL, E2E_USERNAME, E2E_PASSWORD. Password otherwise comes from protected .secrets/admin-password.',
    );
    console.log(
      'Writes tests/artifacts/browser-baseline.json and four screenshots. Uses one UI login, real read-only resources and unsaved UI edits; revokes its session afterward.',
    );
  } else await run();
}
