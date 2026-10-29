import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    'bootstrap-image': { type: 'string' },
    'debian-mirror': { type: 'string' },
    prefix: { type: 'string' },
    tag: { type: 'string' },
    target: { type: 'string' },
    legacy: { type: 'boolean', default: false },
  },
});
const config = values['env-file']
  ? parseEnv(await readFile(resolve(values['env-file']), 'utf8'))
  : {};
const bootstrap =
  values['bootstrap-image'] || config.BOOTSTRAP_IMAGE || 'node:24.22.1-bookworm-slim';
const prefix = values.prefix || config.OZZ_IMAGE_PREFIX || 'ozz';
const tag = values.tag || config.OZZ_IMAGE_TAG || '0.1.0';
const debianMirror = (
  values['debian-mirror'] ||
  config.DEBIAN_MIRROR ||
  'http://deb.debian.org'
).replace(/\/$/, '');
if (!/^https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(debianMirror)) {
  throw new Error('The Debian mirror must be an HTTP(S) origin without a path or credentials');
}
for (const value of [bootstrap, prefix, tag]) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(value)) throw new Error('Invalid image name');
}
const targets = values.target ? [values.target] : ['api', 'worker', 'migrate', 'console'];
if (
  targets.some((target) => !['api', 'worker', 'migrate', 'console', 'toolchain'].includes(target))
)
  throw new Error('Invalid image target');
const root = resolve(import.meta.dirname, '../..');

// Explicit allowlist works with both builders, including older Docker versions
// which do not understand Dockerfile-specific ignore files. No .env or key can
// accidentally enter the context when the compatibility path is used.
const context = execFileSync(
  'tar',
  [
    '-czf',
    '-',
    '--no-xattrs',
    '--exclude=*/node_modules',
    '--exclude=*/dist',
    '--exclude=*/.env',
    '--exclude=*/.env.*',
    '--exclude=*/.secrets',
    '--exclude=*/.local',
    '--exclude=*/test-results',
    '--exclude=*/tests',
    '--exclude=*/playwright-report',
    '--exclude=*/coverage',
    '--exclude=*.log',
    '--exclude=*.tsbuildinfo',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'apps',
    'packages',
    'infra/docker',
  ],
  {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: '1', LC_ALL: 'C' },
    maxBuffer: 128 * 1024 * 1024,
  },
);

for (const target of targets) {
  const image = `${prefix}/${target}:${tag}`;
  console.log(`Building ${image}`);
  const child = spawn(
    'docker',
    [
      'build',
      '--pull=false',
      '--rm=true',
      '--target',
      target,
      '--build-arg',
      `BOOTSTRAP_IMAGE=${bootstrap}`,
      '--build-arg',
      `DEBIAN_MIRROR=${debianMirror}`,
      '-t',
      image,
      '-f',
      'infra/docker/Dockerfile',
      '-',
    ],
    {
      cwd: root,
      env: { ...process.env, ...(values.legacy ? { DOCKER_BUILDKIT: '0' } : {}) },
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  child.stdin.on('error', () => {});
  child.stdin.end(context);
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0) process.exit(typeof code === 'number' ? code : 1);
}
console.log(
  'Image build completed. Environment files and master keys were excluded from every build context.',
);
