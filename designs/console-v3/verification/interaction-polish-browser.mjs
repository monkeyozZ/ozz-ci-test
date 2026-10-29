import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const require = createRequire(root + '/apps/console/package.json');
const { chromium, expect } = require('@playwright/test');
const base = root + '/designs/console-v3';
const entry = (process.env.OZZ_PROTO_URL || pathToFileURL(base + '/index.html').href).split('#')[0];
const output = process.env.OZZ_PROTO_OUTPUT_DIR ? resolve(root, process.env.OZZ_PROTO_OUTPUT_DIR) : base + '/verification';
const entryUrl = new URL(entry);
const result = {
  scope: 'Full v3 prototype, P0/P1/P2 interaction polish; in-memory demonstration only',
  entry,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  consoleErrors: [],
  externalRequests: [],
  hashes: {},
  limitations: [
    'One isolated browser and page. No user Chrome profile, real API, deployment, SSH, DNS or database operations.',
    'Clipboard writeText is replaced by controlled promises before each page loads; the system clipboard is never used.',
    'Busy and log-race checks hold only the explicit 700ms slow-response demo timers, then release their original callbacks; all other timers run normally.',
    'Additional list rows and task output are explicit in-memory fixtures, not real backend results.',
    'This report does not replace the earlier 18-group v3 report or certify all 78 legacy scenarios.',
    'No real Chinese IME, assistive technology or long-running production log-stream claim.',
  ],
};
for (const file of ['index.html', 'app.js', 'styles.css', 'management.js', 'management.css']) {
  result.hashes[file] = createHash('sha256').update(readFileSync(base + '/' + file)).digest('hex');
}
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OZZ_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  args: ['--disable-background-networking'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  const controller = { mode: 'resolve', calls: [], pending: [] };
  const writeText = (text) => {
    controller.calls.push(text);
    if (controller.mode === 'reject') return Promise.reject(new DOMException('Controlled clipboard rejection', 'NotAllowedError'));
    if (controller.mode === 'pending') return new Promise((resolve, reject) => controller.pending.push({ resolve, reject }));
    return Promise.resolve();
  };
  writeText.__ozzPrototypeTest = true;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  window.__ozzClipboardTest = controller;

  // Hold the explicit slow-response demo callbacks across browser round trips.
  // Production code and unrelated timers retain their normal behavior.
  const schedule = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  const responses = {
    held: false,
    pending: new Map(),
    release() {
      this.held = false;
      const pending = [...this.pending];
      this.pending.clear();
      for (const [timer, { callback, args }] of pending) {
        cancel(timer);
        callback.apply(window, args);
      }
      return pending.length;
    },
  };
  window.setTimeout = (callback, delay, ...args) => {
    if (!responses.held || delay !== 700 || typeof callback !== 'function') return schedule(callback, delay, ...args);
    const timer = schedule(() => {}, 2147483647);
    responses.pending.set(timer, { callback, args });
    return timer;
  };
  window.clearTimeout = (timer) => { responses.pending.delete(timer); cancel(timer); };
  window.__ozzResponseTest = responses;
});
const page = await context.newPage();
page.setDefaultTimeout(6500);
page.on('dialog', (dialog) => dialog.accept());
page.on('pageerror', (error) => result.errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
page.on('request', (request) => {
  if (!/^https?:/.test(request.url())) return;
  if (entryUrl.protocol === 'file:' || new URL(request.url()).origin !== entryUrl.origin) result.externalRequests.push(request.url());
});
await page.route(/^https?:\/\//, async (route) => {
  if (entryUrl.protocol === 'file:' || new URL(route.request().url()).origin !== entryUrl.origin) await route.abort();
  else await route.continue();
});
const control = (action) => page.locator(`[data-action="${action}"]`);
const input = (bind) => page.locator(`[data-bind="${bind}"]`);
const mgInput = (name) => page.locator(`.dialog [name="${name}"]`);
const mgSubmit = (name) => page.locator(`form[data-mg-draft="${name}"] button[type="submit"]`).click();
const cancelConfirmation = () => page.locator('.dialog .modal-actions [data-action="close-modal"]').click();
const blog = (tab = 'status', service = 'blog-web') => `#/project/blog/service/${service}?env=blog-production&tab=${tab}`;
async function reset(hash = '#/projects') {
  await page.goto(entry + hash);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.OzzPrototype && window.OzzManagement));
  assert.equal(await page.evaluate(() => navigator.clipboard.writeText.__ozzPrototypeTest), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
async function scenario(value) {
  await control('demo-options').click();
  await page.locator(`input[data-action="demo-scenario"][value="${value}"]`).check();
  await page.locator('.dialog .dialog-close').click();
}
async function holdResponses() {
  await page.evaluate(() => { window.__ozzResponseTest.held = true; });
}
async function releaseResponses() {
  const released = await page.evaluate(() => window.__ozzResponseTest.release());
  assert.ok(released > 0, 'A slow-response callback must be pending before release');
}
async function sourceImage() {
  await control('add-service').click();
  await page.locator('[data-action="choose-source"][data-source="image"]').click();
  await input('create.image').fill('nginx:1.28.3-alpine3.23');
  await input('create.port').fill('80');
}
async function check(name, run) {
  try {
    const details = await run();
    result.checks.push({ name, status: 'passed', details });
    console.log('PASS ' + name);
  } catch (error) {
    result.checks.push({ name, status: 'failed', error: String(error.stack || error) });
    console.log('FAIL ' + name + ': ' + error.message);
  }
}

try {
  await check('project query, browser history and list return position', async () => {
    await reset();
    await page.evaluate(() => {
      const state = window.OzzPrototype.state;
      for (let i = 0; i < 36; i++) {
        const id = 'polish-project-' + i;
        state.projects.push({ id, name: 'Polish 项目 ' + i, slug: id, description: '', targetId: 'cluster-tokyo', clusterId: 'cluster-tokyo', revision: 1, environments: [{ id: id + '-production', name: '生产', slug: 'production' }], lastEnvironmentId: id + '-production', services: [] });
      }
      window.OzzPrototype.render();
    });
    await control('project-search').fill('polish');
    await expect(page).toHaveURL(/#\/projects\?q=polish$/);
    await page.evaluate(() => window.scrollTo({ top: 700 }));
    const top = await page.evaluate(() => window.scrollY);
    assert.ok(top > 500);
    await page.locator('a.project-list-row[href*="polish-project-12?"]').click();
    await expect(page).toHaveURL(/#\/project\/polish-project-12\?/);
    await page.goBack();
    await expect(control('project-search')).toHaveValue('polish');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(top, 0);
    await page.goForward();
    await expect(page).toHaveURL(/#\/project\/polish-project-12\?/);
    await page.locator('.back-projects').click();
    await expect(control('project-search')).toHaveValue('polish');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(top, 0);
    await page.reload();
    await expect(control('project-search')).toHaveValue('polish');
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.projects.some((item) => item.id === 'polish-project-12')), false);
    return { queryRestored: true, scrollTop: top, browserBackForward: true, refreshKeepsQueryButResetsDemoRecords: true };
  });

  await check('creation focus and explicit discard start a fresh creation session', async () => {
    await reset(blog());
    await control('add-service').click();
    await expect(page.locator('[data-action="choose-source"][data-source="git"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(input('create.image')).toBeFocused();
    await input('create.image').fill('nginx:1.28.3-alpine3.23');
    await input('create.port').fill('80');
    await control('source-review-submit').click();
    await expect(page.locator('#creation-step-title')).toBeFocused();
    const savedId = await page.evaluate(() => window.OzzPrototype.state.modal.draft.createdServiceId);
    await control('source-config').click();
    await input('create.port').fill('8081');
    await page.locator('.dialog .dialog-close').click();
    await expect(page.locator('.dialog')).toContainText('放弃未保存的输入');
    await page.locator('.dialog .modal-actions [data-action="close-modal"]').click();
    await expect(input('create.port')).toHaveValue('8081');
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.modal.draft.createdServiceId), savedId);
    await page.locator('.dialog .dialog-close').click();
    await control('confirm-submit').click();
    await expect(control('add-service')).toBeFocused();
    await control('add-service').click();
    await expect(page.locator('[data-action="choose-source"]')).toHaveCount(4);
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.modal.draft.createdServiceId), null);
    assert.equal(await page.evaluate((id) => window.OzzPrototype.api.findService(id).service.draft.port, savedId), '80');
    // Pick another field in the same event-loop turn as source selection, before
    // the scheduled initial-focus frame can run. A late frame must not steal it.
    await page.evaluate(() => {
      document.querySelector('[data-action="choose-source"][data-source="image"]').click();
      document.querySelector('[data-bind="create.port"]').focus();
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(input('create.port')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('8089');
    await expect(input('create.port')).toHaveValue('8089');
    await expect(input('create.image')).toHaveValue('');
    return { firstSourceAndFirstField: true, reviewHeading: true, cancellationKeepsInputs: true, closedCreationStartsFresh: true, rapidFieldSelectionKeepsFocus: true, savedServiceRetained: savedId };
  });

  await check('same-service tab navigation retains unsaved editor', async () => {
    await reset(blog('settings'));
    await input('config.name').fill('本地草稿名称');
    await page.locator('.service-tabs a[href$="tab=variables"]').click();
    await expect(page.locator('.dialog')).toHaveCount(0);
    await page.locator('.service-tabs a[href$="tab=settings"]').click();
    await expect(input('config.name')).toHaveValue('本地草稿名称');
    assert.equal(await page.evaluate(() => window.OzzPrototype.context().service.draft.name), 'web');
    return { editorPreserved: true, publishedAndSavedNameUnchanged: true };
  });

  await check('slow project creation blocks duplicate and alternate navigation', async () => {
    await reset('#/projects/new');
    await scenario('slow-response');
    await holdResponses();
    await input('project.name').fill('Polish 慢响应项目');
    await control('submit-project').click();
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true');
    await expect(input('project.name')).toBeDisabled();
    await page.keyboard.press('Control+k');
    await expect(page.locator('.dialog')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page).toHaveURL(/#\/projects\/new$/);
    await page.locator('form[data-form="create-project"]').evaluate((form) => form.requestSubmit());
    await releaseResponses();
    await page.waitForFunction(() => window.OzzPrototype.state.modal?.type === 'source');
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.projects.filter((item) => item.name === 'Polish 慢响应项目').length), 1);
    return { busyVisible: true, unknownNavigationBlocked: true, createdOnce: true };
  });

  await check('slow save and confirmation retain owner until accepted', async () => {
    await reset(blog());
    await scenario('slow-response');
    await sourceImage();
    await holdResponses();
    await control('source-review-submit').click();
    await expect(page.locator('.dialog')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.dialog .dialog-close')).toBeDisabled();
    await page.keyboard.press('Escape');
    await releaseResponses();
    await page.waitForFunction(() => window.OzzPrototype.state.modal?.step === 'review');
    await expect(page.locator('#creation-step-title')).toBeFocused();
    await control('create-draft').click();

    await reset(blog());
    await scenario('slow-response');
    await page.locator('.more-menu summary').click();
    await control('service-stop').click();
    const before = await page.evaluate(() => window.OzzPrototype.state.tasks.length);
    await holdResponses();
    await control('confirm-submit').click();
    await expect(page.locator('.dialog')).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Escape');
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.dialog')).toHaveCount(1);
    await page.locator('form[data-form="confirm"]').evaluate((form) => form.requestSubmit());
    await releaseResponses();
    await page.waitForFunction((count) => window.OzzPrototype.state.tasks.length === count + 1, before);
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.tasks.filter((item) => item.type === 'stop').length), 1);
    return { saveLocksClose: true, confirmationLocksEscapeAndOverlay: true, acceptedTaskOnce: true };
  });

  await check('unknown service save stays attached to original result', async () => {
    await reset(blog());
    await scenario('offline');
    await sourceImage();
    await control('source-review-submit').click();
    const id = await page.evaluate(() => window.OzzPrototype.state.modal.draft.createdServiceId);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.evaluate(() => { location.hash = '#/servers'; });
    await page.waitForFunction(() => window.OzzPrototype.state.modal?.step === 'save-unknown');
    await control('source-confirm-saved').click();
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.modal.draft.createdServiceId), id);
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.tasks.some((item) => item.serviceId === window.OzzPrototype.state.modal.draft.createdServiceId)), false);
    return { originalId: id, noNewServiceOrDeploymentOnConfirmation: true };
  });

  await check('clipboard promises stay local and copy only visible results', async () => {
    await reset(blog());
    await control('open-logs').click();
    await control('log-follow').click();
    await page.locator('[data-log="query"]').fill('cache');
    await page.evaluate(() => { window.__ozzClipboardTest.mode = 'pending'; });
    await control('log-copy').click();
    await expect(control('log-copy')).toBeDisabled();
    await expect(control('log-copy')).toContainText('正在复制');
    await control('log-copy').evaluate((button) => button.click());
    await page.evaluate(() => { window.OzzPrototype.state.logViews['blog-web'].buffer.push('[演示] INFO cache appended while copying'); window.OzzPrototype.render(); });
    assert.equal(await page.evaluate(() => window.__ozzClipboardTest.calls.length), 1);
    assert.match(await page.evaluate(() => window.__ozzClipboardTest.calls[0]), /cache miss/);
    assert.doesNotMatch(await page.evaluate(() => window.__ozzClipboardTest.calls[0]), /listening/);
    await page.evaluate(() => window.__ozzClipboardTest.pending.shift().resolve());
    await expect(control('log-copy')).toContainText('已复制');
    await page.evaluate(() => { window.OzzPrototype.state.logViews['blog-web'].buffer.push('[演示] INFO cache appended after copying'); window.OzzPrototype.render(); });
    await expect(control('log-copy')).toContainText('已复制');
    await page.evaluate(() => { window.__ozzClipboardTest.mode = 'reject'; });
    await control('log-copy').click();
    await expect(page.locator('.copy-feedback')).toContainText('复制失败');
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.modal.type), 'logs');
    await expect(page.locator('.dialog')).toHaveCount(1);

    await page.evaluate(() => { window.__ozzClipboardTest.mode = 'pending'; });
    await control('log-copy').click();
    await page.locator('[data-log="query"]').fill('health');
    await expect(control('log-copy')).toBeDisabled();
    await page.evaluate(() => window.__ozzClipboardTest.pending.shift().resolve());
    await expect(control('log-copy')).not.toContainText('已复制');
    await expect(control('log-copy')).toBeEnabled();
    await page.locator('[data-log="query"]').fill('no-such-output');
    await expect(control('log-copy')).toBeDisabled();
    return { controlledPromisesOnly: true, duplicateSuppressed: true, appendedOutputKeepsClickedSnapshotFeedback: true, scopeChangeDoesNotClaimCopied: true, noReplacementDialog: true };
  });

  await check('log reconnect keeps old buffer and target changes discard old reads', async () => {
    await reset(blog());
    await control('open-logs').click();
    await control('log-follow').click();
    const previous = await page.locator('.log-output').innerText();
    await page.locator('.dialog .dialog-close').click();
    await scenario('offline');
    await control('open-logs').click();
    await control('log-refresh').click();
    assert.equal(await page.locator('.log-output').innerText(), previous);
    await expect(page.locator('.log-modal-body')).toContainText('连接中断');
    await page.evaluate(() => { window.OzzPrototype.state.scenario = 'slow-response'; });
    await holdResponses();
    await control('log-refresh').click();
    await expect(page.locator('.log-dialog-header')).toContainText('连接中');
    assert.equal(await page.locator('.log-output').innerText(), previous);
    await releaseResponses();
    await page.waitForFunction(() => window.OzzPrototype.state.logViews['blog-web'].connection === 'ended');
    await holdResponses();
    await page.locator('[data-log="container"]').selectOption('init');
    await expect(page.locator('.log-output .log-line')).toHaveCount(0);
    await page.locator('[data-log="container"]').selectOption('main');
    assert.equal(await page.evaluate(() => window.__ozzResponseTest.pending.size), 1);
    await releaseResponses();
    await page.waitForFunction(() => window.OzzPrototype.state.logViews['blog-web'].connection === 'ended');
    assert.doesNotMatch(await page.locator('.log-output').innerText(), /\[init\]/);
    const beforeEmptyRead = await page.locator('.log-output').innerText();
    await holdResponses();
    await control('log-refresh').click();
    await page.evaluate(() => { window.OzzPrototype.state.scenario = 'empty'; window.OzzPrototype.render(); });
    assert.equal(await page.locator('.log-output').innerText(), beforeEmptyRead);
    await releaseResponses();
    await page.waitForFunction(() => window.OzzPrototype.state.logViews['blog-web'].connection === 'ended');
    await expect(page.locator('.log-output .log-line')).toHaveCount(0);
    await page.evaluate(() => { window.OzzPrototype.state.scenario = 'slow-response'; });
    await holdResponses();
    await control('log-refresh').click();
    await page.locator('.dialog .dialog-close').click();
    await expect(control('open-logs')).toBeFocused();
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.logViews['blog-web'].timer), null);
    assert.equal(await page.evaluate(() => window.__ozzResponseTest.pending.size), 0);
    return { failedReadPreservesBuffer: true, pendingVisible: true, changedSourceClearsBuffer: true, emptyResultAppliedAfterRead: true, closedReadCancelled: true };
  });

  await check('task output search, copy and reading position are scoped to loaded lines', async () => {
    await reset(blog('status', 'blog-api'));
    await page.evaluate(() => {
      const task = window.OzzPrototype.state.tasks.find((item) => item.id === 'deploy-api-4');
      task.logs = Array.from({ length: 160 }, (_, index) => `[演示] INFO record-${index}`);
    });
    await page.locator('[data-action="task-detail"][data-id="deploy-api-4"]').first().click();
    await page.locator('#task-log-query').fill('record-11');
    await control('task-log-copy').click();
    assert.doesNotMatch(await page.evaluate(() => window.__ozzClipboardTest.calls[0]), /record-20\b/);
    await page.locator('#task-log-query').fill('');
    await page.locator('.task-log-output').evaluate((element) => { element.scrollTop = 0; });
    await page.waitForFunction(() => window.OzzPrototype.state.taskLogViews['deploy-api-4'].paused);
    await page.evaluate(() => { window.OzzPrototype.state.tasks.find((item) => item.id === 'deploy-api-4').logs.push('[演示] INFO last-record'); window.OzzPrototype.render(); });
    assert.equal(await page.locator('.task-log-output').evaluate((element) => element.scrollTop), 0);
    await expect(control('task-log-bottom')).toContainText('1 条新输出');
    await control('task-log-bottom').click();
    await expect.poll(() => page.locator('.task-log-output').evaluate((element) => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThan(2);
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.tasks.find((item) => item.id === 'deploy-api-4').stages.length), 4);
    return { localOutputFixture: true, searchAndCopy: true, appendedLineDoesNotInterruptReading: true, existingStagesUnchanged: true };
  });

  await check('narrow log controls and reduced-motion creation focus', async () => {
    await reset(blog());
    const layouts = [];
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await control('open-logs').click();
      await page.evaluate(() => { window.__ozzClipboardTest.mode = 'reject'; });
      await control('log-copy').click();
      await expect(page.locator('.copy-feedback')).toBeVisible();
      const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      assert.ok(width.scroll <= width.viewport + 1);
      layouts.push({ theme, ...width });
      await page.locator('.dialog .dialog-close').click();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await control('add-service').click();
    await expect(page.locator('[data-action="choose-source"][data-source="git"]')).toBeFocused();
    assert.equal(await page.locator('.dialog').evaluate((element) => getComputedStyle(element).animationDuration), '0s');
    await page.keyboard.press('Escape');
    await expect(control('add-service')).toBeFocused();
    return { layouts, reducedMotion: true, normalKeyboardFocus: true };
  });

  await check('credential type confirmation and close preserve only the current unsaved inputs', async () => {
    await reset('#/settings?tab=credentials');
    await control('mg:credential-new').click();
    await expect(mgInput('name')).toBeFocused();
    await mgInput('name').fill('Polish 临时凭证');
    await mgInput('expiresAt').fill('2099-12-31');
    await mgInput('privateKey').fill('prototype-only-private-input');
    await mgInput('passphrase').fill('prototype-only-passphrase');
    await control('mg:credential-visibility').click();
    await expect(mgInput('privateKey')).not.toHaveClass(/mg-secret-mask/);
    await mgInput('kind').selectOption('builder');
    await expect(page.locator('.dialog')).toContainText('切换凭证类型？');
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.OzzPrototype.state)), /prototype-only-private-input|prototype-only-passphrase/);
    await page.keyboard.press('ArrowDown');
    await cancelConfirmation();
    await expect(mgInput('kind')).toHaveValue('ssh');
    await expect(mgInput('privateKey')).toHaveValue('prototype-only-private-input');
    await expect(mgInput('passphrase')).toHaveValue('prototype-only-passphrase');
    await expect(mgInput('privateKey')).not.toHaveClass(/mg-secret-mask/);
    await mgInput('kind').selectOption('builder');
    await control('confirm-submit').click();
    await expect(mgInput('kind')).toHaveValue('builder');
    await expect(mgInput('name')).toHaveValue('Polish 临时凭证');
    await expect(mgInput('expiresAt')).toHaveValue('2099-12-31');
    for (const name of ['ca', 'certificate', 'privateKey']) {
      await expect(mgInput(name)).toHaveValue('');
      await expect(mgInput(name)).toHaveClass(/mg-secret-mask/);
      await mgInput(name).fill('prototype-only-' + name);
    }
    await mgInput('kind').selectOption('registry');
    await control('confirm-submit').click();
    await expect(mgInput('username')).toHaveValue('');
    await expect(mgInput('secret')).toHaveValue('');
    await expect(mgInput('secret')).toHaveAttribute('type', 'password');
    await mgInput('username').fill('demo-user');
    await mgInput('kind').selectOption('generic');
    await expect(page.locator('.dialog')).toContainText('切换凭证类型？');
    await cancelConfirmation();
    await expect(mgInput('username')).toHaveValue('demo-user');
    await page.locator('.dialog .dialog-close').click();
    await expect(page.locator('.dialog')).toContainText('放弃凭证输入？');
    await cancelConfirmation();
    await expect(mgInput('username')).toHaveValue('demo-user');
    await control('mg:close').click();
    await control('confirm-submit').click();
    await expect(control('mg:credential-new')).toBeFocused();
    await control('mg:credential-new').click();
    await expect(mgInput('name')).toHaveValue('');
    await expect(mgInput('privateKey')).toHaveValue('');
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.OzzPrototype.state)), /prototype-only-/);
    return { cancelledTypeAndCloseKeepInputs: true, confirmedTypeClearsAllSpecificFields: true, metadataKept: true, secretsExcludedFromState: true, closedSessionStartsEmpty: true };
  });

  await check('slow credential and cluster saves retain inputs and accept one record', async () => {
    await reset('#/settings?tab=credentials');
    await scenario('slow-response');
    await control('mg:credential-new').click();
    await mgInput('kind').selectOption('generic');
    await mgInput('name').fill('Polish 慢保存凭证');
    await mgInput('secret').fill('prototype-only-pending-input');
    await holdResponses();
    await mgSubmit('credential-save');
    await expect(page.locator('.dialog')).toHaveAttribute('aria-busy', 'true');
    await expect(mgInput('secret')).toHaveValue('prototype-only-pending-input');
    await expect(page.locator('.dialog .dialog-close')).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.locator('form[data-mg-draft="credential-save"]').evaluate((form) => form.requestSubmit());
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.credentials.filter((item) => item.name === 'Polish 慢保存凭证').length), 0);
    await releaseResponses();
    await expect(control('mg:credential-new')).toBeFocused();
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.credentials.filter((item) => item.name === 'Polish 慢保存凭证').length), 1);
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.OzzPrototype.state)), /prototype-only-pending-input/);

    await reset('#/servers?tab=clusters');
    await control('mg:cluster-new').click();
    await mgInput('name').fill('尚未保存的集群');
    await control('mg:close').click();
    await expect(page.locator('.dialog')).toContainText('放弃新集群资料？');
    await cancelConfirmation();
    await expect(mgInput('name')).toHaveValue('尚未保存的集群');
    await control('mg:close').click();
    await control('confirm-submit').click();
    await expect(control('mg:cluster-new')).toBeFocused();
    await scenario('slow-response');
    await control('mg:cluster-new').click();
    await mgInput('name').fill('Polish 慢保存集群');
    await holdResponses();
    await mgSubmit('cluster-save');
    await expect(page.locator('.dialog')).toContainText('正在保存集群登记');
    await page.locator('form[data-mg-draft="cluster-save"]').evaluate((form) => form.requestSubmit());
    await releaseResponses();
    await expect(page).toHaveURL(/#\/cluster\/[^?]+\?tab=connection$/);
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.clusters.filter((item) => item.name === 'Polish 慢保存集群').length), 1);
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.clusters.find((item) => item.name === 'Polish 慢保存集群').status), 'unverified');
    return { pendingRawInputRetained: true, duplicateSuppressed: true, credentialTriggerRestored: true, clusterCloseReturnsToTrigger: true, newClusterStaysUnverified: true };
  });

  await check('infrastructure and DNS requests separate acceptance from task completion', async () => {
    const outcomes = [];
    for (const item of [
      { hash: '#/server/server-tokyo?tab=preflight', action: 'fingerprint-discover', text: '正在受理指纹读取', type: 'ssh-fingerprint' },
      { hash: '#/server/server-tokyo?tab=preflight', action: 'server-preflight', text: '正在受理预检', type: 'ssh-preflight' },
      { hash: '#/cluster/cluster-tokyo?tab=connection', action: 'cluster-check', text: '正在受理同步', type: 'cluster-check' },
      { hash: '#/domain/dom-web', action: 'domain-check', text: '正在提交检查', type: 'domain-check' },
    ]) {
      await reset(item.hash);
      await scenario('slow-response');
      const before = await page.evaluate(() => window.OzzPrototype.state.tasks.length);
      await holdResponses();
      await control('mg:' + item.action).click();
      await expect(control('mg:' + item.action)).toContainText(item.text);
      await expect(control('mg:' + item.action)).toBeDisabled();
      await control('mg:' + item.action).evaluate((button) => button.click());
      await page.evaluate(() => window.OzzPrototype.api.goto('#/projects'));
      assert.equal(await page.evaluate(() => location.hash), item.hash);
      const accepted = await page.evaluate(() => {
        const released = window.__ozzResponseTest.release();
        const tasks = window.OzzPrototype.state.tasks;
        return { released, count: tasks.length, id: tasks[0].id, type: tasks[0].type, status: tasks[0].status, stages: tasks[0].stages.length };
      });
      assert.equal(accepted.released, 1);
      assert.equal(accepted.count, before + 1);
      assert.equal(accepted.status, 'queued');
      assert.equal(accepted.type, item.type);
      assert.equal(accepted.stages, 3);
      outcomes.push(accepted);
    }
    await reset('#/server/server-tokyo?tab=preflight');
    await scenario('slow-response');
    await page.evaluate(() => { window.OzzPrototype.state.servers[0].fingerprintConfirmed = false; window.OzzPrototype.render(); });
    await control('mg:fingerprint-confirm').click();
    await holdResponses();
    await control('confirm-submit').click();
    await expect(control('confirm-submit')).toContainText('正在保存可信指纹');
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.servers[0].fingerprintConfirmed), false);
    await releaseResponses();
    assert.equal(await page.evaluate(() => window.OzzPrototype.state.servers[0].fingerprintConfirmed), true);
    return { outcomes, acceptanceSnapshotTakenBeforeExistingTaskTimersRun: true, trustHasOwnSaveFeedback: true, existingDemoStagesUnchanged: true };
  });

  await check('DNS and database copies use present raw values and keep narrow layouts usable', async () => {
    await reset('#/domain/dom-web');
    const cname = 'upstream-' + 'a'.repeat(50) + '.edge.example.test';
    await page.evaluate((value) => {
      const domain = window.OzzPrototype.state.domains[0];
      Object.assign(domain, { expectedAddresses: ['192.0.2.10', '2001:db8::5'], expectedCname: value, addresses: ['192.0.2.10'], cnameChain: ['edge.example.test', 'origin.example.test'] });
      window.OzzPrototype.render();
    }, cname);
    await page.getByRole('button', { name: '复制预期地址 2', exact: true }).click();
    await page.getByRole('button', { name: '复制预期 CNAME', exact: true }).click();
    await page.getByRole('button', { name: '复制CNAME 链 2', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__ozzClipboardTest.calls), ['2001:db8::5', cname, 'origin.example.test']);
    await page.evaluate(() => { window.__ozzClipboardTest.mode = 'reject'; });
    await page.getByRole('button', { name: '复制DNS 目标', exact: true }).click();
    await expect(page.locator('.copy-feedback')).toContainText('复制失败');
    await expect(page.locator('.dialog')).toHaveCount(0);
    const layouts = [];
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      assert.ok(width.scroll <= width.viewport + 1);
      layouts.push({ theme, ...width });
    }
    await reset('#/database/db-postgres');
    const database = await page.evaluate(() => window.OzzPrototype.state.databases[0]);
    for (const name of ['复制Host', '复制Port', '复制数据库', '复制用户名']) await page.getByRole('button', { name, exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__ozzClipboardTest.calls), [database.host, String(database.port), database.databaseName, database.username]);
    await page.evaluate(() => {
      const state = window.OzzPrototype.state;
      state.databases.push({ ...state.databases[0], id: 'polish-redis', name: 'Redis 演示空端点', kind: 'redis', engine: 'Redis', redisDatabase: 0, databaseName: null, host: null, username: 'default', port: 6379, serviceId: null, volumeId: null, identity: null, consumers: [] });
      window.OzzPrototype.api.goto('#/database/polish-redis');
    });
    await expect(page.getByRole('button', { name: '复制Host', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '复制数据库', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__ozzClipboardTest.calls.at(-1)), '0');
    return { rawDnsValuesOnly: true, rawDatabaseFieldsOnly: true, missingHostHasNoCopy: true, redisZeroIsPreserved: true, controlledClipboardOnly: true, layouts };
  });

  await check('resource list filters survive detail tabs, refresh and safe return links', async () => {
    const paths = [];
    for (const item of [
      { list: '#/servers?q=Tokyo&status=ready', detail: '#/server/server-tokyo', back: '服务器列表', tab: '连接与接入' },
      { list: '#/servers?tab=clusters&q=Tokyo&status=ready', detail: '#/cluster/cluster-tokyo', back: '集群列表', tab: '连接与能力' },
      { list: '#/resources?type=volumes&q=archive&project=blog&env=blog-production', detail: '#/volume/vol-archive', back: '数据卷列表', tab: '手工备份 / 恢复' },
      { list: '#/resources?type=databases&q=postgres&project=blog&env=blog-production', detail: '#/database/db-postgres', back: '数据库列表' },
    ]) {
      await reset(item.list);
      await page.locator(`main .mg-table a[href^="${item.detail}?"]`).first().click();
      await expect(page).toHaveURL(/list=/);
      await page.goBack();
      await expect(page.locator('#mg-filter-search')).toHaveValue(new URLSearchParams(item.list.split('?')[1]).get('q'));
      await page.goForward();
      if (item.tab) await page.getByRole('link', { name: item.tab, exact: true }).click();
      if (/^#\/(server|cluster)\//.test(item.detail)) {
        await page.locator('.mg-tabs').getByRole('link', { name: '设置', exact: true }).click();
        const name = item.detail.startsWith('#/server/') ? 'server-save' : 'cluster-save';
        const form = page.locator(`form[data-mg-draft="${name}"]`);
        if (name === 'server-save') {
          const validity = await form.locator('[name="address"]').evaluate((field) => {
            const original = field.value;
            const cases = ['node-01.example.test', '192.0.2.10', '2001:db8::5', 'invalid host', 'https://example.test'];
            try { return cases.map((value) => { field.value = value; return field.checkValidity(); }); }
            finally { field.value = original; }
          });
          assert.deepEqual(validity, [true, true, true, false, false]);
        }
        const field = form.locator('[name="name"]');
        await field.fill((await field.inputValue()) + ' · 已更新');
        await form.locator('button[type="submit"]').click();
        assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('list')), item.list);
        await expect(page.getByRole('link', { name: item.back, exact: true })).toHaveAttribute('href', item.list);
      }
      await page.reload();
      if (item.detail.includes('/database/')) await expect(page.locator('main a[href="#/volume/vol-postgres"]').first()).toBeVisible();
      await expect(page.getByRole('link', { name: item.back, exact: true })).toHaveAttribute('href', item.list);
      await page.getByRole('link', { name: item.back, exact: true }).click();
      assert.equal(await page.evaluate(() => location.hash), item.list);
      paths.push(item.list);
    }
    const fallback = '#/resources?type=databases&project=blog&env=blog-production';
    for (const invalid of ['https://example.test/resources?type=databases', '#/resources?type=volumes&q=x', '#/resources?type=databases&q=a&q=b']) {
      await reset('#/database/db-postgres?list=' + encodeURIComponent(invalid));
      await expect(page.getByRole('link', { name: '数据库列表', exact: true })).toHaveAttribute('href', fallback);
    }
    await reset('#/database/db-postgres?list=' + encodeURIComponent('#/resources?type=databases&q=post&ignored=value#discard'));
    await expect(page.getByRole('link', { name: '数据库列表', exact: true })).toHaveAttribute('href', '#/resources?type=databases&q=post');
    return { paths, browserHistory: true, existingServerAndClusterSaveKeepsList: true, refresh: true, unrelatedResourceLinksDoNotInheritList: true, invalidReturnTargetsRejected: true, unknownKeysAndHashDiscarded: true };
  });

  await check('standalone operation output keeps reading position and does not invent stages', async () => {
    await reset('#/activity?tab=operations');
    await page.evaluate(() => {
      const state = window.OzzPrototype.state;
      state.tasks.unshift({ id: 'polish-operation', kind: 'operation', type: 'cluster-check', name: '集群诊断输出演示', targetId: 'cluster-tokyo', status: 'running', createdAt: new Date().toISOString(), snapshot: {}, logs: Array.from({ length: 160 }, (_, index) => `[演示] INFO record-${index}`) });
      state.tasks.unshift({ id: 'polish-operation-next', kind: 'operation', type: 'cluster-check', name: '另一条诊断', targetId: 'cluster-tokyo', status: 'succeeded', createdAt: new Date().toISOString(), snapshot: {}, logs: ['[演示] unrelated task output'] });
      window.OzzPrototype.api.goto('#/task/polish-operation');
    });
    await expect(page.locator('.mg-timeline li')).toHaveCount(0);
    await page.locator('#task-log-query').fill('record-11');
    await page.evaluate(() => { window.__ozzClipboardTest.mode = 'pending'; });
    await control('task-log-copy').click();
    await page.evaluate(() => { window.OzzPrototype.state.tasks.find((task) => task.id === 'polish-operation').logs.push('[演示] INFO record-11-later'); window.OzzPrototype.render(); });
    await expect(control('task-log-copy')).toBeDisabled();
    assert.doesNotMatch(await page.evaluate(() => window.__ozzClipboardTest.calls[0]), /record-20\b|record-11-later/);
    await page.evaluate(() => window.__ozzClipboardTest.pending.shift().resolve());
    await expect(control('task-log-copy')).toContainText('已复制');
    await page.locator('#task-log-query').fill('');
    await page.locator('.task-log-output').focus();
    await page.keyboard.press('Home');
    await expect.poll(() => page.locator('.task-log-output').evaluate((element) => element.scrollTop)).toBe(0);
    await page.evaluate(() => { window.OzzPrototype.state.tasks.find((task) => task.id === 'polish-operation').logs.push('[演示] INFO arriving while reading'); window.OzzPrototype.render(); });
    await expect(control('task-log-bottom')).toContainText('1 条新输出');
    assert.equal(await page.locator('.task-log-output').evaluate((element) => element.scrollTop), 0);
    await control('task-log-bottom').click();
    await expect.poll(() => page.locator('.task-log-output').evaluate((element) => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThan(2);
    await page.evaluate(() => window.OzzPrototype.api.goto('#/task/polish-operation-next'));
    await expect(page.locator('#task-log-query')).toHaveValue('');
    await expect(page.locator('.task-log-output')).toContainText('unrelated task output');
    await expect(page.locator('.task-log-output')).not.toContainText('record-');
    await expect(page.locator('.mg-timeline li')).toHaveCount(0);
    return { localFixtureOnly: true, searchAndSnapshotCopy: true, homePausesScrolling: true, unreadAndReturnToLatest: true, differentTaskHasItsOwnOutput: true, operationStagesNotAdded: true };
  });
} finally {
  result.finishedAt = new Date().toISOString();
  result.summary = {
    total: result.checks.length,
    passed: result.checks.filter((item) => item.status === 'passed').length,
    failed: result.checks.filter((item) => item.status === 'failed').length,
    scriptErrors: result.errors.length,
    consoleErrors: result.consoleErrors.length,
    externalRequests: result.externalRequests.length,
  };
  result.passed = result.summary.failed === 0 && result.summary.scriptErrors === 0 && result.summary.consoleErrors === 0 && result.summary.externalRequests === 0;
  writeFileSync(output + '/interaction-polish-results.json', JSON.stringify(result, null, 2) + '\n');
  await browser.close();
  if (!result.passed) process.exitCode = 1;
  console.log(JSON.stringify(result.summary));
}
