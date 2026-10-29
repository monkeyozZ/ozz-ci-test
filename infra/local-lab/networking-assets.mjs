import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { downloadArtifact, verifyArtifact } from './download.mjs';

const lock = JSON.parse(
  await readFile(new URL('./networking.assets.lock.json', import.meta.url), 'utf8'),
);
const cache = resolve(import.meta.dirname, '../../.local/local-lab/cache/networking');

export async function ensureNetworkLabAssets({ verifyOnly = false } = {}) {
  const paths = {};
  for (const [name, asset] of Object.entries(lock.assets))
    paths[name] = await (verifyOnly
      ? verifyArtifact(asset, cache)
      : downloadArtifact(asset, cache));
  return { version: lock.pebbleVersion, paths };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { 'verify-only': { type: 'boolean', default: false } } });
  try {
    const result = await ensureNetworkLabAssets({ verifyOnly: values['verify-only'] });
    console.log(
      JSON.stringify({
        status: 'verified',
        version: result.version,
        assets: Object.keys(result.paths),
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.code ?? error.message }));
    process.exitCode = 1;
  }
}
