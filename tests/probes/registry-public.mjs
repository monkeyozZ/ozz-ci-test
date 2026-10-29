import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseImageReference,
  parseRegistryAccess,
  RegistryAdapter,
} from '../../packages/infrastructure/dist/registry.js';

// Reads public registry metadata only. Actual Kubernetes pull/run and a
// restricted registry remain separate S3 product acceptance requirements.
const root = resolve(import.meta.dirname, '../..');
const reportFile = resolve(import.meta.dirname, 'registry-public-results.json');
const source = process.argv[2] ?? 'docker.io/library/nginx:stable-alpine';
const report = {
  scope: '真实公网 OCI manifest/config/digest/平台读取；不代表 Kubernetes 拉取运行或受限仓库验收。',
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: [],
  inputReference: null,
  image: null,
};
const signal = new globalThis.AbortController();
process.once('SIGINT', () => signal.abort());
process.once('SIGTERM', () => signal.abort());
const adapter = new RegistryAdapter();
const options = {
  platforms: [
    { os: 'linux', architecture: 'amd64' },
    { os: 'linux', architecture: 'arm64' },
  ],
  signal: signal.signal,
};

function check(name, passed) {
  report.checks.push({ name, passed });
  if (!passed) throw new Error('REGISTRY_PUBLIC_ASSERTION_FAILED');
}

try {
  const parsed = parseImageReference(source);
  report.inputReference = parsed.input;
  if (process.argv.length > 3) {
    options.access = parseRegistryAccess({
      registry: parsed.registry,
      blobServiceOrigins: process.argv.slice(3),
    });
    report.blobServiceOrigins = process.argv.slice(3).map((value) => new URL(value).origin);
  }
  const result = await adapter.resolve(source, options);
  report.image = result;
  check(
    'real index and both config blobs validate',
    result.indexDigest !== null && result.platformManifests.length === 2,
  );
  const verified = await adapter.verify(result, options);
  check(
    'stored immutable artifact can be fetched again without re-resolving its tag',
    verified.manifestDigest === result.manifestDigest && verified.verifiedAt !== undefined,
  );
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    code: typeof error.code === 'string' ? error.code : 'REGISTRY_PUBLIC_PROBE_FAILED',
    httpStatus: error.httpStatus ?? null,
  };
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
report.toolchain = JSON.parse(
  await readFile(resolve(root, 'packages/infrastructure/package.json'), 'utf8'),
).version;
await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks,
    failure: report.failure ?? null,
    report: reportFile,
  }),
);
