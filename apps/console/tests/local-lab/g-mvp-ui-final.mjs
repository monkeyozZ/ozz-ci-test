import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, statfs, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { readRealState, realOrigin, verifyRealEntryCertificate } from './s6-real-support.ts';

// Incremental, real local-product checks. No fixture responses, login requests, deployment
// creation, SSH, VM lifecycle operations, or modifications to the page's accessibility tree.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const mode = process.argv[2] ?? 'ui';
assert(['all', 'ui', 'voiceover', 'configuration'].includes(mode), 'Unsupported probe mode');
const wantsVoiceOver = mode === 'all' || mode === 'voiceover';
assert(
  !wantsVoiceOver || process.env.GMVP_RETRY_VOICEOVER === '1',
  'VoiceOver startup is unavailable on this host. Resolve that environment failure before setting GMVP_RETRY_VOICEOVER=1. See tests/artifacts/g-mvp-ui-final/README.md.',
);
assert(process.version === 'v24.22.1', 'Run this probe with pnpm exec node');
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const artifactDirectory = resolve(root, 'apps/console/tests/artifacts/g-mvp-ui-final', runId);
const lockPath = resolve(root, '.local/local-lab/g-mvp-ui-final.lock');
const sessionPath = resolve(
  root,
  '.local/local-lab/g-mvp-workload-faults/attempts/a988bc74-9664-49b4-b010-473505925925/auth-session.json',
);
const ids = {
  git: '7f089683-1eb7-40cb-bb98-e982b4be1c5b',
  oom: '81c34c92-48dd-4053-9716-0bcf9dc75a21',
  legacy: '75271808-e382-40b8-af7a-063bc9550136',
  equalConfigurationService: '76c45b45-a37d-45d0-8391-d1c002f683ee',
};
const exec = promisify(execFile);
const secrets = [];
const summary = {
  runId,
  mode,
  startedAt: new Date().toISOString(),
  origin: realOrigin,
  scope: 'Real local product increment and actual macOS VoiceOver; no infrastructure changes',
  productionSecureCookieVerified: false,
  checks: [],
  screenshots: [],
  requestAudit: { blockedWrites: [], blockedForeignRequests: [], apiFailures: [], pageErrors: 0 },
  voiceOver: { status: 'not_run', actualPhrases: [], assertions: [], restoration: {} },
  cleanup: {},
};
let lock;
let browser;
let browserPid;
let context;
let session;
let voiceOverStarted = false;
let originalPreference;
let preferenceChanged = false;
let originalForeground;
let afterIdentity;

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}
function safeText(value) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/ozz_session=[^\s;,]+/g, 'ozz_session=[redacted]');
}
function errorText(error) {
  return safeText(error?.message ?? error).slice(0, 1200);
}
async function checkpoint() {
  await writeFile(
    resolve(artifactDirectory, 'acceptance-summary.json'),
    safeText(JSON.stringify(summary, null, 2)) + '\n',
    { mode: 0o600 },
  );
}
async function diskFloor() {
  const disk = await statfs(root);
  const available = disk.bavail * disk.bsize;
  assert(available >= 8 * 1024 ** 3, 'Less than 8 GiB remains on the Mac');
  return available;
}
async function command(file, args) {
  const result = await exec(file, args, { timeout: 12_000, maxBuffer: 128 * 1024 });
  return result.stdout.trim();
}
async function jxa(source) {
  return command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source]);
}
async function foreground(pid) {
  const result = JSON.parse(
    await jxa(`ObjC.import('AppKit');
      ${pid ? `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!app) throw Error('OWN_APP_MISSING'); app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps); delay(0.2);` : ''}
      JSON.stringify({pid: Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)});`),
  );
  if (pid) assert.equal(result.pid, pid, 'Dedicated browser is not the foreground app');
  return result.pid;
}
async function voiceOverPids() {
  try {
    return (await command('/usr/bin/pgrep', ['-x', 'VoiceOver']))
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}
async function preference() {
  let type;
  try {
    type = await command('/usr/bin/defaults', [
      'read-type',
      'com.apple.VoiceOver4',
      'SCREnableAppleScript',
    ]);
  } catch (error) {
    if (error.code === 1 && /does not exist/.test(error.stderr ?? ''))
      return { exists: false, value: null };
    throw error;
  }
  assert(/boolean/i.test(type), 'The existing VoiceOver scripting preference is not boolean');
  const value = await command('/usr/bin/defaults', [
    'read',
    'com.apple.VoiceOver4',
    'SCREnableAppleScript',
  ]);
  assert(value === '0' || value === '1', 'The existing scripting preference is invalid');
  return { exists: true, value: value === '1' };
}
async function installRequestGuard(target) {
  await target.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== realOrigin) {
        summary.requestAudit.blockedForeignRequests.push({
          method: request.method(),
          origin: url.origin,
          path: url.pathname,
        });
        return route.abort('blockedbyclient');
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        summary.requestAudit.blockedWrites.push({ method: request.method(), path: url.pathname });
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });
  target.on('page', (page) => {
    page.on('pageerror', () => summary.requestAudit.pageErrors++);
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (
        url.pathname.startsWith('/api/') &&
        response.status() >= 400 &&
        !(url.pathname === '/api/auth/me' && response.status() === 401)
      )
        summary.requestAudit.apiFailures.push({ path: url.pathname, status: response.status() });
    });
  });
}
async function api(path) {
  assert(path.startsWith('/') && !path.startsWith('//'), 'Invalid API path');
  const response = await context.request.get(realOrigin + '/api' + path, { maxRedirects: 0 });
  assert.equal(response.status(), 200, `GET ${path.split('?')[0]} failed`);
  const body = await response.json();
  return body.data;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function reorderedObjectPaths(before, after, path = '$') {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  if (Array.isArray(before) && Array.isArray(after))
    return before.flatMap((value, index) =>
      reorderedObjectPaths(value, after[index], `${path}[${index}]`),
    );
  if (Array.isArray(before) || Array.isArray(after)) return [];
  const paths =
    JSON.stringify(Object.keys(before)) !== JSON.stringify(Object.keys(after)) ? [path] : [];
  return paths.concat(
    ...Object.keys(before).map((key) =>
      reorderedObjectPaths(before[key], after[key], `${path}.${key}`),
    ),
  );
}
function serviceIdentity(value) {
  return {
    id: value.id,
    revision: value.revision,
    configRevision: value.configRevision,
    desiredState: value.desiredState,
    configurationState: value.configurationState,
    publishedDeploymentId: value.published?.deploymentId ?? null,
    publishedHash: hash(value.published),
    configurationHash: hash(value.configuration),
    activeTask: value.activeTask ?? null,
  };
}
function deploymentIdentity(value) {
  return {
    id: value.id,
    serviceId: value.serviceId,
    status: value.status,
    attempt: value.attempt,
    snapshotHash: hash(value.snapshot),
    failureObservationHash: hash(value.failureObservation),
    imageHash: hash(value.resolvedImage),
  };
}
async function identities(serviceIds) {
  const services = [];
  for (const id of serviceIds) services.push(serviceIdentity(await api('/services/' + id)));
  const deployments = [];
  for (const id of [ids.git, ids.oom, ids.legacy])
    deployments.push(deploymentIdentity(await api('/deployments/' + id)));
  return { services, deployments };
}
async function assertNoRenderedSecrets(page) {
  const text = await page.locator('body').innerText();
  assert(
    secrets.every((secret) => !secret || !text.includes(secret)),
    'A private session value was rendered',
  );
  assert(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), 'A private key was rendered');
  assert(!/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text), 'A GitHub credential was rendered');
}
async function screenshot(page, name, target) {
  await diskFloor();
  await expect(page.getByRole('status', { name: '正在载入', exact: true })).toHaveCount(0);
  if (target) await target.scrollIntoViewIfNeeded();
  await assertNoRenderedSecrets(page);
  const path = resolve(artifactDirectory, name + '.png');
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  const geometry = await page.evaluate(() => ({
    viewportWidth: globalThis.innerWidth,
    documentWidth: globalThis.document.documentElement.scrollWidth,
    dark: globalThis.document.documentElement.classList.contains('dark'),
  }));
  summary.screenshots.push({ file: name + '.png', url: page.url(), ...geometry });
  assert(geometry.documentWidth <= geometry.viewportWidth + 1, 'Page has horizontal overflow');
}
async function check(name, operation) {
  if (mode === 'configuration' && name !== 'equal-configuration-has-no-false-diff') return;
  try {
    const details = await operation();
    summary.checks.push({ name, status: 'passed', ...details });
  } catch (error) {
    summary.checks.push({ name, status: 'failed', error: errorText(error) });
  }
  await checkpoint();
  console.log(JSON.stringify({ checkpoint: name, status: summary.checks.at(-1).status }));
}
async function uiChecks(page, equalService, deployments) {
  await check('v3-github-source-label', async () => {
    assert.equal(deployments.git.snapshot.version, 3);
    await page.goto('/deployments/' + ids.git);
    const snapshot = page.locator('[data-deployment-storage-snapshot]');
    await expect(snapshot).toContainText('GitHub · Dockerfile 构建');
    await expect(snapshot).toContainText(deployments.git.snapshot.source.revision.dockerfilePath);
    await expect(snapshot).not.toContainText('自定义镜像');
    await screenshot(page, '01-v3-git-source', snapshot);
    return {
      deploymentId: ids.git,
      version: 3,
      dockerfile: deployments.git.snapshot.source.revision.dockerfilePath,
    };
  });
  await check('equal-configuration-has-no-false-diff', async () => {
    const before = equalService.published?.configuration;
    assert(before, 'Published configuration is required');
    assert.deepEqual(canonical(before), canonical(equalService.configuration));
    const path = `/projects/${equalService.projectId}/services/${equalService.id}?environment=${equalService.environment.slug}`;
    await page.goto(path);
    await page
      .getByRole('navigation', { name: '服务页面' })
      .getByRole('link', { name: '发布预览', exact: true })
      .click();
    const review = page.locator('[data-deployment-review]');
    await expect(review).toContainText(
      '与最近完整应用的配置一致。继续发布会创建新的部署记录，并重新确认运行状态。',
    );
    await expect(review.getByRole('region', { name: '已发布配置与待发布配置差异' })).toHaveCount(0);
    await screenshot(
      page,
      '02-equal-configuration',
      review.getByRole('heading', { name: '发布预览', exact: true }),
    );
    const reorderedPaths = reorderedObjectPaths(before, equalService.configuration);
    return {
      serviceId: equalService.id,
      canonicalConfigurationsEqual: true,
      reorderedObjectPaths: reorderedPaths,
      objectKeyOrderDifferencePresentInRealData: reorderedPaths.length > 0,
      unitRegression: 'apps/console/tests/unit/service-configuration-review.test.ts',
      arrayOrderPreserved: true,
      previewPostRequests: 0,
    };
  });
  await check('retained-oom-diagnostics', async () => {
    assert.equal(deployments.oom.status, 'failed');
    const containers = deployments.oom.failureObservation.pods.flatMap(
      (pod) => pod.containers ?? [],
    );
    assert(containers.some((container) => container.oomKilled));
    await page.goto('/deployments/' + ids.oom);
    const observation = page.locator('[data-deployment-failure-observation]');
    await expect(observation.locator('summary')).toContainText('容器内存不足');
    await observation.locator('summary').click();
    await expect(observation).toContainText(
      '内存不足（OOMKilled），检查内存上限与应用用量后重新发布。',
    );
    await screenshot(page, '03-retained-oom', observation);
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, '04-retained-oom-narrow', observation.locator('summary'));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '选择外观主题' }).click();
    await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await screenshot(page, '05-retained-oom-dark', observation);
    await page.getByRole('button', { name: '选择外观主题' }).click();
    await page.getByRole('menuitemradio', { name: '浅色', exact: true }).click();
    return {
      deploymentId: ids.oom,
      containers: containers.length,
      oomContainers: containers.filter((container) => container.oomKilled).length,
    };
  });
  await check('legacy-diagnostics-do-not-invent-oom', async () => {
    assert(deployments.legacy.failureObservation.pods.some((pod) => pod.containers === undefined));
    await page.goto('/deployments/' + ids.legacy);
    const observation = page.locator('[data-deployment-failure-observation]');
    await expect(observation.locator('summary')).not.toContainText('容器内存不足');
    await observation.locator('summary').click();
    await expect(observation).toContainText('这份历史记录未保存容器诊断。');
    await expect(observation).not.toContainText('内存不足（OOMKilled）');
    await screenshot(page, '06-legacy-diagnostics', observation);
    return { deploymentId: ids.legacy, missingContainerDiagnosticsExplicit: true };
  });
}
async function voAction(name, script, page) {
  const pids = await voiceOverPids();
  if (pids.length !== 1 || pids[0] !== summary.voiceOver.pid) {
    const error = new Error(
      'The owned VoiceOver process exited or changed; stop rather than relaunching it through AppleEvents',
    );
    error.name = 'VoiceOverTransportError';
    throw error;
  }
  await foreground(browserPid);
  await assertNoRenderedSecrets(page);
  let phrase;
  try {
    phrase = await command('/usr/bin/osascript', [
      '-e',
      `with timeout of 6 seconds
    tell application "VoiceOver"
      ${script}
      delay 0.3
      get content of last phrase
    end tell
  end timeout`,
    ]);
  } catch (cause) {
    const error = new Error(errorText(cause));
    error.name = 'VoiceOverTransportError';
    throw error;
  }
  assert.equal(await foreground(), browserPid, 'Foreground changed during VoiceOver capture');
  assert(phrase, 'VoiceOver returned an empty last phrase');
  const row = {
    name,
    capturedAt: new Date().toISOString(),
    page: page.url(),
    command: script,
    phrase: safeText(phrase),
    browserPid,
  };
  summary.voiceOver.actualPhrases.push(row);
  await checkpoint();
  return phrase;
}
async function readFocused(name, locator, page) {
  await foreground(browserPid);
  await locator.focus();
  await expect(locator).toBeFocused();
  const moved = await voAction(
    name + ':focus',
    'tell commander to perform command "move voiceover cursor to keyboard focus"',
    page,
  );
  const described = await voAction(
    name + ':description',
    'tell commander to perform command "describe item with keyboard focus"',
    page,
  );
  return moved + '\n' + described;
}
async function readAdjacent(name, direction, page, matches, limit = 8) {
  const phrases = [];
  for (let index = 0; index < limit; index++) {
    const phrase = await voAction(
      `${name}:${index + 1}`,
      `tell vo cursor to move ${direction}`,
      page,
    );
    phrases.push(phrase);
    if (matches.test(phrase)) break;
  }
  return phrases.join('\n');
}
async function voCheck(name, operation, matches) {
  try {
    const actual = await operation();
    assert(matches.test(actual), 'Expected meaning was not captured in actual VoiceOver speech');
    summary.voiceOver.assertions.push({ name, status: 'passed' });
  } catch (error) {
    summary.voiceOver.assertions.push({ name, status: 'failed', error: errorText(error) });
    if (error.name === 'VoiceOverTransportError') throw error;
  }
  await checkpoint();
  console.log(
    JSON.stringify({ voiceOver: name, status: summary.voiceOver.assertions.at(-1).status }),
  );
}
async function voiceOverChecks(page, clusterId) {
  const priorPids = await voiceOverPids();
  summary.voiceOver.beforePids = priorPids;
  assert.equal(
    priorPids.length,
    0,
    'VoiceOver is already in use; leave its current session untouched',
  );
  originalPreference = await preference();
  summary.voiceOver.preferenceBefore = originalPreference;
  if (originalPreference.exists) assert.equal(typeof originalPreference.value, 'boolean');
  if (!originalPreference.exists || !originalPreference.value) {
    await command('/usr/bin/defaults', [
      'write',
      'com.apple.VoiceOver4',
      'SCREnableAppleScript',
      '-bool',
      'true',
    ]);
    preferenceChanged = true;
  }
  await foreground(browserPid);
  summary.voiceOver.launchMethod = 'System VoiceOver shortcut: Command-F5';
  await command('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to key code 96 using {command down}',
  ]);
  voiceOverStarted = true;
  await delay(3000);
  const pids = await voiceOverPids();
  assert.equal(pids.length, 1, 'A single real VoiceOver process is required');
  summary.voiceOver.pid = pids[0];
  summary.voiceOver.preferenceDuring = await preference();
  const anonymous = await browser.newContext({
    baseURL: realOrigin,
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  await installRequestGuard(anonymous);
  try {
    const login = await anonymous.newPage();
    await login.goto('/login');
    await login.bringToFront();
    await voCheck(
      'login-username-label',
      () => readFocused('login-username', login.getByLabel('管理员账号', { exact: true }), login),
      /管理员账号/,
    );
    await voCheck(
      'login-empty-password-label',
      () => readFocused('login-password-empty', login.getByLabel('密码', { exact: true }), login),
      /密码/,
    );
    await voCheck(
      'login-native-required-error',
      async () => {
        await login.getByRole('button', { name: '登录工作台', exact: true }).click();
        const field = login.getByLabel('管理员账号', { exact: true });
        summary.voiceOver.loginNativeValidity = await field.evaluate((element) => ({
          valueEmpty: element.value === '',
          valid: element.validity.valid,
          valueMissing: element.validity.valueMissing,
          validationMessage: element.validationMessage,
        }));
        const announcement = await voAction('login-native-validation:automatic', '', login);
        return announcement + '\n' + (await readFocused('login-invalid-username', field, login));
      },
      /请输入|请填写|fill out|invalid|无效|invalid entry/i,
    );
  } finally {
    await anonymous.close();
  }
  await page.bringToFront();
  await page.goto('/projects/new?clusterId=' + clusterId);
  await voCheck(
    'project-selected-target',
    async () => {
      const selected = page.locator(`input[type="radio"][value="${clusterId}"]`);
      await expect(selected).toBeChecked();
      const actual = await readFocused('project-selected-target', selected, page);
      assert(/selected|已选|选定|选中/i.test(actual), 'Selected state was not announced');
      return actual;
    },
    /radio|单选/i,
  );
  await voCheck(
    'project-target-inheritance-context',
    () => readAdjacent('project-target-context', 'right', page, /项目创建后固定使用/),
    /项目创建后固定使用/,
  );
  await voCheck(
    'project-slug-associated-help',
    () => readFocused('project-slug-help', page.getByLabel('项目标识', { exact: true }), page),
    /小写字母、数字与连字符/,
  );
  await page.goto('/deployments/' + ids.oom);
  const oom = page.locator('[data-deployment-failure-observation]');
  await voCheck(
    'oom-disclosure-summary',
    () => readFocused('oom-disclosure', oom.locator('summary'), page),
    /容器内存不足/,
  );
  await voCheck(
    'failed-deployment-status',
    async () => {
      const breadcrumb = page.getByRole('navigation', { name: '面包屑' }).getByRole('link').last();
      await readFocused('failed-task-breadcrumb', breadcrumb, page);
      return readAdjacent('failed-task-state', 'right', page, /失败/, 10);
    },
    /失败/,
  );
  await page.goto('/deployments/' + ids.git);
  await voCheck(
    'build-log-bounded-region',
    () =>
      readFocused(
        'build-log-region',
        page.getByRole('region', { name: '构建与推送日志，可滚动', exact: true }),
        page,
      ),
    /构建与推送日志，可滚动/,
  );
  await voCheck(
    'build-log-source',
    async () => {
      await readFocused(
        'build-log-refresh',
        page.getByRole('button', { name: '刷新构建日志', exact: true }),
        page,
      );
      return readAdjacent('build-log-source', 'left', page, /来源：独立 Builder/);
    },
    /来源：独立 Builder/,
  );
  await voCheck(
    'deployment-log-bounded-region',
    () =>
      readFocused(
        'deployment-log-region',
        page.getByRole('region', { name: '部署执行日志，可滚动', exact: true }),
        page,
      ),
    /部署执行日志，可滚动/,
  );
  await voCheck(
    'deployment-log-source',
    async () => {
      await readFocused(
        'deployment-log-refresh',
        page.getByRole('button', { name: '刷新部署日志', exact: true }),
        page,
      );
      return readAdjacent('deployment-log-source', 'left', page, /来源：平台阶段事件/);
    },
    /来源：平台阶段事件/,
  );
  summary.voiceOver.status = summary.voiceOver.assertions.every((row) => row.status === 'passed')
    ? 'passed'
    : 'partial';
}
async function restoreVoiceOver() {
  if (voiceOverStarted) {
    const beforeQuit = await voiceOverPids();
    if (beforeQuit.length === 1 && beforeQuit[0] === summary.voiceOver.pid) {
      try {
        await command('/usr/bin/osascript', ['-e', 'tell application "VoiceOver" to quit']);
      } catch (error) {
        summary.voiceOver.restoration.quitError = errorText(error);
        const pids = await voiceOverPids();
        if (pids.length === 1 && pids[0] === summary.voiceOver.pid)
          process.kill(pids[0], 'SIGTERM');
      }
    }
    await delay(600);
    summary.voiceOver.restoration.afterPids = await voiceOverPids();
    voiceOverStarted = false;
  }
  if (preferenceChanged) {
    if (originalPreference.exists)
      await command('/usr/bin/defaults', [
        'write',
        'com.apple.VoiceOver4',
        'SCREnableAppleScript',
        '-bool',
        String(originalPreference.value),
      ]);
    else
      await command('/usr/bin/defaults', [
        'delete',
        'com.apple.VoiceOver4',
        'SCREnableAppleScript',
      ]);
    summary.voiceOver.restoration.preferenceAfter = await preference();
    assert.deepEqual(summary.voiceOver.restoration.preferenceAfter, originalPreference);
    preferenceChanged = false;
  }
}
try {
  lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ runId, pid: process.pid }));
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  summary.availableDiskBytesBefore = await diskFloor();
  summary.certificate = await verifyRealEntryCertificate();
  const state = await readRealState();
  const file = await lstat(sessionPath);
  assert(
    file.isFile() &&
      !file.isSymbolicLink() &&
      file.uid === process.getuid() &&
      (file.mode & 0o077) === 0,
    'The reused session must be a private owned regular file',
  );
  session = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert(
    session.owner === 'ozz-gmvp-workload-faults-v1' &&
      session.origin === realOrigin &&
      /^ozz_session=[A-Za-z0-9._~-]+$/.test(session.cookie) &&
      typeof session.csrf === 'string' &&
      session.csrf.length >= 32,
    'Private session metadata is invalid',
  );
  secrets.push(session.cookie, session.cookie.slice('ozz_session='.length), session.csrf);
  originalForeground = await foreground();
  browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--force-renderer-accessibility'],
  });
  const cdp = await browser.newBrowserCDPSession();
  const processes = await cdp.send('SystemInfo.getProcessInfo');
  browserPid = processes.processInfo.find((row) => row.type === 'browser')?.id;
  assert(Number.isInteger(browserPid), 'Dedicated Chrome process identity is missing');
  summary.browser = {
    pid: browserPid,
    version: browser.version(),
    profile: 'new Playwright temporary profile',
    trace: false,
    video: false,
    globalTrustChanged: false,
  };
  context = await browser.newContext({
    baseURL: realOrigin,
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    colorScheme: 'light',
  });
  await installRequestGuard(context);
  await context.addCookies([
    {
      name: 'ozz_session',
      value: session.cookie.slice('ozz_session='.length),
      domain: '127.0.0.1',
      path: '/api',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
  const me = await api('/auth/me');
  assert(
    me.user?.username === 'admin' && me.csrfToken === session.csrf,
    'Reused session is no longer valid; do not attempt repeated logins',
  );
  summary.authentication = {
    privateSessionReused: true,
    adminVerified: true,
    csrfMatched: true,
    loginRequests: 0,
  };
  const deployments = {};
  for (const key of ['git', 'oom', 'legacy'])
    deployments[key] = await api('/deployments/' + ids[key]);
  const equalService = await api('/services/' + ids.equalConfigurationService);
  const serviceIds = [
    ...new Set([equalService.id, ...Object.values(deployments).map((value) => value.serviceId)]),
  ];
  summary.beforeIdentity = await identities(serviceIds);
  afterIdentity = () => identities(serviceIds);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  if (mode !== 'voiceover') await uiChecks(page, equalService, deployments);
  if (wantsVoiceOver) {
    try {
      await voiceOverChecks(page, state.resources.cluster);
    } catch (error) {
      summary.voiceOver.status = 'blocked';
      summary.voiceOver.error = errorText(error);
    } finally {
      await restoreVoiceOver();
    }
  }
  summary.afterIdentity = await afterIdentity();
  assert.deepEqual(
    summary.afterIdentity,
    summary.beforeIdentity,
    'Inspected service/deployment identities changed',
  );
  summary.identityPreserved = true;
  assert.equal(summary.requestAudit.blockedWrites.length, 0, 'The UI attempted a write');
  assert.equal(summary.requestAudit.pageErrors, 0, 'The browser reported a page error');
  assert.equal(summary.requestAudit.apiFailures.length, 0, 'The browser reported an API failure');
} catch (error) {
  summary.error = errorText(error);
} finally {
  try {
    await restoreVoiceOver();
  } catch (error) {
    summary.voiceOver.restoration.error = errorText(error);
  }
  if (browser) {
    await browser.close().catch((error) => {
      summary.cleanup.browserCloseError = errorText(error);
    });
    try {
      process.kill(browserPid, 0);
      summary.cleanup.browserExited = false;
    } catch (error) {
      summary.cleanup.browserExited = error.code === 'ESRCH';
    }
  }
  if (originalForeground)
    await foreground(originalForeground).catch((error) => {
      summary.cleanup.foregroundRestoreError = errorText(error);
    });
  if (lock) {
    await lock.close();
    await unlink(lockPath);
    summary.cleanup.lockReleased = true;
  }
  summary.availableDiskBytesAfter = await diskFloor().catch(() => null);
  summary.finishedAt = new Date().toISOString();
  summary.status =
    !summary.error &&
    summary.checks.every((row) => row.status === 'passed') &&
    (!wantsVoiceOver || summary.voiceOver.status === 'passed') &&
    !summary.voiceOver.restoration.error &&
    summary.cleanup.browserExited
      ? 'passed'
      : 'partial';
  if (summary.startedAt && summary.cleanup.lockReleased) await checkpoint();
  console.log(
    JSON.stringify({
      runId,
      status: summary.status,
      ui: summary.checks.map(({ name, status }) => ({ name, status })),
      voiceOver: summary.voiceOver.status,
      artifactDirectory,
      cleanup: summary.cleanup,
      error: summary.error,
    }),
  );
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}
