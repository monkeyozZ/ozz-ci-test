import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import {
  checkFixtureHealth,
  checkProductHttpsHealth,
  privateFile,
  productDirectory,
  productRoot,
  publicAppOrigin,
  readProductConfiguration,
} from './support/s6-github-product.mjs';

// Builds enter through explicit publication or the production webhook dispatcher.
// This probe retains original tasks, failures, receipts and Git history.
const owner = 'ozz-s6-webhook-product-probe-v1';
const directory = resolve(productRoot, '.local/local-lab/s6-webhook');
const parentDirectory = resolve(productRoot, '.local/local-lab/s6-product');
const statePath = resolve(directory, 'state.json');
const { values, positionals } = parseArgs({
  options: { 'retry-deployment': { type: 'string' } },
  allowPositionals: true,
});
const mode = positionals[0];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sha = /^[0-9a-f]{40}$/u;
const attempt = `${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
const attemptDirectory = resolve(directory, attempt);
const abort = new globalThis.AbortController();
const execute = promisify(execFile);
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let configuration,
  parentState,
  state,
  cookie,
  csrf,
  stage = 'preflight';
const locks = [];
const report = {
  version: 2,
  owner,
  attempt,
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: [],
  scope:
    'Real local HTTPS webhook admission, stopped-service pending publication, running-service automatic publication, managed BuildKit/OCI deployment, K3s HTTPS content and duplicate delivery without another build. GitHub-origin delivery is represented by the controlled local provider.',
};

function requireValue(value, code) {
  if (!value) throw new Error(code);
}
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function save() {
  const path = resolve(directory, `.state-${randomUUID()}`);
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(path, statePath);
}

async function evidence(label, value) {
  requireValue(/^[a-z0-9-]+$/u.test(label), 'S6_WEBHOOK_EVIDENCE_LABEL_INVALID');
  const path = resolve(attemptDirectory, `${label}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}

async function diskHeadroom(label, beforeBuild = false) {
  const filesystem = await statfs(productRoot);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  const minimumFreeBytes = 8 * 1024 ** 3;
  const buildReserveBytes = beforeBuild ? 1024 ** 3 : 0;
  await evidence('disk-headroom', { label, availableBytes, minimumFreeBytes, buildReserveBytes });
  requireValue(
    availableBytes >= minimumFreeBytes + buildReserveBytes,
    'S6_WEBHOOK_DISK_HEADROOM_LOW',
  );
}

async function check(name, condition, facts = {}) {
  requireValue(condition, 'S6_WEBHOOK_ASSERTION_FAILED');
  const record = { name, at: new Date().toISOString(), attempt, ...facts };
  report.checks.push(record);
  state.checks.push(record);
  await save();
  console.log(JSON.stringify({ check: name, status: 'passed' }));
}

async function phase(name, work) {
  stage = name;
  if (state.completed[name]) return;
  console.log(JSON.stringify({ stage }));
  await work();
  state.completed[name] = { at: new Date().toISOString(), attempt };
  await save();
}

async function http(path, options = {}) {
  requireValue(path.startsWith('/api/') && !path.startsWith('//'), 'S6_WEBHOOK_API_PATH_INVALID');
  const body =
    options.raw ??
    (options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)));
  const authenticated = options.authenticated !== false;
  const method = options.method ?? 'GET';
  if (stage.startsWith('running-')) {
    const callback = method === 'POST' && !authenticated && path === state.callbackPath;
    requireValue(
      ((method === 'GET' || method === 'HEAD') && body === undefined) || callback,
      'S6_WEBHOOK_RUNNING_MUTATION_FORBIDDEN',
    );
    if (callback) {
      requireValue(
        state.running.sendIntent?.callbackPath === path &&
          Buffer.isBuffer(body) &&
          hash(body) === state.running.payloadHash &&
          options.headers?.['x-github-delivery'] === state.running.externalDeliveryId &&
          options.headers?.['x-github-event'] === 'push' &&
          /^sha256=[0-9a-f]{64}$/u.test(options.headers?.['x-hub-signature-256'] ?? '') &&
          !options.key,
        'S6_WEBHOOK_RUNNING_CALLBACK_IDENTITY_CHANGED',
      );
      state.running.callbackRequests ??= [];
      requireValue(
        state.running.callbackRequests.length < 128,
        'S6_WEBHOOK_RUNNING_CALLBACK_ATTEMPT_LIMIT',
      );
      state.running.callbackRequests.push({
        attempt,
        stage,
        at: new Date().toISOString(),
        method,
        path,
        externalDeliveryId: state.running.externalDeliveryId,
        bodySha256: hash(body),
      });
      await save();
    }
  }
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      publicAppOrigin + path,
      {
        method,
        ca: configuration.ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(30_000)]),
        headers: {
          ...(authenticated
            ? {
                origin: publicAppOrigin,
                ...(cookie ? { cookie } : {}),
                ...(csrf ? { 'x-csrf-token': csrf } : {}),
              }
            : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
          ...(options.key ? { 'idempotency-key': options.key } : {}),
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) response.destroy(new Error('S6_WEBHOOK_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const value = response.statusCode === 204 ? null : JSON.parse(Buffer.concat(chunks));
            accept({ status: response.statusCode, headers: response.headers, value });
          } catch {
            reject(new Error('S6_WEBHOOK_RESPONSE_INVALID'));
          }
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function api(path, options = {}) {
  const response = await http('/api' + path, options);
  if (
    options.expected
      ? response.status !== options.expected
      : response.status < 200 || response.status >= 300
  )
    throw Object.assign(new Error('S6_WEBHOOK_API_FAILED'), {
      code: response.value?.code,
      httpStatus: response.status,
    });
  return response;
}
const data = async (path) => (await api(path)).value.data;

async function list(path, provider = false) {
  const items = [],
    seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const query = [
      ...(provider ? [] : ['limit=100']),
      ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : []),
    ];
    const response = (
      await api(query.length ? `${path}${path.includes('?') ? '&' : '?'}${query.join('&')}` : path)
    ).value;
    requireValue(Array.isArray(response.data), 'S6_WEBHOOK_PAGE_INVALID');
    items.push(...response.data);
    if (!response.page?.hasMore) return items;
    cursor = response.page.nextCursor;
    requireValue(
      typeof cursor === 'string' && cursor && !seen.has(cursor),
      'S6_WEBHOOK_CURSOR_INVALID',
    );
    seen.add(cursor);
  }
  throw new Error('S6_WEBHOOK_PAGE_LIMIT');
}

async function command(label, path, body, type = 'operations') {
  state.commands[label] ??= {
    path,
    body,
    type,
    key: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const intent = state.commands[label];
  requireValue(intent.path === path && intent.type === type, 'S6_WEBHOOK_COMMAND_TARGET_CHANGED');
  await save();
  if (intent.id) return data(`/${type}/${intent.id}`);
  const result = (
    await api(intent.path, { method: 'POST', body: intent.body, key: intent.key, expected: 202 })
  ).value.data;
  requireValue(uuid.test(result.id), 'S6_WEBHOOK_TASK_ID_INVALID');
  intent.id = result.id;
  await save();
  await evidence(`accepted-${label.replaceAll(/[^a-z0-9-]/gu, '-')}`, result);
  return result;
}

async function waitFor(read, accept, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('S6_WEBHOOK_OBSERVATION_TIMEOUT');
}

async function waitTask(type, id) {
  let previous,
    diskCheckedAt = 0;
  return waitFor(
    async () => {
      if (type === 'deployments' && Date.now() - diskCheckedAt >= 30_000) {
        await diskHeadroom('deployment-observation');
        diskCheckedAt = Date.now();
      }
      const task = await data(`/${type}/${id}`);
      const fingerprint = `${task.status}:${task.phase}:${task.errorCode}`;
      if (fingerprint !== previous) {
        console.log(
          JSON.stringify({
            task: id,
            status: task.status,
            phase: task.phase,
            code: task.errorCode,
          }),
        );
        previous = fingerprint;
        await evidence(`task-${id}`, task);
      }
      if (['failed', 'cancelled'].includes(task.status))
        throw Object.assign(new Error('S6_WEBHOOK_TASK_FAILED'), {
          code: task.errorCode,
          taskId: id,
        });
      return task;
    },
    (task) => task.status === 'succeeded',
    1_260_000,
  );
}

async function deployments() {
  const rows = await list(`/deployments?serviceId=${state.serviceId}`);
  requireValue(rows.length <= 64, 'S6_WEBHOOK_DEPLOYMENT_BOUND_EXCEEDED');
  const detailed = [];
  for (const row of rows) detailed.push(await data(`/deployments/${row.id}`));
  return detailed;
}

function inventory(rows) {
  return rows
    .map((row) => ({
      id: row.id,
      status: row.status,
      snapshot: row.snapshot,
      target: row.target,
      errorCode: row.errorCode,
      failureObservation: row.failureObservation,
      runs: (row.build?.runs ?? [])
        .map((run) => ({
          id: run.id,
          executionState: run.executionState,
          executionClosedAt: run.executionClosedAt,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function assertOldDeployments(extraIds = []) {
  const rows = await deployments();
  const old = rows.filter((row) => !extraIds.includes(row.id));
  requireValue(
    isDeepStrictEqual(inventory(old), state.baseline.inventory),
    'S6_WEBHOOK_OLD_DEPLOYMENT_EVIDENCE_CHANGED',
  );
  return rows;
}

const gitEnvironment = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '',
};
async function git(args) {
  return (
    await execute('/usr/bin/git', args, {
      cwd: resolve(productDirectory, 'seed'),
      env: gitEnvironment,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      signal: abort.signal,
    })
  ).stdout.trimEnd();
}
const bareHead = () =>
  git([
    '--git-dir',
    resolve(productDirectory, `repositories/${configuration.metadata.repositoryId}.git`),
    'rev-parse',
    '--verify',
    `refs/heads/${configuration.metadata.branch}`,
  ]);

async function tlsContent(marker, forbiddenMarker) {
  let previous;
  const domain = await waitFor(
    async () => {
      const current = await data(`/domains/${state.domainId}`);
      const fingerprint = JSON.stringify({
        route: current.route?.state,
        certificate: current.certificate?.state,
        notAfter: current.certificate?.notAfter,
        stale: current.observationStale,
      });
      if (fingerprint !== previous) {
        await evidence('https-domain-observation', current);
        previous = fingerprint;
      }
      requireValue(current.hostname === state.hostname, 'S6_WEBHOOK_DOMAIN_IDENTITY_CHANGED');
      return current;
    },
    (current) =>
      current.route?.state === 'ready' &&
      ['staging_ready', 'ready', 'renewing'].includes(current.certificate?.state) &&
      Date.parse(current.certificate.notBefore) <= Date.now() &&
      Date.parse(current.certificate.notAfter) > Date.now() + 25_000 &&
      !current.observationStale,
  );
  const networking = JSON.parse(
    await privateFile(resolve(productRoot, '.local/local-lab/networking-lab'), 'state.json'),
  );
  requireValue(
    networking.owner === 'ozz-local-networking-lab-v1' && networking.ip === '192.168.5.15',
    'S6_WEBHOOK_NETWORK_FIXTURE_CHANGED',
  );
  const program = `import hashlib,http.client,json,socket,ssl,sys\nfrom pathlib import Path\nv=json.load(sys.stdin)\nassert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-b'\nhost=v['hostname']\nassert host.endswith('.apps.ozz.test') and all(c.isalnum() or c in '.-' for c in host)\nassert v['environment'] in ('staging','production') and v['ip']=='192.168.5.15'\nassert len(v['marker'])<=200 and (v['forbiddenMarker'] is None or len(v['forbiddenMarker'])<=200)\ncontext=ssl.create_default_context(cafile='/var/lib/ozz-local-lab/b/networking-v1/'+v['environment']+'-signing-root.pem')\nwith socket.create_connection((v['ip'],443),timeout=8) as raw:\n with context.wrap_socket(raw,server_hostname=host) as stream:\n  fingerprint=hashlib.sha256(stream.getpeercert(binary_form=True)).hexdigest()\n  stream.sendall(('GET / HTTP/1.1\\r\\nHost: '+host+'\\r\\nConnection: close\\r\\n\\r\\n').encode())\n  reply=http.client.HTTPResponse(stream);reply.begin();body=reply.read(65537)\n  assert len(body)<=65536\n  result={'httpsStatus':reply.status,'hostnameVerified':True,'localChainVerified':True,'certificateSha256':fingerprint,'bodySha256':hashlib.sha256(body).hexdigest(),'markerMatched':v['marker'].encode() in body,'forbiddenMarkerAbsent':v['forbiddenMarker'] is None or v['forbiddenMarker'].encode() not in body}\nprint(json.dumps(result))\n`;
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const job = execute(
    'ssh',
    [
      '-F',
      resolve(productRoot, '.local/local-lab/credentials/ssh_config'),
      'ozz-lab-b',
      `sudo python3 -c ${shellQuote(program)}`,
    ],
    {
      cwd: productRoot,
      timeout: 25_000,
      maxBuffer: 16_384,
      signal: abort.signal,
    },
  );
  job.child.stdin.end(
    JSON.stringify({
      hostname: domain.hostname,
      environment: domain.certificateEnvironment,
      ip: networking.ip,
      marker,
      forbiddenMarker: forbiddenMarker ?? null,
    }),
  );
  const actual = JSON.parse((await job).stdout);
  requireValue(
    actual.httpsStatus === 200 &&
      actual.markerMatched &&
      actual.forbiddenMarkerAbsent &&
      actual.localChainVerified &&
      actual.hostnameVerified,
    'S6_WEBHOOK_HTTPS_MARKER_MISMATCH',
  );
  return {
    ...actual,
    hostname: domain.hostname,
    domainId: domain.id,
    certificateObservationState: domain.certificate.state,
    certificateObservedNotAfter: domain.certificate.notAfter,
  };
}

async function assertExclusiveRepository() {
  const shared = (await list('/services')).filter(
    (item) =>
      item.source?.kind === 'github' &&
      item.source.currentRevision.repository.repositoryId === state.repositoryId,
  );
  requireValue(
    shared.length === 1 && shared[0].id === state.serviceId,
    'S6_WEBHOOK_REPOSITORY_HAS_OTHER_SERVICES',
  );
}

async function baseline() {
  const service = await data(`/services/${state.serviceId}`);
  requireValue(
    service.source?.kind === 'github' &&
      service.source.autoDeploy === true &&
      service.desiredState === 'running' &&
      service.runtimeState === 'running' &&
      !service.activeTask &&
      !service.observationStale &&
      service.configurationState === 'consistent' &&
      service.published?.deploymentId === parentState.firstDeploymentId &&
      service.published?.image?.deployReference === parentState.firstImage &&
      service.published?.source?.commitSha === parentState.initialSha &&
      service.source.currentRevision.repository.repositoryId === state.repositoryId &&
      service.source.currentRevision.githubConnectionId === state.githubConnectionId &&
      service.source.currentRevision.branchRef === `refs/heads/${configuration.metadata.branch}`,
    'S6_WEBHOOK_BASELINE_SERVICE_NOT_READY',
  );
  await assertExclusiveRepository();
  const rows = await deployments();
  requireValue(
    rows.length > 0 && rows.every((row) => !['queued', 'running'].includes(row.status)),
    'S6_WEBHOOK_BASELINE_TASKS_ACTIVE',
  );
  const published = rows.find((row) => row.id === parentState.firstDeploymentId);
  requireValue(
    published?.status === 'succeeded' &&
      published.snapshot?.version === 3 &&
      published.snapshot.source?.commitSha === parentState.initialSha &&
      published.snapshot.source.revision.id === service.source.currentRevision.id &&
      published.build?.artifact.state === 'registry' &&
      published.build.artifact.commitSha === parentState.initialSha &&
      published.build.artifact.image?.deployReference === parentState.firstImage &&
      parentState.firstImage.endsWith(`@${published.build.artifact.rootDigest}`),
    'S6_WEBHOOK_BASELINE_SUCCESSFUL_PUBLICATION_CHANGED',
  );
  requireValue(
    (await git(['symbolic-ref', '--short', 'HEAD'])) === configuration.metadata.branch &&
      (await git(['status', '--porcelain'])) === '' &&
      (await git(['rev-parse', 'HEAD'])) === parentState.initialSha &&
      (await bareHead()) === parentState.initialSha,
    'S6_WEBHOOK_GIT_BASELINE_CHANGED',
  );
  const source = await readFile(resolve(productDirectory, 'seed/public/index.html'));
  const actual = await tlsContent(configuration.metadata.marker);
  state.baseline = {
    deploymentId: service.published.deploymentId,
    image: service.published.image.deployReference,
    commitSha: service.published.source.commitSha,
    sourceRevisionId: service.source.currentRevision.id,
    configRevision: service.configRevision,
    policyRevision: service.source.policyRevision,
    target: published.target,
    inventory: inventory(rows),
    marker: configuration.metadata.marker,
    bodySha256: actual.bodySha256,
    sourceHtmlSha256: hash(source),
  };
  try {
    await writeFile(resolve(directory, 'original-index.html'), source, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireValue(
      hash(await privateFile(directory, 'original-index.html')) === hash(source),
      'S6_WEBHOOK_ORIGINAL_SOURCE_CHANGED',
    );
  }
  await save();
  await evidence('baseline', { service, deployments: rows, https: actual });
  await check('published-source-and-https-baseline-retained', true, {
    deploymentId: state.baseline.deploymentId,
    image: state.baseline.image,
    commitSha: state.baseline.commitSha,
  });
}

async function repository() {
  const rows = await list(`/integrations/github/${state.githubConnectionId}/repositories`, true);
  const row = rows.find((item) => item.id === state.repositoryId);
  requireValue(
    row?.githubRepositoryId === configuration.metadata.repositoryId,
    'S6_WEBHOOK_REPOSITORY_IDENTITY_CHANGED',
  );
  return row;
}

async function registerHook() {
  let payload;
  try {
    payload = JSON.parse(await privateFile(directory, 'webhook-secret.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    payload = { secret: randomBytes(32).toString('base64url') };
    await writeFile(resolve(directory, 'webhook-secret.json'), JSON.stringify(payload) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  }
  requireValue(/^[A-Za-z0-9_-]{32,128}$/u.test(payload.secret), 'S6_WEBHOOK_SECRET_INVALID');
  if (!state.webhookSecretRefId) {
    const name = `S6 Webhook ${state.id}`;
    const existing = (await list('/secrets?kind=webhook')).filter((item) => item.name === name);
    requireValue(existing.length <= 1, 'S6_WEBHOOK_SECRET_IDENTITY_AMBIGUOUS');
    const secret =
      existing[0] ??
      (
        await api('/secrets', {
          method: 'POST',
          body: { name, kind: 'webhook', payload },
          expected: 201,
        })
      ).value.data;
    state.webhookSecretRefId = secret.id;
    await save();
  }
  const before = await repository();
  const operation = await command(
    'register-hook',
    `/integrations/github/${state.githubConnectionId}/repositories/${state.repositoryId}/webhook`,
    { revision: before.revision, secretRefId: state.webhookSecretRefId },
  );
  const task = await waitTask('operations', operation.id);
  const current = await repository();
  requireValue(
    current.hook.state === 'registered' &&
      current.hook.operationId === task.id &&
      task.result?.registered === true &&
      current.hook.hookId === task.result.hookId,
    'S6_WEBHOOK_REGISTRATION_NOT_CONFIRMED',
  );
  const callback = new URL(current.hook.callbackUrl);
  requireValue(
    callback.origin === publicAppOrigin &&
      callback.pathname.startsWith(`/api/webhooks/github/${state.repositoryId}/`) &&
      uuid.test(callback.pathname.split('/').at(-1)) &&
      !callback.search &&
      !callback.hash,
    'S6_WEBHOOK_CALLBACK_INVALID',
  );
  const provider = JSON.parse(await privateFile(productDirectory, 'state.json'));
  const actual = provider.repositories
    .find((item) => item.id === configuration.metadata.repositoryId)
    ?.hooks.find((item) => item.id === current.hook.hookId);
  requireValue(
    actual?.active === true &&
      isDeepStrictEqual(actual.events, ['push']) &&
      actual.config?.url === callback.href &&
      actual.config?.insecure_ssl === '0' &&
      actual.secret === payload.secret,
    'S6_WEBHOOK_PROVIDER_REGISTRATION_MISMATCH',
  );
  state.callbackPath = callback.pathname;
  state.hookId = current.hook.hookId;
  await save();
  await evidence('registered-hook', { task, repository: current });
  await check('hook-registered-by-real-product-operation-with-https', true, {
    operationId: task.id,
    hookId: state.hookId,
    callbackOrigin: callback.origin,
  });
}

async function stopService() {
  const service = await data(`/services/${state.serviceId}`);
  const task = await command('stop-service', `/services/${state.serviceId}/stop`, {
    revision: service.revision,
  });
  await waitTask('operations', task.id);
  const stopped = await waitFor(
    () => data(`/services/${state.serviceId}`),
    (value) =>
      value.desiredState === 'stopped' &&
      value.runtimeState === 'stopped' &&
      !value.activeTask &&
      !value.observationStale,
  );
  requireValue(
    stopped.published?.image?.deployReference === state.baseline.image,
    'S6_WEBHOOK_STOP_CHANGED_PUBLISHED_IMAGE',
  );
  await assertOldDeployments();
  await evidence('stopped-service', stopped);
  await check('product-stop-keeps-original-publication', true, {
    operationId: task.id,
    deploymentId: stopped.published.deploymentId,
  });
}

function commitHtml(change) {
  return `<!doctype html>\n<html lang="en"><meta charset="utf-8"><title>Ozz S6 webhook deployment</title><body><main><h1>Ozz S6 webhook deployment</h1><p id="deployment-marker">${change.marker}</p></main></body></html>\n`;
}

async function advanceFixtureCommit(change, previousHtmlSha256, checkName) {
  const html = commitHtml(change);
  requireValue(sha.test(change.beforeSha), 'S6_WEBHOOK_GIT_PARENT_INVALID');
  if (change.htmlSha256)
    requireValue(change.htmlSha256 === hash(html), 'S6_WEBHOOK_GIT_INTENDED_CONTENT_CHANGED');
  change.htmlSha256 = hash(html);
  await save();
  const head = await git(['rev-parse', 'HEAD']);
  requireValue(
    (await git(['symbolic-ref', '--short', 'HEAD'])) === configuration.metadata.branch,
    'S6_WEBHOOK_GIT_BRANCH_CHANGED',
  );
  requireValue(
    (await git(['remote', 'get-url', 'origin'])) ===
      `../repositories/${configuration.metadata.repositoryId}.git`,
    'S6_WEBHOOK_GIT_REMOTE_CHANGED',
  );
  if (!change.commitSha) {
    if (head === change.beforeSha) {
      const dirty = await git(['status', '--porcelain']);
      requireValue(
        !dirty || dirty.split('\n').every((line) => line.slice(3) === 'public/index.html'),
        'S6_WEBHOOK_GIT_WORKTREE_CHANGED',
      );
      const current = await readFile(resolve(productDirectory, 'seed/public/index.html'));
      requireValue(
        hash(current) === previousHtmlSha256 || current.toString('utf8') === html,
        'S6_WEBHOOK_GIT_SOURCE_CHANGED',
      );
      await writeFile(resolve(productDirectory, 'seed/public/index.html'), html, { mode: 0o600 });
      await git(['add', '--', 'public/index.html']);
      requireValue(
        (await git(['diff', '--cached', '--name-only'])) === 'public/index.html',
        'S6_WEBHOOK_GIT_INDEX_CHANGED',
      );
      await git([
        '-c',
        'user.name=Ozz fixture',
        '-c',
        'user.email=fixture@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        change.message,
      ]);
      change.commitSha = await git(['rev-parse', 'HEAD']);
    } else {
      requireValue(
        (await git(['show', '-s', '--format=%P', 'HEAD'])) === change.beforeSha &&
          (await git(['show', '-s', '--format=%s', 'HEAD'])) === change.message &&
          (await git(['show', 'HEAD:public/index.html'])) === html.trim(),
        'S6_WEBHOOK_GIT_HEAD_CHANGED',
      );
      change.commitSha = head;
    }
    requireValue(
      sha.test(change.commitSha) && change.commitSha !== change.beforeSha,
      'S6_WEBHOOK_NEW_COMMIT_INVALID',
    );
    await save();
  }
  requireValue(
    (await git(['rev-parse', 'HEAD'])) === change.commitSha &&
      (await git(['status', '--porcelain'])) === '' &&
      (await git(['show', '-s', '--format=%P', 'HEAD'])) === change.beforeSha &&
      (await git(['show', '-s', '--format=%s', 'HEAD'])) === change.message &&
      (await git(['show', 'HEAD:public/index.html'])) === html.trim() &&
      (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])) ===
        'public/index.html',
    'S6_WEBHOOK_GIT_COMMIT_CHANGED',
  );
  const remote = await bareHead();
  requireValue(
    [change.beforeSha, change.commitSha].includes(remote),
    'S6_WEBHOOK_GIT_REMOTE_HEAD_CHANGED',
  );
  if (remote !== change.commitSha)
    await git([
      'push',
      'origin',
      `refs/heads/${configuration.metadata.branch}:refs/heads/${configuration.metadata.branch}`,
    ]);
  requireValue((await bareHead()) === change.commitSha, 'S6_WEBHOOK_GIT_PUSH_NOT_CONFIRMED');
  await check(checkName, true, {
    beforeSha: change.beforeSha,
    commitSha: change.commitSha,
    marker: change.marker,
    htmlSha256: change.htmlSha256,
  });
}

async function advanceCommit() {
  state.git ??= {
    marker: `ozz-s6-webhook-${state.id}`,
    message: `fixture: webhook publication ${state.id}`,
    beforeSha: state.baseline.commitSha,
  };
  await advanceFixtureCommit(
    state.git,
    state.baseline.sourceHtmlSha256,
    'real-fixture-git-history-advanced-without-replacing-old-commit',
  );
}

async function target(deliveryId = state.deliveryId) {
  requireValue(uuid.test(deliveryId), 'S6_WEBHOOK_DELIVERY_ID_INVALID');
  const items = await list(`/webhook-deliveries/${deliveryId}/targets`);
  const owned = items.filter((item) => item.serviceId === state.serviceId);
  if (items.length !== 1 || owned.length !== 1)
    await evidence('unexpected-webhook-targets', { deliveryId, items });
  requireValue(items.length === 1 && owned.length === 1, 'S6_WEBHOOK_TARGET_COUNT_CHANGED');
  requireValue(owned[0].webhookDeliveryId === deliveryId, 'S6_WEBHOOK_TARGET_DELIVERY_CHANGED');
  return owned[0];
}

function webhookBody(change) {
  return Buffer.from(
    JSON.stringify({
      ref: `refs/heads/${configuration.metadata.branch}`,
      before: change.beforeSha,
      after: change.commitSha,
      deleted: false,
      forced: false,
      repository: {
        id: Number(configuration.metadata.repositoryId),
        full_name: configuration.metadata.fullName,
      },
      pusher: { name: 'ozz-local-fixture' },
      head_commit: { id: change.commitSha, message: change.message },
    }),
  );
}

async function signedHeaders(externalDeliveryId, body) {
  const payload = JSON.parse(await privateFile(directory, 'webhook-secret.json'));
  requireValue(/^[A-Za-z0-9_-]{32,128}$/u.test(payload.secret), 'S6_WEBHOOK_SECRET_INVALID');
  return {
    'x-github-delivery': externalDeliveryId,
    'x-github-event': 'push',
    'x-hub-signature-256': `sha256=${createHmac('sha256', payload.secret).update(body).digest('hex')}`,
  };
}

async function deliverWebhook() {
  state.externalDeliveryId ??= `s6-webhook-${state.id}`;
  const body = webhookBody(state.git);
  if (state.payloadHash)
    requireValue(state.payloadHash === hash(body), 'S6_WEBHOOK_REPLAY_BODY_CHANGED');
  state.payloadHash = hash(body);
  await save();
  await evidence('webhook-payload', JSON.parse(body));
  let headers = { 'x-github-delivery': state.externalDeliveryId, 'x-github-event': 'push' };
  if (!state.forgeryRejected) {
    const before = (await list(`/webhook-deliveries?repositoryId=${state.repositoryId}`)).filter(
      (item) => item.externalDeliveryId === state.externalDeliveryId,
    );
    requireValue(before.length === 0, 'S6_WEBHOOK_DELIVERY_ALREADY_EXISTS_BEFORE_FORGERY');
    const forged = await http(state.callbackPath, {
      method: 'POST',
      raw: body,
      authenticated: false,
      headers: { ...headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
    });
    await evidence('forged-rejection', { status: forged.status, value: forged.value });
    requireValue(
      forged.status === 401 && forged.value?.code === 'WEBHOOK_SIGNATURE_INVALID',
      'S6_WEBHOOK_FORGERY_NOT_REJECTED',
    );
    const after = (await list(`/webhook-deliveries?repositoryId=${state.repositoryId}`)).filter(
      (item) => item.externalDeliveryId === state.externalDeliveryId,
    );
    requireValue(after.length === 0, 'S6_WEBHOOK_FORGERY_RESERVED_DELIVERY_ID');
    state.forgeryRejected = true;
    await save();
    await check('forged-signature-rejected-without-reserving-delivery-id', true, {
      status: forged.status,
      externalDeliveryId: state.externalDeliveryId,
    });
  }
  headers = await signedHeaders(state.externalDeliveryId, body);
  const first = await http(state.callbackPath, {
    method: 'POST',
    raw: body,
    authenticated: false,
    headers,
  });
  await evidence('signed-receipt', { status: first.status, receipt: first.value });
  requireValue(
    ((first.status === 202 && first.value.duplicate === false) ||
      (first.status === 200 && first.value.duplicate === true)) &&
      first.value.targetCount === 1 &&
      uuid.test(first.value.deliveryId),
    'S6_WEBHOOK_SIGNED_RECEIPT_INVALID',
  );
  if (state.deliveryId)
    requireValue(state.deliveryId === first.value.deliveryId, 'S6_WEBHOOK_RECEIPT_ID_CHANGED');
  state.deliveryId = first.value.deliveryId;
  await save();
  const beforeDuplicate = await data(`/webhook-deliveries/${state.deliveryId}`);
  const duplicate = await http(state.callbackPath, {
    method: 'POST',
    raw: body,
    authenticated: false,
    headers,
  });
  const delivered = await data(`/webhook-deliveries/${state.deliveryId}`);
  requireValue(
    duplicate.status === 200 &&
      duplicate.value.duplicate === true &&
      duplicate.value.deliveryId === state.deliveryId &&
      duplicate.value.targetCount === 1 &&
      delivered.duplicateCount === beforeDuplicate.duplicateCount + 1,
    'S6_WEBHOOK_DUPLICATE_NOT_DEDUPLICATED',
  );
  const pending = await target();
  requireValue(
    pending.commitSha === state.git.commitSha &&
      pending.currentServiceId === state.serviceId &&
      pending.sourceRevisionId === state.baseline.sourceRevisionId &&
      pending.configRevisionAtReceipt === state.baseline.configRevision &&
      pending.policyRevisionAtReceipt === state.baseline.policyRevision &&
      isDeepStrictEqual(pending.target, state.baseline.target),
    'S6_WEBHOOK_RECEIPT_TARGET_IDENTITY_CHANGED',
  );
  state.webhookTargetId = pending.id;
  await save();
  await evidence('duplicate-and-target', { receipt: duplicate.value, delivered, pending });
  await check('signed-delivery-and-valid-replay-share-one-durable-target', true, {
    firstStatus: first.status,
    duplicateStatus: duplicate.status,
    deliveryId: state.deliveryId,
    webhookTargetId: pending.id,
  });
}

async function stablePending(desiredState) {
  const deadline = Date.now() + 6500;
  let sample = 0;
  do {
    const service = await data(`/services/${state.serviceId}`);
    const pending = await target();
    requireValue(
      service.desiredState === desiredState &&
        service.runtimeState === desiredState &&
        !service.activeTask &&
        !service.observationStale &&
        service.published?.deploymentId === state.baseline.deploymentId &&
        service.published?.image?.deployReference === state.baseline.image &&
        pending.id === state.webhookTargetId &&
        pending.state === 'pending' &&
        pending.reason === 'service_stopped' &&
        pending.manualRequired === true &&
        pending.canPreview === true &&
        pending.deploymentId === null,
      'S6_WEBHOOK_PENDING_STATE_CHANGED',
    );
    await assertOldDeployments();
    await evidence(`pending-${desiredState}-sample-${sample++}`, { service, pending });
    await delay(1500, undefined, { signal: abort.signal });
  } while (Date.now() < deadline);
  await check(`pending-remains-manual-while-${desiredState}`, true, {
    samples: sample,
    observedForAtLeastMs: 6500,
    webhookTargetId: state.webhookTargetId,
  });
}

async function resumeService() {
  const service = await data(`/services/${state.serviceId}`);
  const accepted = await command('resume-service', `/services/${state.serviceId}/resume`, {
    revision: service.revision,
  });
  const task = await waitTask('operations', accepted.id);
  const resumed = await waitFor(
    () => data(`/services/${state.serviceId}`),
    (value) =>
      value.desiredState === 'running' &&
      value.runtimeState === 'running' &&
      !value.activeTask &&
      !value.observationStale,
  );
  requireValue(
    task.kind === 'service_resume' &&
      task.input?.snapshotId === state.baseline.deploymentId &&
      resumed.published?.deploymentId === state.baseline.deploymentId &&
      resumed.published?.image?.deployReference === state.baseline.image,
    'S6_WEBHOOK_RESUME_REBUILT_OR_CHANGED_PUBLICATION',
  );
  await assertOldDeployments();
  const actual = await tlsContent(state.baseline.marker, state.git.marker);
  requireValue(
    actual.bodySha256 === state.baseline.bodySha256,
    'S6_WEBHOOK_RESUME_CONTENT_CHANGED',
  );
  await evidence('resumed-old-publication', { task, service: resumed, https: actual });
  await check('resume-reuses-original-digest-and-https-content', true, {
    operationId: task.id,
    image: state.baseline.image,
    ...actual,
  });
}

async function publishPending() {
  if (!state.originalDeploymentId) {
    if (!state.commands['publish-pending']) {
      const service = await data(`/services/${state.serviceId}`);
      const preview = (
        await api(`/services/${state.serviceId}/git-source/preview`, {
          method: 'POST',
          body: {
            revision: service.revision,
            selection: { kind: 'pending_target', webhookTargetId: state.webhookTargetId },
          },
          expected: 200,
        })
      ).value.data;
      requireValue(
        preview.webhookTargetId === state.webhookTargetId &&
          preview.source?.commitSha === state.git.commitSha &&
          preview.source.revision.id === state.baseline.sourceRevisionId &&
          preview.issues.length === 0 &&
          preview.desiredState === 'running' &&
          isDeepStrictEqual(preview.configuration, service.configuration) &&
          isDeepStrictEqual(preview.target, state.baseline.target),
        'S6_WEBHOOK_PENDING_PREVIEW_CHANGED',
      );
      state.previewId = preview.id;
      state.previewRevision = preview.serviceRevision;
      await save();
      await evidence('pending-preview', preview);
      await check('explicit-preview-pins-pending-sha-and-current-runtime', true, {
        previewId: preview.id,
        webhookTargetId: preview.webhookTargetId,
        commitSha: preview.source.commitSha,
      });
    }
    if (!state.commands['publish-pending']?.id) await diskHeadroom('manual-publication', true);
    const accepted = await command(
      'publish-pending',
      `/services/${state.serviceId}/deployments`,
      { revision: state.previewRevision, previewId: state.previewId },
      'deployments',
    );
    state.originalDeploymentId = accepted.id;
    state.currentDeploymentId = accepted.id;
    await save();
  }
  if (values['retry-deployment']) {
    const requested = values['retry-deployment'];
    const savedRetry = state.commands[`retry-${requested}`];
    if (savedRetry?.id) state.currentDeploymentId = savedRetry.id;
    else {
      requireValue(requested === state.currentDeploymentId, 'S6_WEBHOOK_RETRY_NOT_CURRENT_TASK');
      const failed = await data(`/deployments/${requested}`);
      await evidence('retained-failed-deployment-before-retry', failed);
      requireValue(
        failed.status === 'failed' &&
          (failed.build?.runs ?? []).every((run) => run.executionClosedAt !== null),
        'S6_WEBHOOK_RETRY_REQUIRES_CLOSED_FAILURE',
      );
      const service = await data(`/services/${state.serviceId}`);
      await diskHeadroom('manual-publication-retry', true);
      const retried = await command(
        `retry-${requested}`,
        `/deployments/${requested}/retry`,
        { revision: service.revision },
        'deployments',
      );
      requireValue(retried.retryOfId === requested, 'S6_WEBHOOK_RETRY_LINEAGE_INVALID');
      state.currentDeploymentId = retried.id;
    }
    await save();
  }
  const task = await waitTask('deployments', state.currentDeploymentId);
  const original = await data(`/deployments/${state.originalDeploymentId}`);
  const service = await waitFor(
    () => data(`/services/${state.serviceId}`),
    (value) =>
      value.runtimeState === 'running' &&
      value.published?.deploymentId === task.id &&
      !value.activeTask &&
      !value.observationStale,
  );
  const admitted = await target();
  requireValue(
    original.initiatorKind === 'admin' &&
      original.webhookTargetId === state.webhookTargetId &&
      original.webhookDeliveryId === state.deliveryId &&
      admitted.state === 'enqueued' &&
      admitted.reason === 'manual_publication' &&
      admitted.deploymentId === state.originalDeploymentId &&
      task.snapshot?.version === 3 &&
      task.snapshot.source.commitSha === state.git.commitSha &&
      task.build?.artifact.state === 'registry' &&
      task.build.artifact.commitSha === state.git.commitSha &&
      task.build.artifact.image?.deployReference === service.published.image?.deployReference &&
      service.published.source.commitSha === state.git.commitSha &&
      service.published.image.deployReference !== state.baseline.image,
    'S6_WEBHOOK_MANUAL_PUBLICATION_LINKAGE_INVALID',
  );
  const newIds = Object.values(state.commands)
    .filter((intent) => intent.type === 'deployments' && intent.id)
    .map((intent) => intent.id);
  const rows = await assertOldDeployments(newIds);
  requireValue(
    rows.length === state.baseline.inventory.length + new Set(newIds).size,
    'S6_WEBHOOK_UNEXPECTED_DEPLOYMENT_CREATED',
  );
  const newTasks = rows.filter((row) => newIds.includes(row.id));
  const runs = newTasks.flatMap((row) => row.build?.runs ?? []);
  requireValue(
    runs.length > 0 &&
      runs.every(
        (run) => run.executionClosedAt && ['ended', 'never_submitted'].includes(run.executionState),
      ) &&
      runs.some(
        (run) =>
          run.id === task.build.artifact.producedByRunId &&
          run.executionState === 'ended' &&
          run.proofVerifiedAt &&
          run.submissionAttemptedAt,
      ),
    'S6_WEBHOOK_BUILD_RUN_PROOF_MISSING',
  );
  state.image = service.published.image.deployReference;
  await save();
  await evidence('explicit-publication', {
    task,
    original,
    service,
    target: admitted,
    builds: newTasks.map((row) => ({ deploymentId: row.id, build: row.build })),
  });
  await check('explicit-pending-publication-registers-build-and-preserves-receipt-linkage', true, {
    originalDeploymentId: original.id,
    deploymentId: task.id,
    webhookTargetId: admitted.id,
    commitSha: state.git.commitSha,
    image: state.image,
    buildRunIds: runs.map((run) => run.id),
  });
}

function runningServiceMatches(service, publication, fixed = state.running.baseline) {
  return (
    service.id === state.serviceId &&
    service.source?.kind === 'github' &&
    service.source.autoDeploy === true &&
    service.source.policyRevision === fixed.policyRevision &&
    isDeepStrictEqual(service.source.currentRevision, fixed.sourceRevision) &&
    service.configRevision === fixed.configRevision &&
    isDeepStrictEqual(service.configuration, fixed.configuration) &&
    service.configurationState === 'consistent' &&
    !service.hasUnpublishedChanges &&
    service.desiredState === 'running' &&
    service.runtimeState === 'running' &&
    !service.activeTask &&
    !service.observationStale &&
    service.published?.deploymentId === publication.deploymentId &&
    service.published.image?.deployReference === publication.image &&
    service.published.source?.commitSha === publication.commitSha &&
    isDeepStrictEqual(service.published.source.revision, fixed.sourceRevision) &&
    service.published.configRevision === fixed.configRevision &&
    isDeepStrictEqual(service.published.configuration, fixed.configuration)
  );
}

async function runningBaseline() {
  state.running ??= { version: 1 };
  requireValue(state.running.version === 1, 'S6_WEBHOOK_RUNNING_STATE_VERSION_INVALID');
  const service = await data(`/services/${state.serviceId}`);
  await assertExclusiveRepository();
  const manualIds = Object.values(state.commands)
    .filter((intent) => intent.type === 'deployments' && intent.id)
    .map((intent) => intent.id);
  const rows = await assertOldDeployments(manualIds);
  const published = rows.find((row) => row.id === state.currentDeploymentId);
  await evidence('running-baseline-publication', { service, deployments: rows });
  requireValue(
    published?.status === 'succeeded' &&
      published.snapshot?.version === 3 &&
      published.snapshot.source?.commitSha === state.git.commitSha &&
      published.build?.artifact.state === 'registry' &&
      published.build.artifact.image?.deployReference === state.image &&
      rows.every(
        (row) =>
          ['succeeded', 'failed', 'cancelled'].includes(row.status) &&
          (row.build?.runs ?? []).every(
            (run) =>
              run.executionClosedAt && ['ended', 'never_submitted'].includes(run.executionState),
          ),
      ) &&
      rows.length === state.baseline.inventory.length + new Set(manualIds).size,
    'S6_WEBHOOK_RUNNING_BASELINE_PUBLICATION_NOT_READY',
  );
  requireValue(
    (await git(['symbolic-ref', '--short', 'HEAD'])) === configuration.metadata.branch &&
      (await git(['status', '--porcelain'])) === '' &&
      (await git(['rev-parse', 'HEAD'])) === state.git.commitSha &&
      (await bareHead()) === state.git.commitSha,
    'S6_WEBHOOK_RUNNING_GIT_BASELINE_CHANGED',
  );
  const source = await readFile(resolve(productDirectory, 'seed/public/index.html'));
  const actual = await tlsContent(state.git.marker, state.baseline.marker);
  requireValue(
    hash(source) === hash(commitHtml(state.git)) && actual.bodySha256 === hash(source),
    'S6_WEBHOOK_RUNNING_BASELINE_CONTENT_CHANGED',
  );
  const fixed = {
    deploymentId: state.currentDeploymentId,
    image: state.image,
    rootDigest: published.build.artifact.rootDigest,
    commitSha: state.git.commitSha,
    sourceRevisionId: published.snapshot.source.revision.id,
    sourceRevision: published.snapshot.source.revision,
    configRevision: published.snapshot.configRevision,
    configuration: published.snapshot.configuration,
    policyRevision: service.source.policyRevision,
    target: published.target,
    inventory: inventory(rows),
    manualCommandsSha256: hash(JSON.stringify(state.commands)),
    marker: state.git.marker,
    bodySha256: actual.bodySha256,
    sourceHtmlSha256: hash(source),
  };
  requireValue(
    runningServiceMatches(service, fixed, fixed) &&
      fixed.sourceRevision.repository.repositoryId === state.repositoryId &&
      fixed.sourceRevision.githubConnectionId === state.githubConnectionId &&
      fixed.sourceRevision.branchRef === `refs/heads/${configuration.metadata.branch}` &&
      isDeepStrictEqual(fixed.target, state.baseline.target),
    'S6_WEBHOOK_RUNNING_BASELINE_SERVICE_NOT_READY',
  );
  if (state.running.baseline)
    requireValue(
      isDeepStrictEqual(state.running.baseline, fixed),
      'S6_WEBHOOK_RUNNING_BASELINE_CHANGED',
    );
  state.running.baseline = fixed;
  await save();
  await evidence('running-baseline', { baseline: fixed, https: actual });
  await check('running-automatic-sequence-starts-from-confirmed-pending-publication', true, {
    deploymentId: fixed.deploymentId,
    image: fixed.image,
    commitSha: fixed.commitSha,
    retainedDeploymentCount: rows.length,
  });
}

async function runningInventory() {
  const rows = await deployments();
  const previous = rows.filter((row) => row.id !== state.running.deploymentId);
  if (!isDeepStrictEqual(inventory(previous), state.running.baseline.inventory))
    await evidence('running-unexpected-deployments', rows);
  requireValue(
    isDeepStrictEqual(inventory(previous), state.running.baseline.inventory) &&
      rows.length ===
        state.running.baseline.inventory.length + (state.running.deploymentId ? 1 : 0),
    'S6_WEBHOOK_RUNNING_DEPLOYMENT_INVENTORY_CHANGED',
  );
  requireValue(
    hash(JSON.stringify(state.commands)) === state.running.baseline.manualCommandsSha256,
    'S6_WEBHOOK_RUNNING_MANUAL_COMMAND_CREATED',
  );
  return rows;
}

async function assertRunningBeforeReceipt() {
  const service = await data(`/services/${state.serviceId}`);
  await evidence('running-before-delivery-service', service);
  requireValue(
    runningServiceMatches(service, state.running.baseline),
    'S6_WEBHOOK_RUNNING_SERVICE_CHANGED_BEFORE_DELIVERY',
  );
  await assertExclusiveRepository();
  await runningInventory();
}

async function advanceRunningCommit() {
  await assertRunningBeforeReceipt();
  state.running.git ??= {
    marker: `ozz-s6-webhook-running-${state.id}`,
    message: `fixture: automatic webhook publication ${state.id}`,
    beforeSha: state.running.baseline.commitSha,
  };
  requireValue(
    state.running.git.beforeSha === state.running.baseline.commitSha &&
      state.running.git.marker !== state.git.marker,
    'S6_WEBHOOK_RUNNING_GIT_INTENT_CHANGED',
  );
  await advanceFixtureCommit(
    state.running.git,
    state.running.baseline.sourceHtmlSha256,
    'running-service-receives-another-real-git-commit-and-push',
  );
}

function runningBody() {
  const body = webhookBody(state.running.git);
  if (state.running.payloadHash)
    requireValue(
      state.running.payloadHash === hash(body),
      'S6_WEBHOOK_RUNNING_REPLAY_BODY_CHANGED',
    );
  state.running.payloadHash = hash(body);
  return body;
}

function assertRunningDelivery(delivery) {
  requireValue(
    delivery.id === state.running.deliveryId &&
      delivery.provider === 'github' &&
      delivery.externalDeliveryId === state.running.externalDeliveryId &&
      delivery.repositoryId === state.repositoryId &&
      delivery.githubRepositoryId === configuration.metadata.repositoryId &&
      delivery.event === 'push' &&
      delivery.ref === `refs/heads/${configuration.metadata.branch}` &&
      delivery.afterSha === state.running.git.commitSha &&
      delivery.state === 'received' &&
      delivery.reason === null &&
      Number.isSafeInteger(delivery.duplicateCount) &&
      delivery.duplicateCount >= 0,
    'S6_WEBHOOK_RUNNING_DELIVERY_IDENTITY_CHANGED',
  );
}

async function runningTarget() {
  const current = await target(state.running.deliveryId);
  if (!isDeepStrictEqual(current, state.running.lastTarget)) {
    await evidence('running-target-transition', current);
    state.running.lastTarget = current;
    await save();
  }
  requireValue(
    uuid.test(current.id) &&
      (!state.running.webhookTargetId || current.id === state.running.webhookTargetId),
    'S6_WEBHOOK_RUNNING_TARGET_ID_CHANGED',
  );
  state.running.webhookTargetId = current.id;
  if (current.deploymentId) {
    requireValue(
      uuid.test(current.deploymentId) &&
        (!state.running.deploymentId || current.deploymentId === state.running.deploymentId),
      'S6_WEBHOOK_RUNNING_DEPLOYMENT_ID_CHANGED',
    );
    state.running.deploymentId = current.deploymentId;
  }
  await save();
  requireValue(
    current.currentServiceId === state.serviceId &&
      current.webhookDeliveryId === state.running.deliveryId &&
      current.commitSha === state.running.git.commitSha &&
      current.sourceRevisionId === state.running.baseline.sourceRevisionId &&
      current.configRevisionAtReceipt === state.running.baseline.configRevision &&
      current.policyRevisionAtReceipt === state.running.baseline.policyRevision &&
      isDeepStrictEqual(current.target, state.running.baseline.target),
    'S6_WEBHOOK_RUNNING_TARGET_IDENTITY_CHANGED',
  );
  requireValue(
    current.manualRequired === false &&
      ((current.state === 'waiting' &&
        ['ready', 'service_busy', 'queue_capacity'].includes(current.reason) &&
        current.deploymentId === null &&
        !state.running.deploymentId) ||
        (current.state === 'enqueued' &&
          current.reason === 'automatic_publication' &&
          current.deploymentId === state.running.deploymentId &&
          current.admittedAt &&
          current.canPreview === false)),
    'S6_WEBHOOK_RUNNING_TARGET_NOT_AUTOMATIC',
  );
  return current;
}

async function deliverRunningWebhook() {
  state.running.externalDeliveryId ??= `s6-webhook-running-${state.id}`;
  const body = runningBody();
  await save();
  await evidence('running-webhook-payload', JSON.parse(body));
  const existing = (await list(`/webhook-deliveries?repositoryId=${state.repositoryId}`)).filter(
    (item) => item.externalDeliveryId === state.running.externalDeliveryId,
  );
  requireValue(existing.length <= 1, 'S6_WEBHOOK_RUNNING_DELIVERY_AMBIGUOUS');
  if (!state.running.sendIntent) {
    requireValue(existing.length === 0, 'S6_WEBHOOK_RUNNING_DELIVERY_EXISTS_BEFORE_INTENT');
    await assertRunningBeforeReceipt();
    state.running.sendIntent = {
      attempt,
      at: new Date().toISOString(),
      callbackPath: state.callbackPath,
      externalDeliveryId: state.running.externalDeliveryId,
      bodySha256: state.running.payloadHash,
    };
    await save();
  } else if (!existing.length) {
    requireValue(!state.running.deliveryId, 'S6_WEBHOOK_RUNNING_SAVED_DELIVERY_MISSING');
    await assertRunningBeforeReceipt();
  }
  if (!existing.length) await diskHeadroom('automatic-webhook-publication', true);
  requireValue(
    state.running.sendIntent.callbackPath === state.callbackPath &&
      state.running.sendIntent.externalDeliveryId === state.running.externalDeliveryId &&
      state.running.sendIntent.bodySha256 === hash(body),
    'S6_WEBHOOK_RUNNING_DELIVERY_INTENT_CHANGED',
  );
  requireValue(
    (await git(['symbolic-ref', '--short', 'HEAD'])) === configuration.metadata.branch &&
      (await git(['status', '--porcelain'])) === '' &&
      (await git(['rev-parse', 'HEAD'])) === state.running.git.commitSha &&
      (await bareHead()) === state.running.git.commitSha,
    'S6_WEBHOOK_RUNNING_PUSH_CHANGED_BEFORE_DELIVERY',
  );
  if (existing.length) {
    requireValue(
      !state.running.deliveryId || state.running.deliveryId === existing[0].id,
      'S6_WEBHOOK_RUNNING_RECEIPT_ID_CHANGED',
    );
    state.running.deliveryId = existing[0].id;
    await save();
    assertRunningDelivery(existing[0]);
  }
  // Persisted intent and identical bytes allow a lost response to be recovered as a replay.
  const receipt = await http(state.callbackPath, {
    method: 'POST',
    raw: body,
    authenticated: false,
    headers: await signedHeaders(state.running.externalDeliveryId, body),
  });
  await evidence('running-signed-receipt', { status: receipt.status, receipt: receipt.value });
  requireValue(
    ((receipt.status === 202 && receipt.value?.duplicate === false) ||
      (receipt.status === 200 && receipt.value?.duplicate === true)) &&
      receipt.value.targetCount === 1 &&
      uuid.test(receipt.value.deliveryId) &&
      (!state.running.deliveryId || state.running.deliveryId === receipt.value.deliveryId),
    'S6_WEBHOOK_RUNNING_SIGNED_RECEIPT_INVALID',
  );
  state.running.deliveryId = receipt.value.deliveryId;
  await save();
  const delivery = await data(`/webhook-deliveries/${state.running.deliveryId}`);
  await evidence('running-durable-receipt', delivery);
  assertRunningDelivery(delivery);
  const current = await runningTarget();
  await check('running-signed-push-has-one-automatic-target', true, {
    deliveryId: delivery.id,
    webhookTargetId: current.id,
    commitSha: current.commitSha,
    state: current.state,
    resumedAsDuplicate: receipt.value.duplicate,
  });
}

function assertAutomaticDeployment(task) {
  const fixed = state.running.baseline;
  requireValue(
    task.id === state.running.deploymentId &&
      task.serviceId === state.serviceId &&
      task.kind === 'git_deploy' &&
      task.initiatorKind === 'webhook' &&
      task.webhookDeliveryId === state.running.deliveryId &&
      task.webhookTargetId === state.running.webhookTargetId &&
      task.retryOfId === null &&
      task.reuseArtifactId === null &&
      task.sourceRevisionId === fixed.sourceRevisionId &&
      task.snapshot?.version === 3 &&
      task.snapshot.source?.kind === 'github' &&
      task.snapshot.source.commitSha === state.running.git.commitSha &&
      isDeepStrictEqual(task.snapshot.source.revision, fixed.sourceRevision) &&
      task.snapshot.configRevision === fixed.configRevision &&
      isDeepStrictEqual(task.snapshot.configuration, fixed.configuration) &&
      isDeepStrictEqual(task.target, fixed.target),
    'S6_WEBHOOK_RUNNING_AUTOMATIC_DEPLOYMENT_LINKAGE_INVALID',
  );
}

function assertAutomaticBuild(task) {
  const artifact = task.build?.artifact;
  const fixed = state.running.baseline.sourceRevision;
  requireValue(
    artifact?.state === 'registry' &&
      uuid.test(artifact.id) &&
      task.artifactId === artifact.id &&
      task.build.sourceRevisionId === fixed.id &&
      task.build.reuseArtifactId === null &&
      artifact.sourceRevisionId === fixed.id &&
      artifact.commitSha === state.running.git.commitSha &&
      artifact.recipeHash === fixed.recipeHash &&
      artifact.registryConnectionId === fixed.destination.registryConnectionId &&
      isDeepStrictEqual(artifact.destination, fixed.destination) &&
      /^sha256:[0-9a-f]{64}$/u.test(artifact.rootDigest) &&
      artifact.rootDigest !== state.running.baseline.rootDigest &&
      artifact.image?.manifestDigest === artifact.rootDigest &&
      artifact.image.deployReference ===
        `${fixed.destination.authority}/${fixed.destination.repository}@${artifact.rootDigest}` &&
      artifact.image.deployReference !== state.running.baseline.image &&
      artifact.availability === 'available' &&
      artifact.pushedAt &&
      artifact.lastVerifiedAt,
    'S6_WEBHOOK_RUNNING_REGISTRY_ARTIFACT_INVALID',
  );
  const runs = task.build.runs;
  requireValue(
    runs.length > 0 &&
      runs.every(
        (run) =>
          uuid.test(run.id) &&
          run.builderId === fixed.builder.builderId &&
          run.builderInstanceId === fixed.builder.instanceId &&
          /^[0-9a-f]{64}$/u.test(run.specHash) &&
          run.executionClosedAt &&
          ['ended', 'never_submitted'].includes(run.executionState),
      ) &&
      runs.some(
        (run) =>
          run.id === artifact.producedByRunId &&
          run.executionState === 'ended' &&
          run.submissionAttemptedAt &&
          run.proofVerifiedAt,
      ),
    'S6_WEBHOOK_RUNNING_BUILD_RUN_PROOF_MISSING',
  );
  return artifact;
}

async function automaticPublication() {
  const admitted = await waitFor(runningTarget, (current) => current.state === 'enqueued');
  const accepted = await data(`/deployments/${state.running.deploymentId}`);
  await evidence('running-automatic-admission', { target: admitted, deployment: accepted });
  assertAutomaticDeployment(accepted);
  await runningInventory();
  const task = await waitTask('deployments', state.running.deploymentId);
  await evidence('running-automatic-build', task);
  assertAutomaticDeployment(task);
  const artifact = assertAutomaticBuild(task);
  const publication = {
    deploymentId: task.id,
    image: artifact.image.deployReference,
    commitSha: state.running.git.commitSha,
  };
  const service = await waitFor(
    () => data(`/services/${state.serviceId}`),
    (current) => runningServiceMatches(current, publication),
  );
  const current = await runningTarget();
  const rows = await runningInventory();
  const terminal = rows.find((row) => row.id === task.id);
  requireValue(terminal?.status === 'succeeded', 'S6_WEBHOOK_RUNNING_SUCCESS_CHANGED');
  assertAutomaticDeployment(terminal);
  assertAutomaticBuild(terminal);
  if (state.running.successInventory)
    requireValue(
      isDeepStrictEqual(state.running.successInventory, inventory(rows)),
      'S6_WEBHOOK_RUNNING_TERMINAL_INVENTORY_CHANGED',
    );
  state.running.image = publication.image;
  state.running.rootDigest = artifact.rootDigest;
  state.running.artifactId = artifact.id;
  state.running.buildRunIds = terminal.build.runs.map((run) => run.id).sort();
  state.running.successInventory = inventory(rows);
  await save();
  await evidence('running-automatic-publication', { task: terminal, service, target: current });
  await check('running-webhook-automatically-builds-and-publishes-a-new-digest', true, {
    deliveryId: state.running.deliveryId,
    webhookTargetId: current.id,
    deploymentId: task.id,
    initiatorKind: task.initiatorKind,
    commitSha: state.running.git.commitSha,
    image: state.running.image,
    artifactId: artifact.id,
    producedByRunId: artifact.producedByRunId,
    buildRunIds: state.running.buildRunIds,
    retainedDeploymentCount: state.running.baseline.inventory.length,
    addedDeploymentCount: 1,
    manualCommandCountAdded: 0,
  });
}

async function runningPublicationObservation() {
  const service = await data(`/services/${state.serviceId}`);
  const current = await runningTarget();
  const rows = await runningInventory();
  await evidence('running-publication-observation', {
    service,
    target: current,
    deployments: rows,
  });
  requireValue(
    runningServiceMatches(service, {
      deploymentId: state.running.deploymentId,
      image: state.running.image,
      commitSha: state.running.git.commitSha,
    }) && isDeepStrictEqual(inventory(rows), state.running.successInventory),
    'S6_WEBHOOK_RUNNING_PUBLICATION_CHANGED',
  );
  const task = rows.find((row) => row.id === state.running.deploymentId);
  assertAutomaticDeployment(task);
  const artifact = assertAutomaticBuild(task);
  requireValue(
    artifact.id === state.running.artifactId &&
      artifact.rootDigest === state.running.rootDigest &&
      artifact.image.deployReference === state.running.image,
    'S6_WEBHOOK_RUNNING_ARTIFACT_CHANGED',
  );
  return { service, target: current, deployments: inventory(rows) };
}

async function runningHttpsContent() {
  await runningPublicationObservation();
  const actual = await tlsContent(state.running.git.marker, state.git.marker);
  requireValue(
    actual.bodySha256 === state.running.git.htmlSha256 &&
      actual.bodySha256 !== state.running.baseline.bodySha256,
    'S6_WEBHOOK_RUNNING_HTTPS_CONTENT_UNCHANGED',
  );
  state.running.httpsBodySha256 = actual.bodySha256;
  await save();
  await evidence('running-https-content', actual);
  await check('automatically-published-commit-served-over-verified-local-tls', true, {
    ...actual,
    deploymentId: state.running.deploymentId,
    commitSha: state.running.git.commitSha,
    image: state.running.image,
  });
}

async function duplicateRunningWebhook() {
  await runningPublicationObservation();
  const body = runningBody();
  const before = await data(`/webhook-deliveries/${state.running.deliveryId}`);
  assertRunningDelivery(before);
  state.running.replays ??= [];
  const replay = {
    attempt,
    at: new Date().toISOString(),
    beforeDuplicateCount: before.duplicateCount,
  };
  state.running.replays.push(replay);
  await save();
  const duplicate = await http(state.callbackPath, {
    method: 'POST',
    raw: body,
    authenticated: false,
    headers: await signedHeaders(state.running.externalDeliveryId, body),
  });
  await evidence('running-duplicate-receipt', {
    status: duplicate.status,
    receipt: duplicate.value,
  });
  const after = await data(`/webhook-deliveries/${state.running.deliveryId}`);
  await evidence('running-duplicate-delivery', { before, after });
  assertRunningDelivery(after);
  requireValue(
    duplicate.status === 200 &&
      duplicate.value?.duplicate === true &&
      duplicate.value.deliveryId === state.running.deliveryId &&
      duplicate.value.targetCount === 1 &&
      after.duplicateCount === before.duplicateCount + 1,
    'S6_WEBHOOK_RUNNING_DUPLICATE_NOT_DEDUPLICATED',
  );
  replay.confirmedAt = new Date().toISOString();
  replay.afterDuplicateCount = after.duplicateCount;
  await save();
  const started = Date.now();
  let samples = 0;
  while (true) {
    const observed = await runningPublicationObservation();
    const delivery = await data(`/webhook-deliveries/${state.running.deliveryId}`);
    await evidence(`running-duplicate-stable-sample-${samples++}`, { ...observed, delivery });
    assertRunningDelivery(delivery);
    requireValue(
      delivery.duplicateCount === after.duplicateCount,
      'S6_WEBHOOK_RUNNING_DUPLICATE_COUNT_CHANGED',
    );
    if (Date.now() - started >= 6500 && samples >= 2) break;
    await delay(1500, undefined, { signal: abort.signal });
  }
  state.running.duplicateVerified = {
    attempt,
    at: new Date().toISOString(),
    samples,
    observedForMs: Date.now() - started,
    duplicateCount: after.duplicateCount,
  };
  await save();
  await check('completed-running-delivery-replay-adds-no-deployment-or-build-run', true, {
    ...state.running.duplicateVerified,
    deliveryId: state.running.deliveryId,
    webhookTargetId: state.running.webhookTargetId,
    deploymentId: state.running.deploymentId,
    buildRunIds: state.running.buildRunIds,
    additionalDeployments: 0,
    additionalBuildRuns: 0,
    httpMutations: 'signed-callback-only',
  });
}

async function run() {
  await diskHeadroom('preflight');
  configuration = await readProductConfiguration();
  await checkFixtureHealth(configuration);
  await checkProductHttpsHealth(configuration);
  for (const path of [
    resolve(parentDirectory, 'state.json.lock'),
    resolve(directory, 'state.json.lock'),
  ]) {
    const handle = await open(path, 'wx', 0o600);
    locks.push({ path, handle });
    await handle.writeFile(JSON.stringify({ owner, pid: process.pid, attempt }));
  }
  parentState = JSON.parse(await privateFile(parentDirectory, 'state.json'));
  requireValue(
    parentState.version === 1 &&
      uuid.test(parentState.resources?.service) &&
      uuid.test(parentState.resources?.repository) &&
      uuid.test(parentState.resources?.github) &&
      uuid.test(parentState.resources?.domain) &&
      uuid.test(parentState.firstDeploymentId) &&
      sha.test(parentState.initialSha) &&
      parentState.hostname?.endsWith('.apps.ozz.test') &&
      parentState.firstImage?.includes('@sha256:'),
    'S6_WEBHOOK_REQUIRES_COMPLETED_PRODUCT_HTTPS',
  );
  try {
    const previous = await privateFile(directory, 'state.json');
    state = JSON.parse(previous);
    await writeFile(resolve(attemptDirectory, 'state-before.json'), previous, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  state ??= {
    version: 1,
    owner,
    id: randomUUID(),
    parentId: parentState.id,
    serviceId: parentState.resources.service,
    repositoryId: parentState.resources.repository,
    githubConnectionId: parentState.resources.github,
    domainId: parentState.resources.domain,
    hostname: parentState.hostname,
    fixtureId: configuration.fixture.fixtureId,
    commands: {},
    completed: {},
    checks: [],
  };
  requireValue(
    state.owner === owner &&
      state.version === 1 &&
      state.parentId === parentState.id &&
      state.serviceId === parentState.resources.service &&
      state.repositoryId === parentState.resources.repository &&
      state.githubConnectionId === parentState.resources.github &&
      state.domainId === parentState.resources.domain &&
      state.hostname === parentState.hostname &&
      state.fixtureId === configuration.fixture.fixtureId &&
      (!state.running || state.running.version === 1),
    'S6_WEBHOOK_STATE_IDENTITY_CHANGED',
  );
  requireValue(
    !state.baseline ||
      (state.baseline.deploymentId === parentState.firstDeploymentId &&
        state.baseline.commitSha === parentState.initialSha &&
        state.baseline.image === parentState.firstImage),
    'S6_WEBHOOK_PARENT_BASELINE_CHANGED',
  );
  requireValue(
    !values['retry-deployment'] || !state.completed['publish-pending'],
    'S6_WEBHOOK_RETRY_ONLY_FOR_INCOMPLETE_MANUAL_PUBLICATION',
  );
  await save();
  const password = (await readFile(resolve(productRoot, '.secrets/admin-password'), 'utf8')).trim();
  const login = await api('/auth/login', {
    method: 'POST',
    body: { username: 'admin', password },
    expected: 200,
  });
  cookie = login.headers['set-cookie']
    ?.find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'S6_WEBHOOK_LOGIN_FAILED');
  await phase('baseline', baseline);
  await phase('register-hook', registerHook);
  await phase('stop-service', stopService);
  await phase('advance-commit', advanceCommit);
  await phase('deliver-webhook', deliverWebhook);
  await phase('pending-stopped', () => stablePending('stopped'));
  await phase('resume-service', resumeService);
  await phase('pending-after-resume', () => stablePending('running'));
  await phase('publish-pending', publishPending);
  await phase('new-https-content', async () => {
    const actual = await tlsContent(state.git.marker, state.baseline.marker);
    requireValue(
      actual.bodySha256 !== state.baseline.bodySha256,
      'S6_WEBHOOK_NEW_CONTENT_NOT_CHANGED',
    );
    await evidence('new-https-content', actual);
    await check('new-commit-served-over-verified-local-tls', true, {
      ...actual,
      commitSha: state.git.commitSha,
      image: state.image,
    });
  });
  await phase('running-baseline', runningBaseline);
  await phase('running-advance-commit', advanceRunningCommit);
  await phase('running-deliver-webhook', deliverRunningWebhook);
  await phase('running-auto-publication', automaticPublication);
  await phase('running-https-content', runningHttpsContent);
  await phase('running-duplicate-stable', duplicateRunningWebhook);
  report.status = 'passed';
}

function runningSummary(current) {
  if (!current?.running) return null;
  const running = current.running;
  return {
    baselineDeploymentId: running.baseline?.deploymentId ?? null,
    externalDeliveryId: running.externalDeliveryId ?? null,
    deliveryId: running.deliveryId ?? null,
    webhookTargetId: running.webhookTargetId ?? null,
    deploymentId: running.deploymentId ?? null,
    commitSha: running.git?.commitSha ?? null,
    image: running.image ?? null,
    rootDigest: running.rootDigest ?? null,
    artifactId: running.artifactId ?? null,
    buildRunIds: running.buildRunIds ?? [],
    httpsBodySha256: running.httpsBodySha256 ?? null,
    duplicateVerified: running.duplicateVerified ?? null,
    callbackRequestCount: running.callbackRequests?.length ?? 0,
    mutationPolicy: 'reads-and-signed-callback-only',
  };
}

async function main() {
  requireValue(process.versions.node.split('.')[0] === '24', 'S6_WEBHOOK_NODE_24_REQUIRED');
  requireValue(
    positionals.length === 1 &&
      ['run', 'status'].includes(mode) &&
      (!values['retry-deployment'] || (mode === 'run' && uuid.test(values['retry-deployment']))),
    'S6_WEBHOOK_COMMAND_INVALID',
  );
  if (mode === 'status') {
    try {
      const current = JSON.parse(await privateFile(directory, 'state.json'));
      console.log(
        JSON.stringify({
          owner,
          serviceId: current.serviceId,
          completed: current.completed,
          deploymentId: current.currentDeploymentId ?? null,
          commitSha: current.git?.commitSha ?? null,
          image: current.image ?? null,
          running: runningSummary(current),
        }),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      console.log(JSON.stringify({ owner, status: 'not_started' }));
    }
    return;
  }
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(attemptDirectory, { mode: 0o700 });
  try {
    await run();
  } catch (error) {
    report.status = 'failed';
    const code = error.code ?? error.message;
    report.failure = {
      stage,
      code: /^[A-Z][A-Z0-9_]+$/u.test(code ?? '') ? code : 'S6_WEBHOOK_UNEXPECTED_FAILURE',
      taskId: error.taskId ?? null,
      httpStatus: error.httpStatus ?? null,
    };
    console.error(JSON.stringify(report.failure));
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    report.serviceId = state?.serviceId;
    report.deploymentId = state?.currentDeploymentId ?? null;
    report.running = runningSummary(state);
    report.runningCallbackRequests = state?.running?.callbackRequests ?? [];
    report.completedPhases = state?.completed;
    try {
      if (state && locks.length === 2) await save();
      await writeFile(
        resolve(attemptDirectory, 'report.json'),
        JSON.stringify(report, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
    } finally {
      for (const lock of locks.reverse()) {
        await lock.handle.close();
        await unlink(lock.path);
      }
    }
    console.log(
      JSON.stringify({
        status: report.status,
        checks: report.checks.length,
        report: resolve(attemptDirectory, 'report.json'),
      }),
    );
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ code: 'S6_WEBHOOK_PROBE_FAILED' }));
  process.exitCode = 1;
});
