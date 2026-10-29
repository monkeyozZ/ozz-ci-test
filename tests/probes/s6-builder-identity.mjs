import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  HttpsBuilderTransport,
  HttpBuilderClient,
  verifySigned,
  verifyInventoryPages,
} from '../../packages/infrastructure/dist/build.js';

const root = resolve(import.meta.dirname, '../..');
const local = resolve(root, '.local/local-lab/builder');
const pki = resolve(local, 'pki');
const id = `identity-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
const directory = resolve(local, 'checks', id);
const report = {
  version: 1,
  id,
  startedAt: new Date().toISOString(),
  status: 'running',
  scope:
    'Real Linux manager, kernel preflight, mTLS and signed installation inventory; no source build.',
  checks: [],
};
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
async function check(name, action) {
  try {
    const evidence = await action();
    report.checks.push({ name, status: 'passed', ...evidence });
    console.log(JSON.stringify({ name, status: 'passed' }));
  } catch (error) {
    report.checks.push({
      name,
      status: 'failed',
      code: /^[A-Z][A-Z0-9_]+$/u.test(error.code ?? error.message ?? '')
        ? (error.code ?? error.message)
        : 'BUILDER_IDENTITY_CHECK_FAILED',
    });
    throw error;
  }
}
try {
  const expected = JSON.parse(await readFile(resolve(local, 'operator-config.json'), 'utf8'));
  const tls = {
    origin: 'https://127.0.0.1:49443',
    caCertificate: await readFile(resolve(pki, 'ca.crt'), 'utf8'),
    clientCertificate: await readFile(resolve(pki, 'client.crt'), 'utf8'),
    clientPrivateKey: await readFile(resolve(pki, 'client.key'), 'utf8'),
  };
  const ssh = ['-F', resolve(local, 'credentials/ssh_config'), 'ozz-build'];
  const execute = promisify(execFile);
  const key = (
    await execute('ssh', [...ssh, 'sudo cat /etc/ozz-builder/identity-public-key.pem'], {
      timeout: 15_000,
    })
  ).stdout;
  const identityFile = resolve(local, 'identity-public-key.pem');
  try {
    requireValue(
      (await readFile(identityFile, 'utf8')) === key,
      'BUILDER_RETAINED_IDENTITY_CHANGED',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(identityFile, key, { flag: 'wx', mode: 0o600 });
  }
  const client = new HttpBuilderClient(new HttpsBuilderTransport(tls));
  let identity;
  await check('signed-real-kernel-identity', async () => {
    const challenge = randomBytes(32).toString('base64url');
    const signed = await client.identity(challenge);
    identity = verifySigned(signed, key);
    requireValue(
      identity.challenge === challenge &&
        identity.instanceId === expected.instanceId &&
        identity.highGeneration === expected.generation,
      'BUILDER_IDENTITY_MISMATCH',
    );
    requireValue(
      identity.platform.os === 'linux' &&
        identity.platform.architecture === 'arm64' &&
        identity.maxConcurrency === 1 &&
        Object.values(identity.isolation).every((value) => value === true),
      'BUILDER_ISOLATION_MISMATCH',
    );
    await writeFile(
      resolve(directory, 'signed-identity.json'),
      `${JSON.stringify(signed, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      instanceId: identity.instanceId,
      platform: identity.platform,
      limits: identity.limits,
      highGeneration: identity.highGeneration,
      isolation: identity.isolation,
    };
  });
  await check('signed-complete-installation-inventory', async () => {
    const challenge = randomBytes(32).toString('base64url');
    const pages = [];
    let cursor;
    do {
      const page = await client.inventory(challenge, cursor);
      pages.push(page);
      cursor = page.payload.nextCursor ?? undefined;
    } while (cursor);
    const inventory = verifyInventoryPages(pages, {
      installationId: expected.installationId,
      builderInstanceId: expected.instanceId,
      challenge,
      publicKey: key,
    });
    requireValue(inventory.highGeneration === expected.generation, 'BUILDER_GENERATION_MISMATCH');
    await writeFile(
      resolve(directory, 'signed-inventory.json'),
      `${JSON.stringify(pages, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      totalRuns: inventory.totalRuns,
      pages: pages.length,
      highGeneration: inventory.highGeneration,
    };
  });
  await check('same-ca-unlisted-client-denied', async () => {
    const denied = new HttpBuilderClient(
      new HttpsBuilderTransport({
        ...tls,
        clientCertificate: await readFile(resolve(pki, 'unlisted-client.crt'), 'utf8'),
        clientPrivateKey: await readFile(resolve(pki, 'unlisted-client.key'), 'utf8'),
      }),
    );
    let code;
    try {
      await denied.identity(randomBytes(32).toString('base64url'));
    } catch (error) {
      code = error.code;
    }
    requireValue(code === 'BUILD_AUTH_INVALID', 'BUILDER_UNLISTED_CLIENT_ACCEPTED');
    return { code };
  });
  await check('missing-client-certificate-denied', async () => {
    const result = await new Promise((accept) => {
      const req = request(
        `${tls.origin}/v1/identity?challenge=${randomBytes(32).toString('base64url')}`,
        { ca: tls.caCertificate, rejectUnauthorized: true, agent: false, timeout: 5000 },
        (res) => {
          res.resume();
          accept({ status: res.statusCode });
        },
      );
      req.once('error', (error) => accept({ code: error.code }));
      req.once('timeout', () => req.destroy());
      req.end();
    });
    requireValue(
      /CERTIFICATE_REQUIRED|HANDSHAKE_FAILURE|TLS.*ALERT/u.test(result.code ?? '') ||
        result.status === 403,
      'BUILDER_MISSING_CLIENT_NOT_DENIED',
    );
    return result;
  });
  await check('wrong-server-trust-denied', async () => {
    const denied = new HttpBuilderClient(
      new HttpsBuilderTransport({ ...tls, caCertificate: tls.clientCertificate }),
    );
    let code;
    try {
      await denied.identity(randomBytes(32).toString('base64url'));
    } catch (error) {
      code = error.code;
    }
    requireValue(code === 'BUILD_TLS_INVALID', 'BUILDER_WRONG_TRUST_ACCEPTED');
    return { code };
  });
  await check('authorized-unknown-run-is-null', async () => {
    requireValue((await client.get(randomUUID())) === null, 'BUILDER_UNKNOWN_RUN_RESPONSE_INVALID');
    return { returnedNull: true };
  });
  const receipt = (
    await execute('ssh', [...ssh, 'sudo cat /etc/ozz-builder/installation-receipt.json'], {
      timeout: 15_000,
    })
  ).stdout;
  await writeFile(resolve(directory, 'installation-receipt.json'), receipt, { mode: 0o600 });
  report.status = 'passed';
} catch {
  report.status = 'failed';
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(directory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      report: resolve(directory, 'results.json'),
    }),
  );
}
