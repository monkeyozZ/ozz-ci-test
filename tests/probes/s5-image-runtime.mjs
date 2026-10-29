import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { templateImages } from '../../packages/control-plane/dist/templates/image-assets.js';

// Cache only the exact approved public images through the real K3s CRI path.
// No running workload, container or volume is removed or restarted.
const root = resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
const selected = process.argv.slice(2).find((value) => !value.startsWith('--'));
const proxyCache = process.argv.includes('--proxy-cache');
const names = selected ? [selected] : Object.keys(templateImages);
if (names.some((name) => !Object.hasOwn(templateImages, name))) throw new Error('S5_IMAGE_UNKNOWN');
const directory = resolve(root, '.local/s5-runtime-image-attempts');
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = {
  startedAt: new Date().toISOString(),
  scope: proxyCache
    ? 'Local ARM64 A/B containerd cache populated through an explicit host proxy; native unassisted CRI pull and cloud networking are not asserted.'
    : 'Local ARM64 A/B K3s native public registry pull; no cloud capacity assertion.',
  results: [],
};
for (const name of names) {
  const image = templateImages[name];
  if (!/^docker\.io\/library\/[a-z]+@sha256:[a-f0-9]{64}$/u.test(image.deployReference))
    throw new Error('S5_IMAGE_IDENTITY_INVALID');
  const results = await Promise.allSettled(
    ['a', 'b'].map(async (guest) => {
      const startedAt = Date.now();
      try {
        await run(
          'ssh',
          [
            '-F',
            resolve(root, '.local/local-lab/credentials/ssh_config'),
            `ozz-lab-${guest}`,
            proxyCache
              ? `sudo env HTTPS_PROXY=http://192.168.5.2:7890 HTTP_PROXY=http://192.168.5.2:7890 timeout 240 k3s ctr -n k8s.io images pull --local --platform linux/arm64 --skip-metadata --label io.cri-containerd.image=managed ${image.deployReference}`
              : `sudo timeout 90 k3s crictl pull ${image.deployReference}`,
          ],
          { timeout: proxyCache ? 250_000 : 100_000, maxBuffer: 4 * 1024 * 1024 },
        );
        const raw = await run(
          'ssh',
          [
            '-F',
            resolve(root, '.local/local-lab/credentials/ssh_config'),
            `ozz-lab-${guest}`,
            `sudo k3s crictl inspecti ${image.deployReference}`,
          ],
          { timeout: 10_000, maxBuffer: 1024 * 1024 },
        );
        const inspection = JSON.parse(raw.stdout);
        const platform = image.platformManifests.find((value) => value.architecture === 'arm64');
        const passed =
          inspection.status?.id === platform.configDigest &&
          inspection.status?.repoDigests?.includes(image.deployReference);
        return {
          name,
          guest,
          reference: image.deployReference,
          elapsedMs: Date.now() - startedAt,
          passed,
          code: passed ? null : 'S5_RUNTIME_IMAGE_IDENTITY_MISMATCH',
        };
      } catch (error) {
        // CRI diagnostics can repeat signed blob URLs; store only bounded categories.
        const diagnostic = String(error.stderr ?? '');
        const code =
          /timeout|deadline|context canceled/i.test(diagnostic) || error.killed
            ? 'S5_RUNTIME_IMAGE_TIMEOUT'
            : /no such host|resolve host/i.test(diagnostic)
              ? 'S5_RUNTIME_IMAGE_DNS'
              : /x509|certificate/i.test(diagnostic)
                ? 'S5_RUNTIME_IMAGE_TLS'
                : 'S5_RUNTIME_IMAGE_PULL_FAILED';
        return {
          name,
          guest,
          reference: image.deployReference,
          elapsedMs: Date.now() - startedAt,
          passed: false,
          code,
        };
      }
    }),
  );
  for (const value of results) {
    const result =
      value.status === 'fulfilled'
        ? value.value
        : { name, passed: false, code: 'S5_RUNTIME_IMAGE_PROBE_FAILED' };
    report.results.push(result);
    console.log(JSON.stringify(result));
  }
}
report.completedAt = new Date().toISOString();
report.status = report.results.every((result) => result.passed) ? 'passed' : 'failed';
await writeFile(resolve(directory, `${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
process.exitCode = report.status === 'passed' ? 0 : 1;
