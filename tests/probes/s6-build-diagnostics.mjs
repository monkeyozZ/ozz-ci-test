import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Read-only authenticated diagnostics; output is checked against fixture secrets.
const root = resolve(import.meta.dirname, '../..');
const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/u.test(id ?? '')) throw new Error('S6_DIAGNOSTIC_ID_INVALID');
const origin = 'https://127.0.0.1:51448';
const base = 'http://127.0.0.1:3000/api';
const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }),
  signal: globalThis.AbortSignal.timeout(10_000),
});
if (!login.ok) throw new Error('S6_DIAGNOSTIC_LOGIN_FAILED');
const cookie = login.headers
  .getSetCookie()
  .find((value) => value.startsWith('ozz_session='))
  ?.split(';')[0];
if (!cookie) throw new Error('S6_DIAGNOSTIC_SESSION_MISSING');
async function get(path) {
  const response = await fetch(base + path, {
    headers: { origin, cookie },
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('S6_DIAGNOSTIC_READ_FAILED');
  return response.json();
}
const task = (await get(`/deployments/${id}`)).data;
const logs = await get(`/deployments/${id}/build-logs?limit=100`);
const content = logs.items.map((item) => item.content).join('');
const token = JSON.parse(
  await readFile(resolve(root, '.local/local-lab/s6-github/product/pat.json'), 'utf8'),
).token;
const users = JSON.parse(
  await readFile(resolve(root, '.local/local-lab/s6-registry/users.json'), 'utf8'),
).users;
const sensitive = [
  password,
  token,
  Buffer.from(`x-access-token:${token}`).toString('base64'),
  ...users.flatMap((user) => [
    user.password,
    Buffer.from(`${user.username}:${user.password}`).toString('base64'),
  ]),
];
if (
  sensitive.some((value) => content.includes(value) || JSON.stringify(logs).includes(value)) ||
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)
)
  throw new Error('S6_DIAGNOSTIC_PLAINTEXT_DETECTED');
const report = {
  observedAt: new Date().toISOString(),
  deploymentId: id,
  task,
  logs,
  knownFixtureSecretsAbsent: true,
};
const output = resolve(root, `.local/local-lab/s6-product/diagnostic-${id}-${Date.now()}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify(
    {
      deploymentId: id,
      status: task.status,
      phase: task.phase,
      code: task.errorCode,
      runs: task.build?.runs.map((run) => ({
        id: run.id,
        phase: run.phase,
        executionState: run.executionState,
        executionClosedAt: run.executionClosedAt,
        proofVerifiedAt: run.proofVerifiedAt,
      })),
      available: logs.available,
      log: content.slice(-12000),
      report: output,
    },
    null,
    2,
  ),
);
