import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { relative, resolve } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { PrismaClient } from '../../../../packages/database/dist/index.js';
import { hashJson } from '../../../../packages/infrastructure/dist/build.js';
import {
  readRealState,
  realCaPath,
  realOrigin,
  realPasswordPath,
  verifyRealEntryCertificate,
} from './s6-real-support.ts';

// Only login/logout writes are allowed. All other network requests and database
// transactions are read-only. Sessions, traces, HAR, video, and storageState are never saved.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const runId = `${new Date().toISOString().replaceAll(/[^0-9TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
const directory = resolve(root, '.local/local-lab/g-mvp-recovery-https', runId);
const recoveryPath = resolve(root, '.local/local-lab/g-mvp-recovery/state.json');
const secrets = [];
const report = {
  version: 1,
  owner: 'ozz-g-mvp-recovery-https-v1',
  runId,
  startedAt: new Date().toISOString(),
  origin: realOrigin,
  scope:
    'Recovered original local control plane: strict HTTPS, fresh API and browser login, retained identities, and read-only key pages.',
  productionSecureCookieVerified: false,
  checks: [],
  screenshots: [],
  network: {
    nodeRequests: [],
    browserRequests: [],
    blockedWrites: [],
    foreignRequests: [],
    unexpectedApiFailures: [],
    pageErrors: 0,
  },
  cleanup: {},
};
let ca;
let password = '';
let nodeCookie = '';
let nodeCsrf = '';
let browserCsrf = '';
let browser;
let context;
let database;
let step = 'preflight';
let failed = false;

function requireValue(condition, code) {
  if (!condition) throw new Error('GMVP_RECOVERY_HTTPS_' + code);
}
function safe(value) {
  let result = String(value);
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]');
  return result.replace(/ozz_session=[^\s;,]+/g, 'ozz_session=[redacted]');
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right, code) => requireValue(hashJson(left) === hashJson(right), code);
const ordered = (values) => [...values].sort((left, right) => left.id.localeCompare(right.id));
async function evidence(name, value) {
  const path = resolve(directory, name);
  await writeFile(path, safe(JSON.stringify(value, null, 2)) + '\n', { flag: 'wx', mode: 0o600 });
  return { path: relative(root, path), sha256: sha256(await readFile(path)) };
}
async function stage(name, action) {
  step = name;
  const startedAt = new Date().toISOString();
  const details = await action();
  const result = {
    name,
    status: 'passed',
    startedAt,
    finishedAt: new Date().toISOString(),
    ...details,
  };
  const file = await evidence(
    `${String(report.checks.length + 1).padStart(2, '0')}-${name}.json`,
    result,
  );
  report.checks.push({ ...result, evidence: file });
  console.log(JSON.stringify({ checkpoint: name, status: 'passed', evidence: file.path }));
  return details;
}
function request(path, { method = 'GET', body, session = true, expected = 200 } = {}) {
  requireValue(path.startsWith('/') && !path.startsWith('//'), 'PATH_INVALID');
  const url = new URL(path, realOrigin);
  requireValue(url.origin === realOrigin, 'ORIGIN_INVALID');
  requireValue(
    ['GET', 'HEAD', 'OPTIONS'].includes(method) ||
      (method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(url.pathname)),
    'WRITE_NOT_ALLOWED',
  );
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { accept: 'application/json' };
  if (nodeCookie && session) headers.cookie = nodeCookie;
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  if (method === 'POST') {
    headers.origin = realOrigin;
    if (nodeCsrf && session) headers['x-csrf-token'] = nodeCsrf;
  }
  return new Promise((accept, reject) => {
    const req = httpsRequest(
      url,
      { ca, rejectUnauthorized: true, checkServerIdentity, method, headers, agent: false },
      (res) => {
        const socket = res.socket;
        if (!socket.authorized || checkServerIdentity(url.hostname, socket.getPeerCertificate())) {
          res.resume();
          reject(new Error('GMVP_RECOVERY_HTTPS_TLS_NOT_AUTHORIZED'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) req.destroy(new Error('GMVP_RECOVERY_HTTPS_RESPONSE_BOUND'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          report.network.nodeRequests.push({
            method,
            path: url.pathname,
            status: res.statusCode,
            strictTls: true,
          });
          for (const value of res.headers['set-cookie'] ?? []) {
            if (value.startsWith('ozz_session=')) secrets.push(value.split(';', 1)[0].slice(12));
          }
          if (res.statusCode !== expected) {
            reject(
              new Error(`GMVP_RECOVERY_HTTPS_HTTP_${res.statusCode}_${method}_${url.pathname}`),
            );
            return;
          }
          try {
            const data = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
            if (data?.data?.csrfToken) secrets.push(data.data.csrfToken);
            accept({ status: res.statusCode, headers: res.headers, body: data });
          } catch {
            reject(new Error('GMVP_RECOVERY_HTTPS_JSON_INVALID'));
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('GMVP_RECOVERY_HTTPS_TIMEOUT')));
    req.once('error', reject);
    req.end(payload);
  });
}
const get = async (path) => (await request('/api' + path)).body.data;
async function collection(path) {
  const url = new URL('/api' + path, realOrigin);
  url.searchParams.set('limit', '100');
  const rows = [];
  const cursors = new Set();
  for (let count = 0; count < 20; count++) {
    const value = (await request(url.pathname + url.search)).body;
    requireValue(Array.isArray(value.data) && value.page, 'COLLECTION_INVALID');
    rows.push(...value.data);
    if (!value.page.hasMore) return rows;
    const cursor = value.page.nextCursor;
    requireValue(cursor && !cursors.has(cursor), 'COLLECTION_CURSOR_INVALID');
    cursors.add(cursor);
    url.searchParams.set('cursor', cursor);
  }
  throw new Error('GMVP_RECOVERY_HTTPS_COLLECTION_BOUND');
}
const serviceIdentity = (value) => ({
  id: value.id,
  mutationRevision: value.mutationRevision,
  configRevision: value.configRevision,
  publishedDeploymentId: value.published?.deploymentId ?? null,
  desiredState: value.desiredState,
});
const deploymentIdentity = (value) => ({
  id: value.id,
  serviceId: value.serviceId,
  status: value.status,
  sourceRevisionId: value.sourceRevisionId,
  artifactId: value.artifactId,
  snapshotSha256: hashJson(value.snapshot),
  targetSha256: hashJson(value.target),
  failureObservationSha256: hashJson(value.failureObservation ?? null),
});
function savedDeploymentIdentity(deployment) {
  const value = { ...deployment };
  delete value.generation;
  return value;
}
async function databaseIdentity() {
  return database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const control = await tx.controlPlaneState.findUniqueOrThrow({
      where: { id: 'control-plane' },
      select: { installationId: true, generation: true, restoreLocked: true },
    });
    const admin = await tx.admin.findUniqueOrThrow({
      where: { username: 'admin' },
      select: { id: true, username: true },
    });
    const projects = await tx.project.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, slug: true, clusterId: true, revision: true },
    });
    return { control, admin, projects };
  });
}
const projectIdentity = ({ id, name, slug, clusterId, revision }) => ({
  id,
  name,
  slug,
  clusterId,
  revision,
});
async function browserApi(path, expected = 200) {
  const response = await context.request.get(realOrigin + '/api' + path, { maxRedirects: 0 });
  requireValue(response.status() === expected, 'BROWSER_API_STATUS');
  const value = await response.json();
  if (value.data?.csrfToken) secrets.push(value.data.csrfToken);
  return value.data;
}
async function screenshot(page, name) {
  await expect(page.getByRole('status', { name: '正在载入', exact: true })).toHaveCount(0);
  const text = await page.locator('body').innerText();
  requireValue(
    secrets.every((secret) => !secret || !text.includes(secret)),
    'RENDERED_SECRET',
  );
  requireValue(
    !/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text),
    'RENDERED_CREDENTIAL',
  );
  const disk = await statfs(root);
  requireValue(disk.bavail * disk.bsize >= 8 * 1024 ** 3, 'DISK_FLOOR');
  const buffer = await page.screenshot({ fullPage: true, animations: 'disabled' });
  const path = resolve(directory, name + '.png');
  await writeFile(path, buffer, { flag: 'wx', mode: 0o600 });
  const geometry = await page.evaluate(() => ({
    viewportWidth: globalThis.innerWidth,
    documentWidth: globalThis.document.documentElement.scrollWidth,
  }));
  requireValue(geometry.documentWidth <= geometry.viewportWidth + 1, 'HORIZONTAL_OVERFLOW');
  const item = { path: relative(root, path), sha256: sha256(buffer), url: page.url(), ...geometry };
  report.screenshots.push(item);
  return item;
}

try {
  requireValue(process.version === 'v24.22.1', 'USE_PNPM_NODE');
  await mkdir(resolve(root, '.local/local-lab/g-mvp-recovery-https'), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(directory, { mode: 0o700 });
  ca = await readFile(realCaPath);
  await stage('strict-entry-tls', async () => verifyRealEntryCertificate());
  const recoveryBytes = await readFile(recoveryPath);
  const recovery = JSON.parse(recoveryBytes.toString('utf8'));
  const state = await readRealState();
  requireValue(
    recovery.originalReturnedGeneration === 5 && recovery.originalNeedsReconcile === false,
    'ORIGINAL_NOT_RETURNED',
  );
  report.recoveryBaseline = {
    path: relative(root, recoveryPath),
    sha256: sha256(recoveryBytes),
    recoveryId: recovery.id,
    returnedGeneration: recovery.originalReturnedGeneration,
  };
  const environment = parseEnv(await readFile(resolve(root, '.env'), 'utf8'));
  requireValue(environment.DATABASE_URL, 'DATABASE_CONFIGURATION_MISSING');
  secrets.push(environment.DATABASE_URL);
  database = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
  const beforeDatabase = await databaseIdentity();
  same(
    beforeDatabase.control,
    { installationId: recovery.identities.installationId, generation: 5, restoreLocked: false },
    'CONTROL_IDENTITY_MISMATCH',
  );
  password = (await readFile(realPasswordPath, 'utf8')).trim();
  requireValue(password.length > 0, 'PASSWORD_MISSING');
  secrets.push(password);
  let nodeUser;
  await stage('fresh-strict-https-api-login', async () => {
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password },
      session: false,
    });
    const rawCookie = login.headers['set-cookie']?.find((value) =>
      value.startsWith('ozz_session='),
    );
    requireValue(rawCookie, 'SESSION_COOKIE_MISSING');
    nodeCookie = rawCookie.split(';', 1)[0];
    nodeCsrf = login.body.data.csrfToken;
    const me = await get('/auth/me');
    same(me.user, beforeDatabase.admin, 'ADMIN_IDENTITY_MISMATCH');
    same(me.user, login.body.data.user, 'LOGIN_ME_MISMATCH');
    requireValue(me.restoreMode === false, 'RESTORE_MODE_ACTIVE');
    requireValue(
      /;\s*HttpOnly(?:;|$)/i.test(rawCookie) &&
        /;\s*SameSite=Strict(?:;|$)/i.test(rawCookie) &&
        /;\s*Path=\/api(?:;|$)/i.test(rawCookie),
      'COOKIE_ATTRIBUTES',
    );
    nodeUser = me.user;
    return {
      loginStatus: login.status,
      meStatus: 200,
      user: me.user,
      restoreMode: me.restoreMode,
      control: beforeDatabase.control,
      cookieAttributes: {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/api',
        secure: /;\s*Secure(?:;|$)/i.test(rawCookie),
      },
      credentialsSaved: false,
    };
  });
  let chosenService;
  let chosenDeployment;
  let chosenProject;
  let beforePublic;
  await stage('retained-public-identities', async () => {
    const [projects, services, deployments] = await Promise.all([
      collection('/projects'),
      collection('/services'),
      collection('/deployments'),
    ]);
    beforePublic = {
      projects: ordered(projects.map(projectIdentity)),
      services: ordered(services.map(serviceIdentity)),
      deployments: ordered(deployments.map(deploymentIdentity)),
    };
    same(beforePublic.projects, ordered(beforeDatabase.projects), 'PROJECT_IDENTITIES_MISMATCH');
    same(
      beforePublic.services,
      ordered(recovery.sourceSnapshot.services),
      'SERVICE_IDENTITIES_MISMATCH',
    );
    same(
      beforePublic.deployments,
      ordered(recovery.sourceSnapshot.deployments.map(savedDeploymentIdentity)),
      'DEPLOYMENT_IDENTITIES_MISMATCH',
    );
    chosenService = await get('/services/' + state.resources.service);
    chosenProject = await get('/projects/' + state.resources.project);
    requireValue(
      chosenService.projectId === chosenProject.id &&
        chosenService.environmentId === state.resources.environment &&
        chosenService.clusterId === state.resources.cluster,
      'SERVICE_CONTEXT_MISMATCH',
    );
    requireValue(
      chosenService.source.kind === 'github' && chosenService.published?.deploymentId,
      'PUBLISHED_GIT_SERVICE_MISSING',
    );
    chosenDeployment = await get('/deployments/' + chosenService.published.deploymentId);
    const expected = recovery.sourceSnapshot.deployments.find(
      (value) => value.id === chosenDeployment.id,
    );
    requireValue(expected, 'PUBLISHED_DEPLOYMENT_NOT_RETAINED');
    same(
      deploymentIdentity(chosenDeployment),
      savedDeploymentIdentity(expected),
      'PUBLISHED_GIT_IDENTITY_MISMATCH',
    );
    requireValue(
      chosenDeployment.kind === 'git_deploy' &&
        chosenDeployment.snapshot.version === 3 &&
        chosenDeployment.status === 'succeeded',
      'PUBLISHED_GIT_INVALID',
    );
    const health = (await request('/api/health/ready', { session: false })).body;
    requireValue(
      health.status === 'ready' && health.mode === 'read_write' && health.queue === 'ready',
      'HEALTH_NOT_READY',
    );
    const latest = deployments
      .filter((value) => value.serviceId === chosenService.id)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )[0];
    const identitiesEvidence = await evidence('retained-identities.json', beforePublic);
    return {
      projects: projects.length,
      services: services.length,
      deployments: deployments.length,
      identitiesEvidence,
      projectId: chosenProject.id,
      serviceId: chosenService.id,
      publishedDeploymentId: chosenDeployment.id,
      latestDeploymentId: latest.id,
      firstDeploymentId: state.firstDeploymentId,
      selectedFrom:
        'current service.published.deploymentId, checked against retained sourceSnapshot',
      sourceRevisionId: chosenDeployment.sourceRevisionId,
      artifactId: chosenDeployment.artifactId,
      commitSha: chosenDeployment.snapshot.source.revision.commitSha,
      snapshotSha256: hashJson(chosenDeployment.snapshot),
      health,
    };
  });
  await stage('fresh-browser-login', async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    context = await browser.newContext({
      baseURL: realOrigin,
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    report.browserTrust =
      'A private browser context permits this local fixture certificate only after independent strict Node CA and IP SAN verification; browser trust-store validation is not claimed.';
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      if (url.origin !== realOrigin) {
        report.network.foreignRequests.push({
          method: req.method(),
          origin: url.origin,
          path: url.pathname,
        });
        return route.abort('blockedbyclient');
      }
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) &&
        !(req.method() === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(url.pathname))
      ) {
        report.network.blockedWrites.push({ method: req.method(), path: url.pathname });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    context.on('response', (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/')) return;
      const row = {
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
      };
      report.network.browserRequests.push(row);
      if (row.status >= 400 && !(row.path === '/api/auth/me' && row.status === 401))
        report.network.unexpectedApiFailures.push(row);
    });
    const page = await context.newPage();
    page.on('pageerror', () => report.network.pageErrors++);
    await page.goto('/login?returnTo=%2Fprojects');
    await expect(page.getByRole('button', { name: '登录工作台', exact: true })).toBeVisible();
    await screenshot(page, '01-fresh-login-empty');
    await page.getByLabel('管理员账号', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill(password);
    const loginResponse = page.waitForResponse(
      (response) =>
        response.url() === realOrigin + '/api/auth/login' && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '登录工作台', exact: true }).click();
    const response = await loginResponse;
    requireValue(response.status() === 200, 'BROWSER_LOGIN_FAILED');
    const login = (await response.json()).data;
    browserCsrf = login.csrfToken;
    secrets.push(browserCsrf);
    await expect(page).toHaveURL(realOrigin + '/projects');
    const me = await browserApi('/auth/me');
    same(me.user, nodeUser, 'BROWSER_USER_MISMATCH');
    requireValue(me.restoreMode === false, 'BROWSER_RESTORE_MODE_ACTIVE');
    const cookies = await context.cookies(realOrigin + '/api/auth/me');
    const cookie = cookies.find((value) => value.name === 'ozz_session');
    requireValue(
      cookie?.httpOnly && cookie.path === '/api' && cookie.sameSite === 'Strict',
      'BROWSER_COOKIE_ATTRIBUTES',
    );
    secrets.push(cookie.value);
    requireValue('ozz_session=' + cookie.value !== nodeCookie, 'BROWSER_SESSION_NOT_INDEPENDENT');
    password = '';
    return {
      loginStatus: response.status(),
      meStatus: 200,
      user: me.user,
      restoreMode: me.restoreMode,
      independentlyCreatedSession: true,
      cookieAttributes: {
        httpOnly: cookie.httpOnly,
        path: cookie.path,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
      },
      browserVersion: browser.version(),
      storageStateSaved: false,
    };
  });
  await stage('key-pages-read-only', async () => {
    const page = context.pages()[0];
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: chosenProject.name, exact: true }),
    ).toBeVisible();
    await screenshot(page, '02-projects-after-login');
    await page.goto(`/projects/${chosenProject.id}?environment=${chosenService.environment.slug}`);
    await expect(
      page.getByRole('heading', { name: chosenProject.name, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: chosenService.name, exact: true })).toBeVisible();
    await screenshot(page, '03-recovered-project-services');
    await page.goto(
      `/projects/${chosenProject.id}/services/${chosenService.id}?environment=${chosenService.environment.slug}&tab=overview`,
    );
    await expect(
      page.getByRole('heading', { name: chosenService.name, exact: true, level: 1 }),
    ).toBeVisible();
    await screenshot(page, '04-recovered-git-service');
    const service = await browserApi('/services/' + chosenService.id);
    same(serviceIdentity(service), serviceIdentity(chosenService), 'BROWSER_SERVICE_MISMATCH');
    await page.goto('/deployments/' + chosenDeployment.id);
    await expect(
      page.getByRole('heading', { name: chosenService.name + ' · Git 构建发布', exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-deployment-storage-snapshot]')).toContainText(
      'GitHub · Dockerfile 构建',
    );
    await expect(page.locator('body')).toContainText(chosenDeployment.id);
    await screenshot(page, '05-current-published-git-deployment');
    const deployment = await browserApi('/deployments/' + chosenDeployment.id);
    same(
      deploymentIdentity(deployment),
      deploymentIdentity(chosenDeployment),
      'BROWSER_DEPLOYMENT_MISMATCH',
    );
    requireValue(
      report.network.blockedWrites.length === 0 &&
        report.network.foreignRequests.length === 0 &&
        report.network.unexpectedApiFailures.length === 0 &&
        report.network.pageErrors === 0,
      'BROWSER_NETWORK_OR_PAGE_ERRORS',
    );
    return {
      pages: [
        '/projects',
        '/projects/' + chosenProject.id,
        '/projects/' + chosenProject.id + '/services/' + chosenService.id,
        '/deployments/' + chosenDeployment.id,
      ],
      screenshotCount: report.screenshots.length,
      projectId: chosenProject.id,
      serviceId: chosenService.id,
      deploymentId: chosenDeployment.id,
      snapshotVersion: deployment.snapshot.version,
      realNetwork: true,
      responseFixturesUsed: false,
    };
  });
  await stage('identities-preserved-after-browser', async () => {
    const [projects, services, deployments, afterDatabase] = await Promise.all([
      collection('/projects'),
      collection('/services'),
      collection('/deployments'),
      databaseIdentity(),
    ]);
    const afterPublic = {
      projects: ordered(projects.map(projectIdentity)),
      services: ordered(services.map(serviceIdentity)),
      deployments: ordered(deployments.map(deploymentIdentity)),
    };
    same(beforePublic, afterPublic, 'PUBLIC_BUSINESS_FACTS_CHANGED');
    same(beforeDatabase, afterDatabase, 'DATABASE_IDENTITY_CHANGED');
    return {
      publicIdentitySha256Before: hashJson(beforePublic),
      publicIdentitySha256After: hashJson(afterPublic),
      databaseIdentitySha256Before: hashJson(beforeDatabase),
      databaseIdentitySha256After: hashJson(afterDatabase),
      control: afterDatabase.control,
      unchanged: true,
    };
  });
} catch (error) {
  failed = true;
  report.failure = { stage: step, code: safe(error?.message ?? error).slice(0, 1400) };
  console.log(JSON.stringify({ checkpoint: step, status: 'failed', error: report.failure.code }));
} finally {
  password = '';
  if (context && browserCsrf) {
    try {
      const response = await context.request.post(realOrigin + '/api/auth/logout', {
        headers: { origin: realOrigin, 'x-csrf-token': browserCsrf },
        maxRedirects: 0,
      });
      requireValue(response.status() === 204, 'BROWSER_LOGOUT_FAILED');
      await browserApi('/auth/me', 401);
      report.cleanup.browserSessionRevoked = true;
    } catch (error) {
      failed = true;
      report.cleanup.browserLogoutError = safe(error.message).slice(0, 500);
    }
  }
  if (context) {
    try {
      await context.close();
      report.cleanup.browserContextClosed = true;
    } catch {
      failed = true;
      report.cleanup.browserContextClosed = false;
    }
  }
  if (browser) {
    try {
      await browser.close();
      report.cleanup.ownBrowserClosed = !browser.isConnected();
    } catch {
      failed = true;
      report.cleanup.ownBrowserClosed = false;
    }
  }
  if (nodeCookie && nodeCsrf) {
    try {
      await request('/api/auth/logout', { method: 'POST', expected: 204 });
      await request('/api/auth/me', { expected: 401 });
      report.cleanup.nodeSessionRevoked = true;
    } catch (error) {
      failed = true;
      report.cleanup.nodeLogoutError = safe(error.message).slice(0, 500);
    }
  }
  nodeCookie = '';
  nodeCsrf = '';
  browserCsrf = '';
  if (database) await database.$disconnect();
  report.cleanup.databaseDisconnected = true;
  report.finishedAt = new Date().toISOString();
  report.status = failed ? 'failed' : 'passed';
  report.network.allowedWriteEndpoints = ['/api/auth/login', '/api/auth/logout'];
  report.credentialEvidence = {
    passwordSaved: false,
    cookieSaved: false,
    csrfSaved: false,
    storageStateSaved: false,
    tracesSaved: false,
    videoSaved: false,
    harSaved: false,
  };
  const result = await evidence('report.json', report);
  console.log(
    JSON.stringify({
      status: report.status,
      runId,
      report: result.path,
      sha256: result.sha256,
      cleanup: report.cleanup,
    }),
  );
  if (failed) process.exitCode = 1;
}
