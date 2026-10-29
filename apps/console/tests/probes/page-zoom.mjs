/* global document, window, getComputedStyle, requestAnimationFrame */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// Run from the repository root:
// pnpm exec node apps/console/tests/probes/page-zoom.mjs
// Requires the real API, Worker and production Console preview on E2E_BASE_URL.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const origin = new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173');
if (
  !['http:', 'https:'].includes(origin.protocol) ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
) {
  throw new Error('Page zoom verification requires an explicit local application origin.');
}
const runId = randomUUID().slice(0, 8);
const tag = 'page-zoom-' + runId;
const artifactDirectory = join(root, 'apps/console/tests/artifacts');
const reportFile = join(artifactDirectory, tag + '.json');
const fixtures = [];
const report = {
  runId,
  startedAt: new Date().toISOString(),
  status: 'running',
  origin: origin.origin,
  method: 'Chrome appearance settings: select#zoomLevel 1 -> 2 in an isolated persistent profile',
  environment: { platform: process.platform, node: process.version, window: [1440, 1000] },
  scope: {
    browserPageZoom: true,
    cssZoomChanged: false,
    rootFontSizeChanged: false,
    pinchScaleChanged: false,
    userBrowserProfileUsed: false,
    screenReaderTested: false,
  },
  checks: [],
  layouts: [],
  focus: [],
  screenshots: [],
  cleanup: {
    resources: [],
    logout: false,
    cookiesCleared: false,
    browserClosed: false,
    profileRemoved: false,
  },
};
let context;
let page;
let settings;
let cdp;
let profile;
let currentStep = 'setup';
let loggedIn = false;

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new ProbeFailure(code);
}

async function step(name, work) {
  currentStep = name;
  const check = { name, status: 'running' };
  report.checks.push(check);
  try {
    await work();
    check.status = 'passed';
    console.log(JSON.stringify({ check: name, status: 'passed' }));
  } catch (error) {
    check.status = 'failed';
    throw error;
  }
}

async function settled() {
  await page.locator('.skeleton').first().waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

async function metrics() {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    visualViewportScale: window.visualViewport?.scale ?? null,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    rootCssZoom: getComputedStyle(document.documentElement).zoom,
    bodyCssZoom: getComputedStyle(document.body).zoom,
    inlineRootFontSize: document.documentElement.style.fontSize,
    inlineRootZoom: document.documentElement.style.zoom,
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    scrollY: window.scrollY,
  }));
}

async function layout(label, screenshot = false) {
  await settled();
  const observed = await metrics();
  const horizontalOverflow =
    Math.max(observed.documentWidth, observed.bodyWidth) - observed.innerWidth;
  report.layouts.push({
    label,
    route: new URL(page.url()).pathname + new URL(page.url()).search,
    ...observed,
    horizontalOverflow,
  });
  requireCondition(horizontalOverflow <= 1, 'PAGE_HORIZONTAL_OVERFLOW:' + label);
  if (screenshot) {
    const file = join(artifactDirectory, tag + '-' + label + '.png');
    requireCondition(
      await page
        .locator(
          'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]',
        )
        .evaluateAll((fields) => fields.every((field) => field.value.length === 0)),
      'SCREENSHOT_PASSWORD_FIELD_NOT_EMPTY:' + label,
    );
    await page.bringToFront();
    const { cssVisualViewport } = await cdp.send('Page.getLayoutMetrics');
    // Playwright's CSS-size clip crops native browser zoom screenshots. Capture
    // Chrome's entire visible surface without a clip or any device emulation.
    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const png = Buffer.from(capture.data, 'base64');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const expectedWidth = cssVisualViewport.clientWidth * observed.devicePixelRatio;
    const expectedHeight = cssVisualViewport.clientHeight * observed.devicePixelRatio;
    requireCondition(
      Math.abs(width - expectedWidth) <= 1 && Math.abs(height - expectedHeight) <= 1,
      'SCREENSHOT_SURFACE_SIZE_MISMATCH:' + label,
    );
    await writeFile(file, png, { flag: 'wx', mode: 0o600 });
    report.screenshots.push({
      label,
      path: relative(root, file),
      scrollY: observed.scrollY,
      method: 'CDP Page.captureScreenshot; fromSurface=true; captureBeyondViewport=false; no clip',
      width,
      height,
      cssViewportWidth: cssVisualViewport.clientWidth,
      cssViewportHeight: cssVisualViewport.clientHeight,
      browserZoom: cssVisualViewport.zoom,
      surfaceMatchesViewport: true,
      passwordFieldsEmpty: true,
    });
  }
}

async function visit(path, heading) {
  await page.goto(new URL(path, origin).toString());
  await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
  await settled();
}

async function theme(mode) {
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page
    .getByRole('menuitemradio', { name: mode === 'dark' ? '深色' : '浅色', exact: true })
    .click();
  await expect
    .poll(() => page.locator('html').evaluate((element) => element.classList.contains('dark')))
    .toBe(mode === 'dark');
}

async function focusInDialog(dialog, label) {
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  const count = await dialog.evaluate(
    (element) =>
      Array.from(
        element.querySelectorAll('a[href],button,input,select,textarea,[tabindex="0"]'),
      ).filter((item) => item.getClientRects().length && !item.hasAttribute('disabled')).length,
  );
  const samples = [];
  for (let index = 0; index < Math.min(count + 2, 24); index++) {
    await page.keyboard.press('Tab');
    const sample = await dialog.evaluate((element) => {
      const active = document.activeElement;
      const box = active?.getBoundingClientRect();
      return {
        contained: element.contains(active),
        tag: active?.tagName ?? null,
        id: active?.id ?? null,
        visibleHorizontally: Boolean(box && box.left >= -1 && box.right <= window.innerWidth + 1),
      };
    });
    samples.push(sample);
    requireCondition(
      sample.contained && sample.visibleHorizontally,
      'DIALOG_FOCUS_ESCAPE:' + label,
    );
  }
  await page.keyboard.press('Shift+Tab');
  requireCondition(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    'DIALOG_REVERSE_FOCUS_ESCAPE:' + label,
  );
  report.focus.push({ label, controls: count, samples, reverseContained: true });
}

async function reachable(control, label) {
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await expect(control).toBeFocused();
  const visible = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, window.innerHeight);
    const hit = document.elementFromPoint((box.left + box.right) / 2, (top + bottom) / 2);
    return (
      box.left >= -1 &&
      box.right <= window.innerWidth + 1 &&
      bottom > top &&
      Boolean(hit && (element.contains(hit) || hit.contains(element)))
    );
  });
  requireCondition(visible, 'CONTROL_OBSCURED:' + label);
}

async function api(path, method = 'GET', data) {
  const session = await context.request.get(new URL('/api/auth/me', origin).toString());
  requireCondition(session.status() === 200, 'SESSION_UNAVAILABLE');
  const csrf = (await session.json()).data.csrfToken;
  const response = await context.request.fetch(new URL('/api' + path, origin).toString(), {
    method,
    headers: { Origin: origin.origin, 'X-CSRF-Token': csrf },
    ...(data === undefined ? {} : { data }),
  });
  requireCondition(response.ok(), 'API_' + method + '_' + response.status());
  return response.status() === 204 ? undefined : (await response.json()).data;
}

async function cleanup() {
  try {
    if (context) {
      for (const fixture of [...fixtures].reverse()) {
        try {
          const current = await context.request.get(
            new URL('/api/' + fixture.kind + '/' + fixture.id, origin).toString(),
          );
          if (current.status() !== 404) {
            requireCondition(current.ok(), 'CLEANUP_READ_FAILED');
            const resource = (await current.json()).data;
            requireCondition(resource.slug === tag, 'CLEANUP_OWNERSHIP_MISMATCH');
            await api(
              '/' + fixture.kind + '/' + fixture.id + '?revision=' + resource.revision,
              'DELETE',
            );
          }
          report.cleanup.resources.push({ kind: fixture.kind, removed: true });
        } catch {
          report.cleanup.resources.push({ kind: fixture.kind, removed: false });
        }
      }
      try {
        const session = await context.request.get(new URL('/api/auth/me', origin).toString());
        if (session.status() === 200) {
          const csrf = (await session.json()).data.csrfToken;
          const response = await context.request.post(
            new URL('/api/auth/logout', origin).toString(),
            {
              headers: { Origin: origin.origin, 'X-CSRF-Token': csrf },
            },
          );
          report.cleanup.logout = response.status() === 204;
        } else report.cleanup.logout = session.status() === 401;
        const denied = await context.request.get(new URL('/api/projects', origin).toString());
        report.cleanup.managementStatusAfterLogout = denied.status();
        requireCondition(denied.status() === 401, 'LOGOUT_NOT_REVOKED');
      } catch {
        report.cleanup.logout = false;
      }
      try {
        await context.clearCookies();
        report.cleanup.cookiesCleared = (await context.cookies()).length === 0;
      } finally {
        await context.close();
        report.cleanup.browserClosed = true;
      }
    }
  } finally {
    if (profile) {
      await rm(profile, { recursive: true, force: true });
      report.cleanup.profileRemoved = await lstat(profile).then(
        () => false,
        (error) => error.code === 'ENOENT',
      );
    }
  }
}

try {
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  const passwordFile = resolve(root, process.env.E2E_PASSWORD_FILE ?? '.secrets/admin-password');
  const passwordInfo = await lstat(passwordFile);
  requireCondition(
    passwordInfo.isFile() && passwordInfo.size <= 4096 && (passwordInfo.mode & 0o077) === 0,
    'UNSAFE_PASSWORD_FILE',
  );
  let password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  requireCondition(password.length >= 12 && password.length <= 256, 'INVALID_PASSWORD_FILE');
  profile = await mkdtemp(join(root, '.local/page-zoom-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: true,
    viewport: null,
    args: ['--window-size=1440,1000'],
  });
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(15_000);
  settings = await context.newPage();
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const version = await cdp.send('Browser.getVersion');
  report.environment.browser = version.product;

  await step('real-browser-zoom-100-to-200', async () => {
    await settings.goto('chrome://settings/appearance');
    const zoom = settings.locator('select#zoomLevel');
    await zoom.waitFor({ state: 'attached' });
    await zoom.selectOption('1');
    await expect(zoom).toHaveValue('1');
    await page.goto(new URL('/login', origin).toString());
    await expect(page.getByLabel('管理员账号', { exact: true })).toBeVisible();
    await layout('login-100-light', true);
    const baseline = await metrics();
    await zoom.selectOption('2');
    await expect(zoom).toHaveValue('2');
    await page.reload();
    await expect(page.getByLabel('管理员账号', { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        Math.round(((await metrics()).devicePixelRatio / baseline.devicePixelRatio) * 100),
      )
      .toBe(200);
    const enlarged = await metrics();
    requireCondition(
      Math.abs(enlarged.innerWidth * 2 - baseline.innerWidth) <= 2,
      'ZOOM_WIDTH_NOT_HALVED',
    );
    requireCondition(
      Math.abs(enlarged.outerWidth - baseline.outerWidth) <= 2,
      'WINDOW_SIZE_CHANGED',
    );
    requireCondition(
      enlarged.rootFontSize === baseline.rootFontSize &&
        enlarged.rootCssZoom === baseline.rootCssZoom &&
        enlarged.bodyCssZoom === baseline.bodyCssZoom,
      'CSS_SCALING_CHANGED',
    );
    requireCondition(
      enlarged.visualViewportScale === baseline.visualViewportScale,
      'PINCH_SCALE_CHANGED',
    );
    report.zoom = {
      baseline,
      enlarged,
      settingValue: '2',
      cssViewportRatio: enlarged.innerWidth / baseline.innerWidth,
      dprRatio: enlarged.devicePixelRatio / baseline.devicePixelRatio,
    };
    await layout('login-200-light', true);
  });

  await step('real-login-at-200', async () => {
    await reachable(page.getByLabel('管理员账号', { exact: true }), 'login-account');
    await page.getByLabel('管理员账号', { exact: true }).fill(process.env.E2E_USERNAME ?? 'admin');
    await page.getByLabel('密码', { exact: true }).fill(password);
    password = '';
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/auth/login' &&
          response.request().method() === 'POST',
      ),
      page.getByRole('button', { name: '登录工作台', exact: true }).click(),
    ]);
    report.loginStatus = response.status();
    requireCondition(
      response.status() === 200,
      response.status() === 429 ? 'LOGIN_RATE_LIMITED' : 'LOGIN_FAILED',
    );
    loggedIn = true;
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  });

  let project;
  await step('project-form-and-fixed-target-at-200', async () => {
    const cluster = await api('/clusters', 'POST', { name: '缩放验收目标 ' + runId, slug: tag });
    fixtures.push({ kind: 'clusters', id: cluster.id });
    await visit('/projects/new', '创建项目');
    await page.getByRole('radio', { name: new RegExp('缩放验收目标 ' + runId) }).check();
    await page.getByLabel('项目名称', { exact: true }).fill('页面缩放验收 ' + runId);
    await page.getByLabel('项目标识', { exact: true }).fill(tag);
    await page
      .getByLabel('描述', { exact: false })
      .fill('200% 浏览器页面缩放探针创建；结束后清理。');
    const submit = page.getByRole('button', { name: '创建项目', exact: true });
    await reachable(submit, 'create-project');
    await layout('project-form-200-light', true);
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/projects' &&
          response.request().method() === 'POST',
      ),
      submit.click(),
    ]);
    requireCondition(response.status() === 201, 'PROJECT_CREATION_FAILED');
    project = (await response.json()).data;
    fixtures.push({ kind: 'projects', id: project.id });
    requireCondition(project.clusterId === cluster.id, 'PROJECT_TARGET_MISMATCH');
    await expect(
      page.getByRole('heading', { name: project.name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('当前环境', { exact: true })).toHaveValue('production');
    await layout('project-context-200-light', true);
  });

  await step('light-and-dark-main-pages-at-200', async () => {
    const routes = [
      ['/projects', '我的项目', 'projects'],
      ['/projects/new', '创建项目', 'project-create'],
      ['/projects/' + project.id, project.name, 'project-overview'],
      ['/projects/' + project.id + '?tab=environments', project.name, 'project-environments'],
      ['/projects/' + project.id + '?tab=settings', project.name, 'project-settings'],
      ['/infrastructure', '基础设施', 'infrastructure'],
      ['/servers/new', '登记服务器', 'server-form'],
      ['/clusters/new', '登记集群', 'cluster-form'],
      ['/operations', '诊断任务', 'operations'],
      ['/settings', '设置与凭证', 'settings'],
    ];
    for (const mode of ['light', 'dark']) {
      await theme(mode);
      for (const [path, heading, label] of routes) {
        await visit(path, heading);
        await expect(page.getByRole('button', { name: '打开导航', exact: true })).toBeVisible();
        await layout(
          label + '-200-' + mode,
          ['projects', 'project-overview', 'settings'].includes(label),
        );
      }
    }
    await page.reload();
    await expect(page.locator('html')).toHaveClass('dark');
    report.themePersistedAfterReload = true;
  });

  await step('narrow-navigation-focus-and-route-at-200', async () => {
    const trigger = page.getByRole('button', { name: '打开导航', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: '工作台导航', exact: true });
    await focusInDialog(drawer, 'navigation');
    await layout('navigation-200-dark', true);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await drawer.getByRole('link', { name: '基础设施', exact: true }).click();
    await expect(page.getByRole('heading', { name: '基础设施', exact: true })).toBeVisible();
    await expect(drawer).toHaveCount(0);
  });

  await step('command-dialog-keyboard-and-focus-return-at-200', async () => {
    const trigger = page.getByRole('button', { name: '快速打开项目与资源', exact: true });
    await trigger.focus();
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: '快速打开', exact: true });
    await expect(page.getByRole('combobox', { name: '搜索资源或操作', exact: true })).toBeFocused();
    await focusInDialog(dialog, 'command-palette');
    await layout('command-dialog-200-dark', true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  await step('dirty-form-theme-dialog-and-focus-at-200', async () => {
    await visit('/servers/new', '登记服务器');
    const field = page.getByLabel('服务器名称', { exact: true });
    const draft = '缩放探针未保存草稿 ' + runId;
    await reachable(field, 'server-name');
    await field.fill(draft);
    await theme('light');
    await expect(field).toHaveValue(draft);
    await theme('dark');
    await expect(field).toHaveValue(draft);
    const leave = page.getByRole('link', { name: 'Ozz 项目工作台', exact: true });
    await leave.click();
    const dialog = page.getByRole('dialog', { name: '离开前保留当前编辑？', exact: true });
    await focusInDialog(dialog, 'unsaved-changes');
    await layout('unsaved-dialog-200-dark', true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(leave).toBeFocused();
    await expect(field).toHaveValue(draft);
    await leave.click();
    await dialog.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    report.unsavedDraftDiscardedExplicitly = true;
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    step: currentStep,
    code:
      error instanceof ProbeFailure
        ? error.code
        : error instanceof Error
          ? error.name
          : 'UNKNOWN_FAILURE',
  };
} finally {
  try {
    await cleanup();
  } catch {
    report.cleanup.error = 'CLEANUP_INCOMPLETE';
  }
  const cleaned =
    report.cleanup.resources.every((resource) => resource.removed) &&
    (!loggedIn || report.cleanup.logout) &&
    report.cleanup.cookiesCleared &&
    report.cleanup.browserClosed &&
    report.cleanup.profileRemoved;
  if (!cleaned) report.status = 'failed';
  report.completedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.completedAt) - Date.parse(report.startedAt);
  report.summary = {
    passedChecks: report.checks.filter((check) => check.status === 'passed').length,
    totalChecks: report.checks.length,
    layoutSamples: report.layouts.length,
    cleanupComplete: cleaned,
  };
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      status: report.status,
      report: relative(root, reportFile),
      ...report.summary,
    }),
  );
  if (report.status !== 'passed') process.exitCode = 1;
}
