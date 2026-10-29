import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RegistryProbe, parseRegistryAccess } from '../../packages/infrastructure/dist/registry.js';
import { createRegistryFixtureProxy } from './support/s6-registry-proxy.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/s6-registry');
const id = randomUUID();
const repository = `ozz-s6/ozz-probe-${id}`;
const runId = `adapter-${new Date()
  .toISOString()
  .replaceAll(/[^0-9TZ]/gu, '')
  .toLowerCase()}-${id.slice(0, 8)}`;
const proxy = createRegistryFixtureProxy();
const report = {
  version: 1,
  runId,
  status: 'running',
  startedAt: new Date().toISOString(),
  scope:
    'Production RegistryProbe/RegistryAdapter over a loopback CONNECT mapping to real TLS/Distribution/token endpoints; no application/Builder deployment.',
  checks: [],
};
try {
  const usersFile = resolve(directory, 'users.json');
  const users = JSON.parse(await readFile(usersFile, 'utf8'));
  if (users.owner !== 'ozz-s6-registry-token-fixture-v1')
    throw new Error('S6_REGISTRY_FIXTURE_OWNER_INVALID');
  // Explicitly grant this one future operation-owned repository before the
  // actual provider check. No namespace-wide or wildcard grants are added.
  for (const user of users.users) {
    const template = user.repositories.find((entry) => entry.name === 'ozz-s6/probe');
    if (!template || user.repositories.length >= 16)
      throw new Error('S6_REGISTRY_FIXTURE_GRANT_LIMIT');
    user.repositories.push({ name: repository, actions: [...template.actions] });
  }
  const next = resolve(directory, `${runId}-users.next`);
  await writeFile(next, `${JSON.stringify(users, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(next, usersFile);
  await new Promise((done, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(0, '127.0.0.1', done);
  });
  const caCertificate = await readFile(resolve(directory, 'ca.crt'), 'utf8');
  const access = (username) => {
    const user = users.users.find((item) => item.username === username);
    if (!user) throw new Error('S6_REGISTRY_FIXTURE_USER_MISSING');
    return parseRegistryAccess({
      registry: 'host.lima.internal:50444',
      username,
      password: user.password,
      caCertificate,
      tokenServiceOrigins: ['https://host.lima.internal:51445'],
    });
  };
  const result = await new RegistryProbe({
    httpProxy: `http://127.0.0.1:${proxy.server.address().port}`,
  }).verify({
    authority: 'host.lima.internal:50444',
    repository,
    push: access('ozz-s6-push'),
    pull: access('ozz-s6-pull'),
    onChecked: async (check) => {
      report.checks.push(check);
      console.log(JSON.stringify({ check: check.kind, passed: true }));
    },
  });
  if (
    !result.push ||
    !result.pull ||
    !result.pullCannotPush ||
    report.checks.map((item) => item.kind).join(',') !== 'push,pull,pull_cannot_push'
  )
    throw new Error('S6_REGISTRY_ADAPTER_FACTS_INVALID');
  report.result = result;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errorCode = /^(S6_|REGISTRY_)[A-Z0-9_]+$/u.test(error.code ?? error.message)
    ? (error.code ?? error.message)
    : 'S6_REGISTRY_ADAPTER_UNEXPECTED_FAILURE';
  process.exitCode = 1;
} finally {
  await proxy.close();
  report.finishedAt = new Date().toISOString();
  report.proxyStopped = true;
  const path = resolve(directory, `${runId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      errorCode: report.errorCode,
      report: path,
    }),
  );
}
