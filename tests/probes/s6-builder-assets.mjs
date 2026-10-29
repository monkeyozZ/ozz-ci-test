import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ArtifactDownloadError,
  downloadArtifact,
  sha256File,
} from '../../infra/local-lab/download.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/local-lab/builder/assets');
const source = await readFile(resolve(root, 'infra/builder/assets.lock.json'));
const lock = JSON.parse(source);
const runId = `assets-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
const report = {
  version: 1,
  runId,
  startedAt: new Date().toISOString(),
  lockSha256: createHash('sha256').update(source).digest('hex'),
  status: 'running',
  scope: 'Official pinned archive download and SHA256 verification; no installation or execution.',
  assets: [],
  interruptedAttempts: [],
};

function requireValue(value, code) {
  if (!value) throw new Error(code);
}

async function downloadWithRetry(name, descriptor) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloadArtifact(descriptor, directory);
    } catch (error) {
      if (!(error instanceof ArtifactDownloadError)) throw error;
      report.interruptedAttempts.push({ asset: name, attempt, diagnostic: error.message });
      if (attempt === 3) throw error;
      await delay(500);
    }
  }
}

try {
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  requireValue(lock.archives.length === 4, 'S6_BUILDER_ASSET_LOCK_INVALID');
  for (const asset of lock.archives) {
    requireValue(
      /^[a-z0-9]+$/u.test(asset.name) && /^[a-f0-9]{64}$/u.test(asset.sha256),
      'S6_BUILDER_ASSET_INVALID',
    );
    const location = new URL(asset.url);
    requireValue(
      location.protocol === 'https:' &&
        !location.username &&
        !location.password &&
        !location.search &&
        !location.hash,
      'S6_BUILDER_ASSET_ORIGIN_INVALID',
    );
    const filename = location.pathname.split('/').at(-1);
    requireValue(/^[A-Za-z0-9._+-]+$/u.test(filename), 'S6_BUILDER_ASSET_FILENAME_INVALID');
    let file;
    let officialMetadata;
    let expectedBytes = asset.bytes;
    if (location.hostname === 'github.com') {
      const parts = location.pathname.split('/').filter(Boolean);
      requireValue(
        parts.length === 6 && parts[2] === 'releases' && parts[3] === 'download',
        'S6_BUILDER_ASSET_GITHUB_URL_INVALID',
      );
      officialMetadata = `https://api.github.com/repos/${parts[0]}/${parts[1]}/releases/tags/${encodeURIComponent(parts[4])}`;
      const response = await fetch(officialMetadata, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'ozz-s6-builder-assets' },
        signal: globalThis.AbortSignal.timeout(20_000),
      });
      requireValue(response.status === 200, 'S6_BUILDER_ASSET_METADATA_UNAVAILABLE');
      const release = await response.json();
      const entry = release.assets?.find(
        (candidate) => candidate.browser_download_url === asset.url,
      );
      requireValue(
        entry &&
          entry.name === filename &&
          entry.size === expectedBytes &&
          Number.isSafeInteger(entry.id),
        'S6_BUILDER_ASSET_METADATA_MISMATCH',
      );
      if (entry.digest)
        requireValue(
          entry.digest === `sha256:${asset.sha256}`,
          'S6_BUILDER_ASSET_OFFICIAL_DIGEST_MISMATCH',
        );
      const download = {
        filename,
        url: asset.url,
        apiUrl: `https://api.github.com/repos/${parts[0]}/${parts[1]}/releases/assets/${entry.id}`,
        bytes: expectedBytes,
        sha256: asset.sha256,
      };
      file = await downloadWithRetry(asset.name, download);
    } else {
      requireValue(
        location.hostname === 'nodejs.org' &&
          asset.name === 'node' &&
          asset.version === '24.22.1' &&
          location.pathname === '/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz',
        'S6_BUILDER_ASSET_NODE_URL_INVALID',
      );
      officialMetadata = 'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt';
      const response = await fetch(officialMetadata, {
        signal: globalThis.AbortSignal.timeout(20_000),
      });
      requireValue(response.status === 200, 'S6_BUILDER_ASSET_METADATA_UNAVAILABLE');
      const sums = await response.text();
      requireValue(
        sums
          .split('\n')
          .some((line) => line.trim().split(/\s+/u).join(' ') === `${asset.sha256} ${filename}`),
        'S6_BUILDER_ASSET_OFFICIAL_DIGEST_MISMATCH',
      );
      const metadata = await fetch(asset.url, {
        method: 'HEAD',
        signal: globalThis.AbortSignal.timeout(20_000),
      });
      expectedBytes = Number(metadata.headers.get('content-length'));
      requireValue(
        metadata.status === 200 &&
          Number.isSafeInteger(expectedBytes) &&
          expectedBytes > 0 &&
          expectedBytes < 150 * 1024 * 1024,
        'S6_BUILDER_ASSET_SIZE_INVALID',
      );
      file = await downloadWithRetry(asset.name, {
        filename,
        url: asset.url,
        sha256: asset.sha256,
        bytes: expectedBytes,
        ranged: true,
      });
    }
    const info = await stat(file);
    const actualHash = await sha256File(file);
    requireValue(
      info.size === expectedBytes && actualHash === asset.sha256,
      'S6_BUILDER_ASSET_SHA256_MISMATCH',
    );
    report.assets.push({
      name: asset.name,
      version: asset.version,
      file: file.slice(root.length + 1),
      url: asset.url,
      bytes: info.size,
      sha256: actualHash,
      officialMetadata,
      status: 'passed',
      executed: false,
    });
    console.log(JSON.stringify({ asset: asset.name, status: 'verified', bytes: info.size }));
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  if (error instanceof ArtifactDownloadError) report.diagnostic = error.message;
  report.errorCode = /^S6_BUILDER_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : 'S6_BUILDER_ASSET_DOWNLOAD_FAILED';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const path = resolve(directory, `${runId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      status: report.status,
      verified: report.assets.length,
      report: path,
      errorCode: report.errorCode,
    }),
  );
}
