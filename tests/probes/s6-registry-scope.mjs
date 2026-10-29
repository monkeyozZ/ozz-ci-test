import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { URLSearchParams } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/s6-registry');
const repository = 'ozz-s6/probe';
const authority = 'host.lima.internal:50444';
const service = 'ozz-s6-registry';
const runId = `scope-${new Date()
  .toISOString()
  .replaceAll(/[^0-9TZ]/gu, '')
  .toLowerCase()}-${randomUUID().slice(0, 8)}`;
const execute = promisify(execFile);
const usersFile = resolve(directory, 'users.json');
const ca = await readFile(resolve(directory, 'ca.crt'));
const credentials = JSON.parse(await readFile(usersFile, 'utf8'));
const push = credentials.users.find((item) => item.username === 'ozz-s6-push');
const pull = credentials.users.find((item) => item.username === 'ozz-s6-pull');
const secrets = [...credentials.users.map((item) => item.password)];
const issuedTokens = [];
const report = {
  version: 1,
  runId,
  status: 'running',
  startedAt: new Date().toISOString(),
  scope:
    'Real Distribution 3.1.2 TLS, JWT verification, OCI manifest/blob push/pull and repository-action enforcement only; no Builder, Skopeo or Kubernetes deployment is certified.',
  checks: [],
};
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
let pushToken;
let pullToken;
let manifest;
let manifestDigest;
let config;
let configDigest;

function requireValue(value, code) {
  if (!value) throw new Error(code);
}

async function check(name, work) {
  await work();
  report.checks.push({ name, passed: true });
  console.log(JSON.stringify({ check: name, passed: true }));
}

function call(
  port,
  path,
  { method = 'GET', authorization, body, contentType, defaultTrust = false } = {},
) {
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        servername: 'host.lima.internal',
        port,
        path,
        method,
        ca: defaultTrust ? undefined : ca,
        rejectUnauthorized: true,
        agent: false,
        signal: globalThis.AbortSignal.timeout(8000),
        headers: {
          accept: 'application/vnd.oci.image.manifest.v1+json',
          ...(authorization ? { authorization } : {}),
          ...(body
            ? {
                'content-length': body.length,
                'content-type': contentType ?? 'application/octet-stream',
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) response.destroy(new Error('S6_REGISTRY_SCOPE_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () =>
          accept({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

async function issue(user, scope) {
  const query = new URLSearchParams({ service, scope });
  const result = await call(51445, `/token?${query}`, {
    authorization: `Basic ${Buffer.from(`${user.username}:${user.password}`).toString('base64')}`,
  });
  if (result.status !== 200) return { status: result.status };
  const token = JSON.parse(result.body).token;
  requireValue(
    typeof token === 'string' && token.split('.').length === 3,
    'S6_REGISTRY_SCOPE_TOKEN_INVALID',
  );
  issuedTokens.push(token);
  return { status: 200, token, claims: JSON.parse(Buffer.from(token.split('.')[1], 'base64url')) };
}

function bearer(token) {
  return `Bearer ${token}`;
}

async function uploadBlob(value, token) {
  const begun = await call(50444, `/v2/${repository}/blobs/uploads/`, {
    method: 'POST',
    authorization: bearer(token),
  });
  requireValue(
    begun.status === 202 && typeof begun.headers.location === 'string',
    'S6_REGISTRY_SCOPE_UPLOAD_NOT_STARTED',
  );
  const target = new URL(begun.headers.location, `https://${authority}`);
  // Local TCP forwarding changes the HTTP Host seen by the fixture, so either
  // controlled loopback authority may occur. TLS always verifies host.lima.internal.
  requireValue(
    ['https://127.0.0.1:50444', `https://${authority}`].includes(target.origin) &&
      target.pathname.startsWith(`/v2/${repository}/blobs/uploads/`),
    'S6_REGISTRY_SCOPE_UPLOAD_LOCATION_INVALID',
  );
  target.searchParams.set('digest', digest(value));
  const done = await call(50444, `${target.pathname}${target.search}`, {
    method: 'PUT',
    authorization: bearer(token),
    body: value,
  });
  requireValue(
    done.status === 201 && done.headers['docker-content-digest'] === digest(value),
    'S6_REGISTRY_SCOPE_BLOB_UPLOAD_FAILED',
  );
  return digest(value);
}

try {
  requireValue(
    credentials.owner === 'ozz-s6-registry-token-fixture-v1' &&
      push &&
      pull &&
      push.password !== pull.password,
    'S6_REGISTRY_SCOPE_CREDENTIALS_INVALID',
  );
  await check('verified_tls_and_real_distribution_bearer_challenge', async () => {
    const response = await call(50444, '/v2/');
    requireValue(
      response.status === 401 &&
        response.headers['docker-distribution-api-version'] === 'registry/2.0' &&
        response.headers['www-authenticate']?.includes('https://host.lima.internal:51445/token'),
      'S6_REGISTRY_SCOPE_CHALLENGE_INVALID',
    );
    let denied = false;
    try {
      await call(50444, '/v2/', { defaultTrust: true });
    } catch (error) {
      denied = [
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ].includes(error.code);
    }
    requireValue(denied, 'S6_REGISTRY_SCOPE_DEFAULT_TRUST_ACCEPTED');
  });
  await check('wrong_password_cannot_obtain_a_token', async () => {
    requireValue(
      (await issue({ ...pull, password: 'wrong-password' }, `repository:${repository}:pull`))
        .status === 401,
      'S6_REGISTRY_SCOPE_BAD_PASSWORD_ACCEPTED',
    );
  });
  await check('runtime_requested_push_is_reduced_and_distribution_rejects_write', async () => {
    const response = await issue(pull, `repository:${repository}:pull,push`);
    requireValue(
      response.status === 200 && response.claims.access[0].actions.join(',') === 'pull',
      'S6_REGISTRY_SCOPE_RUNTIME_GRANT_ESCALATED',
    );
    pullToken = response.token;
    const denied = await call(50444, `/v2/${repository}/blobs/uploads/`, {
      method: 'POST',
      authorization: bearer(pullToken),
    });
    requireValue([401, 403].includes(denied.status), 'S6_REGISTRY_SCOPE_RUNTIME_PUSH_ACCEPTED');
  });
  await check('uploader_pushes_a_real_oci_config_and_manifest', async () => {
    const response = await issue(push, `repository:${repository}:pull,push`);
    requireValue(response.status === 200, 'S6_REGISTRY_SCOPE_PUSH_TOKEN_MISSING');
    pushToken = response.token;
    config = Buffer.from(
      JSON.stringify({
        created: new Date().toISOString(),
        architecture: 'arm64',
        os: 'linux',
        config: { Labels: { 'dev.ozz.s6.fixture': runId } },
        rootfs: { type: 'layers', diff_ids: [] },
        history: [],
      }),
    );
    configDigest = await uploadBlob(config, pushToken);
    manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: {
          mediaType: 'application/vnd.oci.image.config.v1+json',
          digest: configDigest,
          size: config.length,
        },
        layers: [],
      }),
    );
    manifestDigest = digest(manifest);
    const uploaded = await call(50444, `/v2/${repository}/manifests/${runId}`, {
      method: 'PUT',
      authorization: bearer(pushToken),
      body: manifest,
      contentType: 'application/vnd.oci.image.manifest.v1+json',
    });
    requireValue(
      uploaded.status === 201 && uploaded.headers['docker-content-digest'] === manifestDigest,
      'S6_REGISTRY_SCOPE_MANIFEST_UPLOAD_FAILED',
    );
  });
  await check('runtime_identity_reads_exact_manifest_and_config', async () => {
    const image = await call(50444, `/v2/${repository}/manifests/${manifestDigest}`, {
      authorization: bearer(pullToken),
    });
    const blob = await call(50444, `/v2/${repository}/blobs/${configDigest}`, {
      authorization: bearer(pullToken),
    });
    requireValue(
      image.status === 200 &&
        digest(image.body) === manifestDigest &&
        blob.status === 200 &&
        digest(blob.body) === configDigest,
      'S6_REGISTRY_SCOPE_RUNTIME_PULL_FAILED',
    );
  });
  await check('runtime_cannot_put_manifests_or_delete_published_digest', async () => {
    const put = await call(50444, `/v2/${repository}/manifests/${runId}-denied`, {
      method: 'PUT',
      authorization: bearer(pullToken),
      body: manifest,
      contentType: 'application/vnd.oci.image.manifest.v1+json',
    });
    const remove = await call(50444, `/v2/${repository}/manifests/${manifestDigest}`, {
      method: 'DELETE',
      authorization: bearer(pullToken),
    });
    requireValue(
      [401, 403].includes(put.status) && [401, 403].includes(remove.status),
      'S6_REGISTRY_SCOPE_RUNTIME_MUTATION_ACCEPTED',
    );
    requireValue(
      (
        await call(50444, `/v2/${repository}/manifests/${manifestDigest}`, {
          authorization: bearer(pullToken),
        })
      ).status === 200,
      'S6_REGISTRY_SCOPE_IMAGE_NOT_RETAINED',
    );
  });
  await check('repository_scope_cannot_be_escalated', async () => {
    const foreign = 'foreign/not-authorized';
    const response = await issue(push, `repository:${foreign}:pull,push`);
    requireValue(
      response.status === 200 && response.claims.access[0].actions.length === 0,
      'S6_REGISTRY_SCOPE_FOREIGN_GRANT_ACCEPTED',
    );
    const result = await call(50444, `/v2/${foreign}/blobs/uploads/`, {
      method: 'POST',
      authorization: bearer(response.token),
    });
    requireValue([401, 403].includes(result.status), 'S6_REGISTRY_SCOPE_FOREIGN_PUSH_ACCEPTED');
  });
  await check('distribution_verifies_jwt_signature', async () => {
    const parts = pullToken.split('.');
    const signature = Buffer.from(parts[2], 'base64url');
    signature[0] ^= 1;
    parts[2] = signature.toString('base64url');
    const result = await call(50444, `/v2/${repository}/manifests/${manifestDigest}`, {
      authorization: bearer(parts.join('.')),
    });
    requireValue([401, 403].includes(result.status), 'S6_REGISTRY_SCOPE_FORGED_TOKEN_ACCEPTED');
  });
  await check('rotated_password_mints_current_working_pull_token', async () => {
    const previous = { ...pull };
    await writeFile(
      resolve(directory, `${runId}-users-before-rotation.json`),
      `${JSON.stringify(credentials, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    pull.password = randomBytes(36).toString('base64url');
    secrets.push(pull.password);
    const next = resolve(directory, `${runId}-users.next`);
    await writeFile(next, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(next, usersFile);
    requireValue(
      (await issue(previous, `repository:${repository}:pull`)).status === 401,
      'S6_REGISTRY_SCOPE_OLD_PASSWORD_ACCEPTED',
    );
    const current = await issue(pull, `repository:${repository}:pull`);
    requireValue(current.status === 200, 'S6_REGISTRY_SCOPE_ROTATED_TOKEN_MISSING');
    const result = await call(50444, `/v2/${repository}/manifests/${manifestDigest}`, {
      authorization: bearer(current.token),
    });
    requireValue(
      result.status === 200 && digest(result.body) === manifestDigest,
      'S6_REGISTRY_SCOPE_ROTATED_PULL_FAILED',
    );
  });
  await check('actual_registry_access_evidence_contains_no_credentials', async () => {
    const code =
      "from pathlib import Path\nimport sys\np=Path('/var/lib/ozz-local-lab/b/s6-registry/access.jsonl')\nassert p.stat().st_size<4*1024*1024\nsys.stdout.buffer.write(p.read_bytes())\n";
    const job = execute(
      'ssh',
      [
        '-F',
        resolve(root, '.local/local-lab/credentials/ssh_config'),
        'ozz-lab-b',
        'sudo',
        'python3',
        '-',
      ],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );
    job.child.stdin.end(code);
    const log = (await job).stdout;
    for (const value of [...secrets, ...issuedTokens])
      requireValue(!log.includes(value), 'S6_REGISTRY_SCOPE_LOG_SECRET_EXPOSED');
    const entries = log
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    requireValue(
      entries.some(
        (item) =>
          item.path === `/v2/${repository}/manifests/${runId}` &&
          item.method === 'PUT' &&
          item.status === 201,
      ) &&
        entries.some(
          (item) =>
            item.path === `/v2/${repository}/manifests/${manifestDigest}` &&
            item.method === 'GET' &&
            item.status === 200,
        ),
      'S6_REGISTRY_SCOPE_ACTUAL_REQUEST_EVIDENCE_MISSING',
    );
    report.registryAccessEntries = entries.length;
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errorCode = /^S6_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : 'S6_REGISTRY_SCOPE_UNEXPECTED_FAILURE';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.length;
  report.artifact = { repository, tag: runId, manifestDigest, configDigest, retained: true };
  const path = resolve(directory, `${runId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(
    JSON.stringify({
      status: report.status,
      passed: report.passed,
      errorCode: report.errorCode,
      report: path,
    }),
  );
}
