import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

// SHA256 values come from the official Node SHASUMS256.txt and Caddy's
// Cloudsmith stable Debian Packages index. Downloads fail closed on mismatch.
const versions = {
  node: {
    version: '24.22.1',
    root: '/opt/node',
    assets: {
      arm64: {
        name: 'node-v24.22.1-linux-arm64.tar.gz',
        sha256: '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
      },
      x64: {
        name: 'node-v24.22.1-linux-x64.tar.gz',
        sha256: 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
      },
    },
  },
  caddy: {
    version: '2.11.7',
    root: '/opt/caddy',
    assets: {
      arm64: {
        name: 'caddy_2.11.7_linux_arm64.deb',
        sha256: 'ca8ae5a50439642d7672344b4ec64e47cbddf81beb5da302420a78522eb5a47e',
      },
      x64: {
        name: 'caddy_2.11.7_linux_amd64.deb',
        sha256: 'a22b914ffd1958da42bc7ab13b7b62c6100634e0798ab594891d2d61d53ba749',
      },
    },
  },
};

const kind = process.argv[2];
const item = versions[kind];
const asset = item?.assets[process.arch];
if (!item || !asset) throw new Error('Supported downloads: node/caddy on Linux ARM64 or AMD64');
const url =
  kind === 'node'
    ? `https://nodejs.org/dist/v${item.version}/${asset.name}`
    : `https://dl.cloudsmith.io/public/caddy/stable/deb/debian/pool/any-version/main/c/ca/caddy_${item.version}/${asset.name}`;
const response = await fetch(url, { signal: globalThis.AbortSignal.timeout(180000) });
if (!response.ok) throw new Error(`Official ${kind} download failed (${response.status})`);
const content = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(content).digest('hex') !== asset.sha256) {
  throw new Error(`Official ${kind} download checksum mismatch`);
}
const archive = `/tmp/ozz-${kind}.${kind === 'node' ? 'tar.gz' : 'deb'}`;
await writeFile(archive, content, { flag: 'wx', mode: 0o600 });
await mkdir(item.root, { recursive: true });
try {
  if (kind === 'node') {
    execFileSync('tar', ['-xzf', archive, '-C', item.root, '--strip-components=1']);
  } else {
    // Extract the verified binary without executing Debian install hooks.
    execFileSync('dpkg-deb', ['--extract', archive, item.root]);
    await rename(`${item.root}/usr/bin/caddy`, `${item.root}/caddy`);
  }
} finally {
  await rm(archive, { force: true });
}
const actual = execFileSync(
  `${item.root}/${kind === 'node' ? 'bin/node' : 'caddy'}`,
  [kind === 'node' ? '--version' : 'version'],
  { encoding: 'utf8' },
).trim();
if (!actual.startsWith(`v${item.version}`)) throw new Error(`Unexpected installed ${kind} version`);
console.log(`Verified ${kind} ${item.version} (${process.arch}), SHA256 ${asset.sha256}`);
