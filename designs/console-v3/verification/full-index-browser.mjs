import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const require = createRequire(root + '/apps/console/package.json');
const { chromium } = require('@playwright/test');
const base = root + '/designs/console-v3';
const entry = pathToFileURL(base + '/index.html').href;
const output = process.env.OZZ_PROTO_OUTPUT_DIR ? resolve(root, process.env.OZZ_PROTO_OUTPUT_DIR) : base + '/verification';
mkdirSync(output, { recursive: true });
const result = { scope: 'real index.html with core and management modules; in-memory prototype only', startedAt: new Date().toISOString(), checks: [], errors: [], network: [], hashes: {}, limitations: ['No real API, infrastructure, authorization, data backup or restore.', 'Synthetic composition events only; no real Chinese IME or screen-reader claim.', 'Targeted controls, not all 78 legacy scenarios individually tested.'] };
for (const file of ['index.html', 'app.js', 'styles.css', 'management.js', 'management.css']) result.hashes[file] = createHash('sha256').update(readFileSync(base + '/' + file)).digest('hex');
const browser = await chromium.launch({ headless: true, executablePath: process.env.OZZ_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), args: ['--disable-background-networking'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(6500);
page.on('pageerror', error => result.errors.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url())) result.network.push(request.url()); });
page.on('dialog', dialog => dialog.accept());
const selector = (action) => `[data-action="${action}"]`;
const control = (action) => page.locator(selector(action));
const input = (bind) => page.locator(`[data-bind="${bind}"]`);
const mgInput = (name) => page.locator(`.dialog [name="${name}"]`);
const submit = (name) => page.locator(`[data-form="${name}"] button[type="submit"]`).click();
const state = (read, arg) => page.evaluate(read, arg);
const currentService = () => state(() => window.OzzPrototype.context().service);
const blogUrl = (service = 'blog-web', tab = 'status') => `#/project/blog/service/${service}?env=blog-production&tab=${tab}`;
async function reset(hash = '#/projects') {
  await page.goto(entry + hash);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.OzzPrototype && window.OzzManagement));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { localStorage.setItem('ozz-v3-prototype-theme', 'light'); });
}
async function route(hash) {
  await page.evaluate(value => window.OzzPrototype.api.goto(value, true), hash);
  await page.waitForFunction(value => decodeURIComponent(location.hash) === decodeURIComponent(value), hash);
  await page.locator('main h1').waitFor();
}
async function dismiss() {
  for (let i = 0; i < 5 && await page.locator('.dialog').count(); i++) await page.keyboard.press('Escape');
}
async function done(taskId) {
  await page.waitForFunction(id => { const t = window.OzzPrototype.state.tasks.find(t => t.id === id); return t && !['queued', 'running', 'cancelling'].includes(t.status); }, taskId);
  return state(id => window.OzzPrototype.state.tasks.find(t => t.id === id), taskId);
}
async function lastTask() { return state(() => window.OzzPrototype.state.tasks[0]); }
async function chooseScenario(name) {
  await control('demo-options').click();
  await page.locator(`[data-action="demo-scenario"][value="${name}"]`).check();
  await dismiss();
}
async function confirm() { await control('confirm-submit').click(); }
async function openGroup(label) {
  const details = page.locator('.config-group').filter({ has: page.locator('summary').filter({ hasText: label }) }).first();
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
async function check(name, run) {
  if (process.env.OZZ_PROTO_GROUP && !name.includes(process.env.OZZ_PROTO_GROUP)) return;
  try { const evidence = await run(); result.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); }
  catch (error) { result.checks.push({ name, passed: false, error: String(error.stack || error), url: page.url() }); process.exitCode = 1; console.error('FAIL ' + name + '\n' + String(error.stack || error)); }
}

try {
  await check('route rendering', async () => {
    await reset();
    const routes = ['#/projects', '#/projects/new', '#/servers', '#/servers?tab=clusters', '#/server/server-tokyo', '#/server/server-tokyo?tab=preflight', '#/cluster/cluster-tokyo', '#/cluster/cluster-tokyo?tab=connection', '#/settings', '#/settings?tab=credentials', '#/settings?tab=integrations', '#/settings?tab=entry', '#/settings?tab=appearance', '#/settings?tab=platform', '#/resources?type=services', '#/resources?type=volumes', '#/resources?type=databases', '#/resources?type=domains', '#/volume/vol-postgres', '#/volume/vol-postgres?tab=maintenance', '#/volume/vol-postgres?tab=records', '#/database/db-postgres', '#/domain/dom-web', '#/activity', '#/task/deploy-api-4', '#/project/blog/settings?env=blog-production', '#/project/blog/integrations?env=blog-production', '#/planning', '#/planning?phase=p2'];
    const observed = [];
    for (const hash of routes) { await route(hash); const title = await page.locator('main h1').innerText(); assert.ok(title && !/装配|功能入口/.test(title), hash); observed.push({ route: hash, title }); }
    return observed;
  });

  await check('project creation and five real templates', async () => {
    await reset('#/projects/new');
    await submit('create-project');
    assert.equal(await page.locator('.command-item').count(), 4);
    const projectId = await state(() => window.OzzPrototype.context().project.id);
    const choices = [
      ['docker', 'application', '', '8080', '100', '128', '500', '256', null],
      ['node-example', 'application', 'node:24.22.1-alpine3.24', '8080', '100', '64', '500', '128', null],
      ['static-example', 'application', 'nginx:1.28.3-alpine3.23', '80', '25', '32', '250', '64', null],
      ['postgresql', 'database-menu', 'postgres:17.11-bookworm', '5432', '100', '256', '1000', '768', 4],
      ['redis', 'database-menu', 'redis:7.4.11-bookworm', '6379', '100', '64', '500', '256', 1],
    ];
    const observed = [];
    for (const [id, category, image, port, requestCpu, requestMemory, cpu, memory, size] of choices) {
      if (!await page.locator('.dialog').count()) await control('add-service').click();
      await page.locator(`[data-action="choose-source"][data-source="${category}"]`).click();
      assert.equal(await page.locator('[data-action="choose-template"]').count(), category === 'application' ? 3 : 2);
      await page.locator(`[data-action="choose-template"][data-id="${id}"]`).click();
      const draft = await state(() => window.OzzPrototype.state.modal.draft);
      assert.deepEqual([draft.version, draft.image, draft.port, draft.requestCpu, draft.requestMemory, draft.cpu, draft.memory], ['1.0.0', image, port, requestCpu, requestMemory, cpu, memory]);
      if (id === 'docker') await input('create.image').fill('nginx:1.28.3-alpine3.23');
      else { assert.equal(await input('create.image').getAttribute('readonly'), ''); assert.match(draft.imageDigest, /^sha256:[a-f0-9]{64}$/); }
      if (id === 'redis') { await input('create.redisDatabase').fill('16'); await submit('source-review'); assert.match(await page.locator('.form-error').innerText(), /0 到 15/); await input('create.redisDatabase').fill('0'); }
      const beforeSave = await state(id => window.OzzPrototype.state.projects.find(p => p.id === id).services.length, projectId);
      await submit('source-review');
      assert.equal(await state(id => window.OzzPrototype.state.projects.find(p => p.id === id).services.length, projectId), beforeSave + 1);
      assert.match(await page.locator('.dialog').innerText(), /服务草稿已保存/);
      assert.equal(await state(() => window.OzzPrototype.state.tasks.length), 4);
      await control('create-draft').click();
      const s = await currentService();
      assert.equal(s.publishedSnapshot, null);
      if (size) { const v = await state(sid => window.OzzPrototype.state.volumes.find(v => v.serviceId === sid), s.id); assert.equal(v.capacity, size); assert.deepEqual(v.actualReferences, []); }
      observed.push({ id, serviceId: s.id, templateVersion: s.draft.version, image: s.draft.image, storageGiB: size, status: s.status });
    }
    assert.equal(await state(id => window.OzzPrototype.state.projects.find(p => p.id === id).services.length, projectId), 5);
    return { automaticProject: projectId, templates: observed };
  });

  await check('source switching preserves independent drafts', async () => {
    await reset(blogUrl());
    await control('add-service').click();
    await page.waitForFunction(() => document.activeElement?.dataset.source === 'git');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await state(() => window.OzzPrototype.state.modal.step), 'config');
    await input('create.image').fill('nginx:1.28.3-alpine3.23');
    await input('create.port').fill('80');
    await openGroup('服务信息');
    await input('create.name').fill('switch-demo');
    await control('source-cancel').click();
    await page.locator('[data-action="choose-source"][data-source="database-menu"]').click();
    await page.locator('[data-action="choose-template"][data-id="postgresql"]').click();
    await input('create.storage').fill('8');
    await control('source-cancel').click();
    await page.locator('[data-action="choose-source"][data-source="image"]').click();
    assert.equal(await input('create.image').inputValue(), 'nginx:1.28.3-alpine3.23');
    assert.equal(await input('create.port').inputValue(), '80');
    assert.equal(await input('create.name').inputValue(), 'switch-demo');
    assert.equal(await state(() => window.OzzPrototype.state.modal.draft.type), 'web');
    assert.equal(await page.locator('.dialog').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.screenshot({ path: output + '/full-create-1440.png', fullPage: true });
    await control('source-cancel').click();
    await page.locator('[data-action="choose-source"][data-source="database-menu"]').click();
    await page.locator('[data-action="choose-template"][data-id="postgresql"]').click();
    assert.equal(await input('create.storage').inputValue(), '8');
    return { dockerDraftPreserved: true, databaseDraftPreserved: true, arrowAndEnter: true };
  });

  await check('failed deployment retry and independent draft snapshot', async () => {
    await reset('#/task/deploy-api-4');
    await control('mg:task-retry').click();
    await confirm();
    const task = await lastTask();
    assert.equal(task.attemptOf, 'deploy-api-4');
    assert.equal((await done(task.id)).status, 'succeeded');
    assert.equal(await state(() => window.OzzPrototype.state.projects[0].services.length), 4);
    assert.equal(await state(() => window.OzzPrototype.state.tasks.find(t => t.id === 'deploy-api-4').status), 'failed');
    await page.locator('main a[href*="/service/blog-api"]').first().click();
    assert.equal((await currentService()).id, 'blog-api');
    await page.locator('.service-tabs a').filter({ hasText: '环境变量' }).click();
    await control('variable-add').click();
    await input('config.variables.0.key').fill('NEW_DRAFT');
    await input('config.variables.0.value').fill('pending');
    await control('save-config').click();
    assert.equal((await currentService()).publishedSnapshot.variables.length, 0);
    await page.locator('.service-tabs a').filter({ hasText: '服务状态' }).click();
    await page.locator('.more-menu summary').click();
    await control('service-stop').click();
    await confirm();
    await done((await lastTask()).id);
    await page.locator('.runtime-actions [data-action="service-resume"]').click();
    await confirm();
    await done((await lastTask()).id);
    const s = await currentService();
    assert.equal(s.status, 'running'); assert.equal(s.draft.variables.length, 1); assert.equal(s.publishedSnapshot.variables.length, 0);
    assert.deepEqual(await page.locator('.service-tabs a').allTextContents(), ['服务状态', '环境变量', '用量', '网络', '硬盘', '设置']);
    await page.screenshot({ path: output + '/full-workspace-1440.png', fullPage: true });
    return { retryTask: task.id, sameService: s.id, originalFailureKept: true, resumeDoesNotPublishDraft: true };
  });

  await check('saved creation preview uses same service and unknown request', async () => {
    await reset(blogUrl()); await control('add-service').click(); await page.locator('[data-action="choose-source"][data-source="image"]').click();
    await input('create.image').fill('nginx:1.28.3-alpine3.23'); await input('create.port').fill('80'); await submit('source-review');
    const saved = await currentService(); assert.equal(saved.status, 'draft'); assert.equal(saved.publishedSnapshot, null);
    assert.equal(await state(() => window.OzzPrototype.state.projects[0].services.length), 5);
    await control('source-config').click(); await input('create.port').fill('8081'); await submit('source-review');
    assert.equal((await currentService()).id, saved.id); assert.equal((await currentService()).draft.port, '8081');
    assert.equal(await state(() => window.OzzPrototype.state.projects[0].services.length), 5);
    await control('create-draft').click(); assert.equal((await currentService()).id, saved.id);
    await chooseScenario('offline'); await control('add-service').click(); await page.locator('[data-action="choose-source"][data-source="image"]').click();
    await input('create.image').fill('busybox:1.37'); await submit('source-review');
    assert.equal(await state(() => window.OzzPrototype.state.modal.step), 'save-unknown');
    const fixed = await state(() => ({ key: window.OzzPrototype.state.modal.draft.fallback, id: window.OzzPrototype.state.modal.draft.createdServiceId }));
    await control('source-confirm-saved').click();
    assert.equal(await state(() => window.OzzPrototype.state.modal.draft.createdServiceId), fixed.id);
    assert.equal(await state(() => window.OzzPrototype.state.projects[0].services.length), 6);
    assert.equal(await state(() => window.OzzPrototype.state.tasks.length), 4);
    await control('create-draft').click();
    return { savedBeforeReview: saved.id, editReusesService: true, fixedUnknownRequest: fixed, unknownConfirmationDoesNotCreateDuplicate: true, noDeploymentBeforeConfirmation: true };
  });

  await check('environment file import validates and preserves published snapshot', async () => {
    await reset(blogUrl('blog-api', 'variables')); await control('import-env').click();
    await input('modal.text').fill('APP_MODE=demo\nAPP_MODE=again'); await submit('env-parse'); assert.match(await page.locator('.dialog .form-error').innerText(), /重复/); assert.equal(await page.locator('main .form-error').count(), 0);
    await input('modal.text').fill('APP_MODE=demo\nRETRIES=3'); await submit('env-parse'); await control('env-apply').click();
    assert.equal((await currentService()).draft.variables.length, 0); await control('save-config').click();
    const s = await currentService(); assert.equal(s.draft.variables.length, 2); assert.equal(s.publishedSnapshot.variables.length, 0);
    await input('config.variables.0.mode').selectOption('secret'); await input('config.variables.0.value').fill('demo-only-secret');
    await input('config.variables.0.mode').selectOption('reference'); assert.equal(await input('config.variables.0.value').inputValue(), '');
    await input('config.variables.0.value').selectOption('cred-shared-token'); await control('save-config').click();
    await route('#/settings?tab=credentials&q=共享'); await control('mg:credential-detail').click(); await control('mg:credential-remove').click();
    assert.match(await page.locator('.dialog').innerText(), /引用|使用方/);
    return { duplicateImportBlocked: true, parsedVariables: 2, savedAsDraft: true, variableTypeClearsValue: true, serviceReferenceProtectsCredential: true };
  });

  await check('stopped Git service queues commit and resumes original version', async () => {
    await reset(blogUrl()); await page.locator('.more-menu summary').click(); await control('service-stop').click(); await confirm(); await done((await lastTask()).id);
    const count = await state(() => window.OzzPrototype.state.tasks.length);
    await control('demo-options').click(); await control('demo-git-push').click();
    assert.equal(await state(() => window.OzzPrototype.state.tasks.length), count); assert.equal((await currentService()).pendingCommits.length, 1);
    await page.locator('.runtime-actions [data-action="service-resume"]').click(); await confirm(); await done((await lastTask()).id);
    assert.equal((await currentService()).pendingCommits.length, 1); assert.equal((await currentService()).publishedRevision, 3);
    await control('demo-options').click(); await control('demo-git-reject').click();
    assert.equal(await state(() => window.OzzPrototype.state.gitEvents[0].status), 'rejected'); assert.equal(await state(() => window.OzzPrototype.state.tasks.length), count + 1);
    return { stoppedPushCreatesNoDeployment: true, pendingCommitPreservedAfterResume: true, invalidSignatureRejectedWithoutTask: true };
  });

  await check('project metadata and environment ownership', async () => {
    await reset('#/project/blog/settings?env=blog-production');
    await page.locator('[data-form="mg:project-save"] [name="name"]').fill('博客工作区');
    await submit('mg:project-save');
    await control('mg:environment-new').click();
    await mgInput('name').fill('测试'); await mgInput('slug').fill('staging');
    await submit('mg:environment-save');
    const env = await state(() => window.OzzPrototype.state.projects.find(p => p.id === 'blog').environments.find(e => e.slug === 'staging'));
    await page.locator(`[data-action="mg:environment-switch"][data-id="${env.id}"]`).click();
    assert.equal(await state(() => window.OzzPrototype.context().environment.id), env.id);
    assert.equal(await page.locator('.service-list [data-service]').count(), 0);
    await route('#/project/blog/settings?env=' + env.id);
    await page.locator('[data-action="mg:environment-remove"][data-id="blog-production"]').click();
    assert.match(await page.locator('.dialog').innerText(), /不能.*删除|不能移除|仍有服务/);
    const p = await state(() => window.OzzPrototype.state.projects.find(p => p.id === 'blog'));
    assert.equal(p.services.filter(s => s.environmentId === 'blog-production').length, 4);
    assert.equal(p.targetId, 'cluster-tokyo'); assert.equal(p.name, '博客工作区');
    await route('#/resources?project=blog&env=toolbox-production');
    assert.match(await page.locator('main').innerText(), /无效|不属于|不匹配|不存在/);
    return { renamed: p.name, environment: env.id, inheritedTarget: p.targetId, originalServices: 4, invalidScopeBlocked: true };
  });

  await check('server registration fingerprint preflight and cluster import', async () => {
    await reset('#/servers');
    await control('mg:server-new').click();
    await mgInput('name').fill('Prototype Host'); await mgInput('address').fill('192.0.2.99'); await mgInput('credentialId').selectOption('cred-ssh');
    await submit('mg:server-save');
    const s = await state(() => window.OzzPrototype.state.servers.find(s => s.name === 'Prototype Host'));
    await control('mg:fingerprint-discover').click(); await done((await lastTask()).id);
    await page.locator(`main a[href="#/server/${s.id}"]`).first().click();
    await route(`#/server/${s.id}?tab=preflight`);
    await control('mg:fingerprint-confirm').click(); await confirm();
    await control('mg:server-preflight').click(); await done((await lastTask()).id);
    assert.equal(await state(id => window.OzzPrototype.state.servers.find(s => s.id === id).preflight.passed, s.id), true);
    await route('#/servers'); await control('mg:cluster-import').click();
    await control('mg:kubeconfig-sample').click(); await mgInput('name').fill('Imported Demo');
    await submit('mg:cluster-parse');
    assert.equal(await page.locator('.dialog [data-mg-secret]').count(), 0);
    await control('mg:cluster-import-back').click();
    assert.equal(await mgInput('name').inputValue(), 'Imported Demo');
    assert.equal(await mgInput('kubeconfig').inputValue(), '');
    await control('mg:kubeconfig-sample').click(); await submit('mg:cluster-parse');
    await mgInput('ack').check(); await submit('mg:cluster-import-save');
    const task = await lastTask(); assert.equal((await done(task.id)).status, 'succeeded');
    const c = await state(() => window.OzzPrototype.state.clusters.find(c => c.name === 'Imported Demo'));
    assert.ok(c?.identity); assert.equal(c.status, 'ready');
    assert.equal(await state(() => window.OzzPrototype.state.projects.find(p => p.id === 'blog').targetId), 'cluster-tokyo');
    return { registeredServer: s.id, preflight: true, importedCluster: c.id, existingProjectTargetUnchanged: true, secretClearedOnBack: true };
  });

  await check('credential secrets and referenced deletion', async () => {
    await reset('#/settings?tab=credentials');
    await control('mg:credential-new').click();
    await mgInput('name').fill('Temporary credential'); await mgInput('kind').selectOption('ssh');
    await mgInput('privateKey').fill('demo-secret-never-retained');
    await mgInput('kind').selectOption('generic');
    await page.getByRole('button', { name: '清空并切换', exact: true }).click();
    assert.equal(await mgInput('secret').inputValue(), '');
    await mgInput('secret').fill('demo-generic-never-retained');
    await submit('mg:credential-save');
    const serialized = await state(() => JSON.stringify(window.OzzPrototype.state, (key, value) => typeof value === 'function' ? undefined : value));
    assert.ok(!serialized.includes('demo-secret-never-retained') && !serialized.includes('demo-generic-never-retained'));
    const created = await state(() => window.OzzPrototype.state.credentials.find(c => c.name === 'Temporary credential'));
    assert.equal(created.kind, 'generic');
    await route('#/settings?tab=credentials&q=部署服务器');
    await page.locator('[data-action="mg:credential-detail"][data-id="cred-ssh"]').click();
    await control('mg:credential-remove').click();
    assert.match(await page.locator('.dialog').innerText(), /引用|使用方/);
    assert.ok(await state(() => window.OzzPrototype.state.credentials.some(c => c.id === 'cred-ssh')));
    return { typeChangeClearsSecret: true, savedStateHasNoSecret: true, referencedCredentialRetained: true };
  });

  await check('registry identities and builder field validation', async () => {
    await reset('#/settings?tab=integrations');
    await page.locator('a[href="#/settings?tab=git&kind=registry"]').click();
    await page.locator('[data-action="mg:integration-detail"][data-id="registry-main"]').click();
    await control('mg:integration-edit').click();
    assert.notEqual(await mgInput('credentialId').inputValue(), await mgInput('pullCredentialId').inputValue());
    assert.equal(await mgInput('endpoint').getAttribute('readonly'), ''); assert.ok(await mgInput('namespace').count());
    await dismiss();
    await page.locator('a[href="#/settings?tab=git&kind=builder"]').click();
    await page.locator('[data-action="mg:integration-detail"][data-id="builder-main"]').click();
    await control('mg:integration-edit').click();
    assert.ok(await mgInput('instanceId').count()); assert.ok(await mgInput('identityPublicKey').count());
    const frontend = mgInput('frontendDigest');
    await frontend.evaluate(el => { for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true; });
    await frontend.fill('sha256:invalid');
    await submit('mg:integration-save');
    assert.match(await page.locator('.dialog').innerText(), /digest|摘要|SHA256|64 位/i);
    await frontend.fill('sha256:' + 'b'.repeat(64));
    await submit('mg:integration-save');
    assert.equal(await state(() => window.OzzPrototype.state.integrations.find(i => i.id === 'builder-main').profile.frontendDigest), 'sha256:' + 'b'.repeat(64));
    return { pushPullSeparate: true, fixedBuilderIdentityFields: true, malformedFrontendBlocked: true };
  });

  await check('volume draft published and observed references', async () => {
    await reset('#/volume/vol-archive');
    await control('mg:volume-mount').click(); await mgInput('serviceId').selectOption('blog-web'); await submit('mg:volume-mount-save');
    let v = await state(() => window.OzzPrototype.state.volumes.find(v => v.id === 'vol-archive'));
    assert.ok(v.references.includes('blog-web')); assert.deepEqual(v.actualReferences, []);
    const unchanged = v.actualObservedAt;
    await page.locator('main a[href*="/service/blog-web"]').first().click();
    await control('review-deploy').click(); await submit('deploy-review'); await done((await lastTask()).id);
    v = await state(() => window.OzzPrototype.state.volumes.find(v => v.id === 'vol-archive'));
    assert.ok(v.actualReferences.includes('blog-web')); assert.notEqual(v.actualObservedAt, unchanged); assert.ok(v.pvc && v.pv);
    await route('#/volume/vol-archive'); await control('mg:volume-unmount').click(); await confirm();
    const snapshots = await state(() => { const s = window.OzzPrototype.api.findService('blog-web').service; const v = window.OzzPrototype.state.volumes.find(v => v.id === 'vol-archive'); return { draft: s.draft.mounts.length, published: s.publishedSnapshot.mounts.length, actual: v.actualReferences, observedAt: v.actualObservedAt }; });
    assert.deepEqual([snapshots.draft, snapshots.published], [0, 1]); assert.ok(snapshots.actual.includes('blog-web'));
    await control('mg:volume-destroy').click();
    assert.match(await page.locator('.dialog').innerText(), /仍有.*引用|解除/);
    await route(blogUrl()); await control('review-deploy').click(); await submit('deploy-review'); await done((await lastTask()).id);
    v = await state(() => window.OzzPrototype.state.volumes.find(v => v.id === 'vol-archive'));
    assert.deepEqual(v.actualReferences, []); assert.deepEqual(v.references, []);
    assert.equal(await state(() => window.OzzPrototype.state.volumes.find(v => v.id === 'vol-postgres').actualObservedAt), '2026-10-29T07:32:00.000Z');
    return { savedDraftDoesNotFakeMount: true, publicationUpdatesActual: true, removalWaitsForPublication: true, unrelatedObservationUnchanged: true };
  });

  await check('manual maintenance evidence and operation interlock', async () => {
    await reset('#/volume/vol-postgres?tab=maintenance');
    await page.locator('[data-action="mg:maintenance-new"][data-mode="backup"]').click(); await mgInput('ack').check(); await submit('mg:maintenance-enter');
    const task = await lastTask(); assert.equal((await done(task.id)).status, 'succeeded');
    await route(blogUrl('blog-postgres')); await control('review-deploy').click();
    assert.match(await page.locator('.dialog').innerText(), /正在维护/);
    await page.locator('.dialog a[href*="/volume/vol-postgres"]').click();
    await control('mg:record-new').click(); await control('mg:record-sample').click(); await submit('mg:record-save');
    const v = await state(() => window.OzzPrototype.state.volumes.find(v => v.id === 'vol-postgres'));
    assert.equal(v.records.length, 1); assert.equal(v.records[0].maintenanceId, v.maintenance.id);
    assert.equal(await state(() => window.OzzPrototype.state.tasks.length), 5);
    await route('#/volume/vol-postgres?tab=maintenance');
    await control('mg:maintenance-exit').click(); await mgInput('helperRemoved').check(); await mgInput('mountsVerified').check(); await mgInput('evidence').fill('演示：helper 已移除，已核对原卷挂载和写入恢复。'); await submit('mg:maintenance-exit-save');
    assert.equal((await done((await lastTask()).id)).status, 'succeeded');
    assert.equal(await state(() => window.OzzPrototype.state.volumes.find(v => v.id === 'vol-postgres').maintenance), null);
    return { maintenanceTask: task.id, record: v.records[0].id, recordCreatesNoExecutionTask: true, deploymentBlockedWhileLocked: true, exitIndependentlyVerified: true };
  });

  await check('database mapping and shared service resource creation', async () => {
    await reset('#/database/db-postgres'); await control('mg:database-connect').click(); await mgInput('serviceId').selectOption('blog-api');
    await submit('mg:database-preview'); assert.match(await page.locator('.dialog').innerText(), /下次部署后注入/); await submit('mg:database-bind');
    const s = await state(() => window.OzzPrototype.api.findService('blog-api').service);
    assert.equal(s.draft.connections.length, 1); assert.equal(s.publishedSnapshot.connections.length, 0);
    await page.locator('main a[href*="/service/blog-api"]').first().click();
    await page.locator('.service-tabs a').filter({ hasText: '硬盘' }).click();
    await control('volume-create').first().click(); await mgInput('name').fill('reports-data'); await mgInput('sizeGiB').fill('2'); await submit('mg:volume-create');
    assert.equal((await done((await lastTask()).id)).status, 'succeeded');
    const v = await state(() => window.OzzPrototype.state.volumes.find(v => v.name === 'reports-data'));
    assert.equal(v.status, 'pending'); assert.equal(v.projectId, 'blog'); assert.equal(v.environmentId, 'blog-production'); assert.ok(v.pvc); assert.ok(!v.pv && !v.node);
    await route(blogUrl('blog-api', 'network')); await control('domain-add').first().click();
    assert.equal(await mgInput('serviceId').inputValue(), 'blog-api'); await mgInput('portName').selectOption('http'); await mgInput('prefix').fill('api-preview'); await submit('mg:domain-create');
    assert.equal((await done((await lastTask()).id)).status, 'succeeded');
    const domain = await state(() => window.OzzPrototype.state.domains.find(d => d.hostname.startsWith('api-preview.')));
    assert.equal(domain.port, 8080); assert.equal(domain.certificate, 'staging');
    await page.locator(`main a[href="#/domain/${domain.id}"]`).first().click(); await control('mg:domain-production').click(); await confirm(); assert.equal((await done((await lastTask()).id)).status, 'succeeded');
    assert.equal(await state(id => window.OzzPrototype.state.domains.find(d => d.id === id).certificate, domain.id), 'production');
    return { databaseMappingIsDraft: true, newVolumeWaitsForConsumer: v.id, domainUsesPublishedPort: domain.port, stagingBeforeProduction: true, sharedManagementControls: true };
  });

  await check('domain unbind and service deletion retains data', async () => {
    await reset('#/resources?type=domains');
    await page.locator('main a[href="#/domain/dom-web"], main a[href^="#/domain/dom-web?"]').click();
    await page.waitForFunction(() => window.OzzPrototype.context().kind === 'domain' && window.OzzPrototype.context().id === 'dom-web');
    assert.equal(await state(() => window.OzzPrototype.context().params.get('list')), '#/resources?type=domains');
    assert.equal(await page.getByRole('link', { name: '域名列表', exact: true }).getAttribute('href'), '#/resources?type=domains');
    await control('mg:domain-unbind').click(); await input('modal.input').fill('blog.tokyo.ozz.test'); await confirm(); await done((await lastTask()).id);
    assert.equal(await state(() => window.OzzPrototype.state.domains.some(d => d.id === 'dom-web')), false);
    await route('#/volume/vol-archive'); await control('mg:volume-mount').click(); await mgInput('serviceId').selectOption('blog-worker'); await submit('mg:volume-mount-save');
    await page.locator('main a[href*="/service/blog-worker"]').first().click();
    await page.locator('.more-menu summary').click(); await control('service-delete').click(); await input('modal.input').fill('worker'); await confirm();
    await done((await lastTask()).id);
    assert.equal(await state(() => Boolean(window.OzzPrototype.api.findService('blog-worker'))), false);
    const v = await state(() => window.OzzPrototype.state.volumes.find(v => v.id === 'vol-archive'));
    assert.equal(v.retained, true); assert.equal(v.serviceId, null); assert.deepEqual(v.actualReferences, []);
    const retainedList = '#/resources?type=volumes&project=blog&env=blog-production';
    await page.locator('main a[href="#/volume/vol-archive"], main a[href^="#/volume/vol-archive?"]').click();
    await page.waitForFunction(() => window.OzzPrototype.context().kind === 'volume' && window.OzzPrototype.context().id === 'vol-archive');
    assert.equal(await state(() => window.OzzPrototype.context().params.get('list')), retainedList);
    assert.equal(await page.getByRole('link', { name: '数据卷列表', exact: true }).getAttribute('href'), retainedList);
    await page.locator('main h1').filter({ hasText: 'archive-data' }).waitFor();
    assert.match(await page.locator('main h1').innerText(), /archive-data/);
    await page.getByRole('link', { name: '数据卷列表', exact: true }).click();
    assert.equal(await state(() => location.hash), retainedList);
    return { domainReturnContextPreserved: true, domainBindingRemoved: true, serviceDeleted: true, independentVolume: v.id, retainedVolumeReachable: true, retainedVolumeReturnContextPreserved: true };
  });

  await check('task unknown reconciliation and cancellation', async () => {
    await reset(blogUrl('blog-api'));
    await chooseScenario('offline');
    await control('review-deploy').click(); await submit('deploy-review');
    const task = await lastTask(); assert.equal((await done(task.id)).status, 'unknown');
    await route('#/task/' + task.id); assert.equal(await control('mg:task-retry').count(), 0);
    await control('mg:task-reconcile').click(); await mgInput('observed').selectOption('succeeded'); await mgInput('evidence').fill('演示：核对原任务 ID、固定配置与目标实例完成证据。'); await mgInput('ack').check(); await submit('mg:task-reconcile-save');
    assert.equal(await state(id => window.OzzPrototype.state.tasks.find(t => t.id === id).status, task.id), 'succeeded');
    assert.equal(await state(() => window.OzzPrototype.state.tasks.length), 5);
    await chooseScenario('normal'); await route(blogUrl('blog-api'));
    await control('review-deploy').click(); await submit('deploy-review');
    const next = await lastTask(); await route('#/task/' + next.id); await control('mg:task-cancel').click(); await confirm();
    assert.equal((await done(next.id)).status, 'cancelled');
    return { unknownRequiresOriginalReconciliation: task.id, noDuplicateOnReconcile: true, cancelledTask: next.id };
  });

  await check('planning parameters results and validation boundary', async () => {
    await reset('#/planning');
    await page.locator('[data-action="mg:plan"][data-feature="F28"]').click(); await input('plan.components').selectOption('api-cache'); await submit('plan-preview'); await control('plan-run').click();
    await page.waitForFunction(() => window.OzzPrototype.state.planningRuns[0]?.status === 'succeeded');
    assert.equal(await page.locator('.component-results > div').count(), 2);
    assert.match(await page.locator('.component-results').innerText(), /api[\s\S]*redis/i);
    await dismiss();
    await page.locator('[data-action="mg:plan"][data-feature="F35"]').click(); await submit('plan-preview'); await control('plan-run').click();
    await page.waitForFunction(() => window.OzzPrototype.state.planningRuns[0]?.status === 'succeeded');
    assert.equal(await control('plan-validate-data').isDisabled(), true);
    for (const key of ['verifySchema', 'verifyData', 'verifyApp']) await input('plan.' + key).check();
    await control('plan-validate-data').click();
    assert.match(await page.locator('.plan-result').innerText(), /生产连接尚未切换/);
    assert.equal(await state(() => window.OzzPrototype.state.tasks.length), 4);
    return { componentCountFollowsParameters: 2, independentPlanningRecords: 2, noRealTaskCreated: true, independentDataVerification: true };
  });

  await check('responsive themes logs keyboard and synthetic IME', async () => {
    await reset(blogUrl());
    await control('open-logs').click();
    await page.locator('[data-log="query"]').fill('cache'); assert.match(await page.locator('.log-output').innerText(), /cache miss/);
    await page.locator('[data-log="query"]').fill('no-such-output'); assert.match(await page.locator('.log-output').innerText(), /没有匹配/);
    await page.locator('[data-log="query"]').fill(''); await control('log-follow').click(); await control('log-wrap').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await state(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.screenshot({ path: output + '/full-logs-390.png', fullPage: true }); await dismiss();
    await control('toggle-menu').click(); assert.ok(await page.locator('.drawer-open').count()); await page.locator('.drawer-backdrop').click({ position: { x: 370, y: 100 } });
    await page.setViewportSize({ width: 1024, height: 900 }); await route('#/settings?tab=credentials'); await control('toggle-theme').click();
    assert.equal(await state(() => document.documentElement.dataset.theme), 'dark');
    assert.ok(await state(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.screenshot({ path: output + '/full-management-1024.png', fullPage: true });
    await route('#/projects/new'); await input('project.name').fill('输入法测试');
    const before = await state(() => window.OzzPrototype.state.projects.length);
    await input('project.name').evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '输入' })); el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true })); el.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(await state(() => window.OzzPrototype.state.projects.length), before);
    await input('project.name').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入法测试' })));
    await page.waitForTimeout(180); await control('toggle-theme').click(); assert.equal(await input('project.name').inputValue(), '输入法测试');
    return { widths: [390, 1024, 1440], noPageOverflow: true, logFilterPauseWrap: true, themePreservesInput: true, syntheticCompositionPreventsSubmit: true, realIME: 'not tested' };
  });

  assert.ok(result.checks.length > 0, 'No prototype checks matched');
  assert.deepEqual(result.errors, []); assert.deepEqual(result.network, []);
} catch (error) { result.failure = String(error.stack || error); process.exitCode = 1; console.error(result.failure); }
finally {
  result.finishedAt = new Date().toISOString(); result.passed = result.checks.length > 0 && result.checks.every(c => c.passed) && !result.failure && result.errors.length === 0 && result.network.length === 0;
  writeFileSync(output + '/full-index-results.json', JSON.stringify(result, null, 2) + '\n');
  await browser.close();
}
