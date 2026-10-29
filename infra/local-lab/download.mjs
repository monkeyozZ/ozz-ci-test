import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export class ArtifactDownloadError extends Error {}

const execute = promisify(execFile);
const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function assertArtifact(asset) {
  if (
    !/^[A-Za-z0-9._+-]+$/.test(asset.filename) ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1
  ) {
    throw new ArtifactDownloadError('Invalid pinned artifact metadata');
  }
  const address = new URL(asset.apiUrl ?? asset.url);
  if (
    address.protocol !== 'https:' ||
    address.username ||
    address.password ||
    !['api.github.com', 'github.com', 'cloud-images.ubuntu.com', 'nodejs.org'].includes(
      address.hostname,
    )
  ) {
    throw new ArtifactDownloadError('Unexpected artifact source');
  }
}

export async function verifyArtifact(asset, cacheDirectory) {
  assertArtifact(asset);
  const file = resolve(cacheDirectory, asset.filename);
  const info = await stat(file);
  if (!info.isFile() || info.size !== asset.bytes || (await sha256File(file)) !== asset.sha256) {
    throw new ArtifactDownloadError(`Artifact size/SHA256 mismatch: ${asset.filename}`);
  }
  return file;
}

/** Use only official URLs; large GitHub objects are fetched in bounded ranges. */
export async function downloadArtifact(asset, cacheDirectory) {
  assertArtifact(asset);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const file = resolve(cacheDirectory, asset.filename);
  if (await exists(file)) return verifyArtifact(asset, cacheDirectory);
  console.log(JSON.stringify({ action: 'download', asset: asset.filename, bytes: asset.bytes }));
  const partial = file + '.part';
  if (asset.apiUrl || asset.ranged) {
    let redirected = asset.url;
    if (asset.apiUrl) {
      const metadata = await fetch(asset.apiUrl, {
        redirect: 'manual',
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'ozz-local-lab' },
        signal: globalThis.AbortSignal.timeout(20000),
      });
      redirected = metadata.headers.get('location');
      if (
        metadata.status !== 302 ||
        !redirected ||
        new URL(redirected).hostname !== 'release-assets.githubusercontent.com'
      ) {
        throw new ArtifactDownloadError(
          `Official GitHub asset redirect unavailable: ${asset.filename}`,
        );
      }
    }
    // The short-lived public asset URL remains in memory; it is never logged.
    const partsDirectory = file + '.parts';
    await mkdir(partsDirectory, { recursive: true, mode: 0o700 });
    const chunkSize = 1024 * 1024;
    const count = Math.ceil(asset.bytes / chunkSize);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < count) {
        const index = next++;
        const start = index * chunkSize;
        const end = Math.min(start + chunkSize, asset.bytes) - 1;
        const part = resolve(partsDirectory, String(index));
        if ((await exists(part)) && (await stat(part)).size === end - start + 1) continue;
        try {
          const unfinished = part + '.partial';
          let received = (await exists(unfinished)) ? (await stat(unfinished)).size : 0;
          if (received > end - start + 1)
            throw new ArtifactDownloadError('Unexpected oversized partial asset range');
          if (received === end - start + 1) {
            await rename(unfinished, part);
            continue;
          }
          const rangeStart = start + received;
          const response = await fetch(redirected, {
            headers: { Range: `bytes=${rangeStart}-${end}` },
            signal: globalThis.AbortSignal.timeout(45000),
          });
          if (
            response.status !== 206 ||
            response.headers.get('content-range') !== `bytes ${rangeStart}-${end}/${asset.bytes}`
          ) {
            await response.body?.cancel();
            throw new ArtifactDownloadError('The official asset did not honor its bounded range');
          }
          const target = await open(unfinished, received ? 'a' : 'w', 0o600);
          try {
            for await (const chunk of response.body) {
              received += chunk.byteLength;
              if (received > end - start + 1)
                throw new ArtifactDownloadError('Asset range exceeded expected size');
              await target.write(chunk);
            }
          } finally {
            await target.close();
          }
          if (received !== end - start + 1)
            throw new ArtifactDownloadError('Incomplete asset range');
          await rename(unfinished, part);
        } catch {
          failed = true;
          throw new ArtifactDownloadError(
            `Official asset range download failed: ${asset.filename}, chunk ${index}`,
          );
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: 4 }, worker));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    const target = await open(partial, 'w', 0o600);
    try {
      for (let index = 0; index < count; index++) {
        for await (const chunk of createReadStream(resolve(partsDirectory, String(index))))
          await target.write(chunk);
      }
      await target.sync();
    } finally {
      await target.close();
    }
  } else {
    try {
      await execute(
        'curl',
        [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--http1.1',
          '--connect-timeout',
          '20',
          '--max-time',
          '900',
          '--retry',
          '1',
          '--continue-at',
          '-',
          '--output',
          partial,
          asset.url,
        ],
        { timeout: 1830000, maxBuffer: 1024 * 1024 },
      );
    } catch {
      throw new ArtifactDownloadError(`Official artifact download failed: ${asset.filename}`);
    }
  }
  if ((await stat(partial)).size !== asset.bytes || (await sha256File(partial)) !== asset.sha256) {
    throw new ArtifactDownloadError(
      `Downloaded artifact failed size/SHA256 verification: ${asset.filename}`,
    );
  }
  await chmod(partial, 0o600);
  await rename(partial, file);
  return file;
}
