import { cp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A minimal, reviewable bundle. It never scans .env, databases, kubeconfigs or
// the control-plane application; Builder runtime imports only these pure files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || output === root)
  throw new Error('Provide an empty explicit Builder bundle directory.');
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error('Builder bundle destination must be empty.');
const paths = [
  'apps/builder/package.json',
  'apps/builder/dist',
  'packages/infrastructure/package.json',
  'packages/infrastructure/dist/build.js',
  'packages/infrastructure/dist/build',
  'packages/infrastructure/dist/log-redaction.js',
  'packages/infrastructure/dist/registry/contracts.js',
];
const entries = [];
async function copy(relative) {
  const source = join(root, relative);
  const metadata = await stat(source);
  if (metadata.isDirectory()) {
    for (const name of (await readdir(source)).sort()) await copy(join(relative, name));
    return;
  }
  await mkdir(dirname(join(output, relative)), { recursive: true });
  await cp(source, join(output, relative));
  entries.push({
    path: relative,
    bytes: metadata.size,
    sha256: createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
  });
}
for (const path of paths) await copy(path);
await mkdir(join(output, 'apps/builder/node_modules/@ozz'), { recursive: true });
await symlink(
  '../../../../packages/infrastructure',
  join(output, 'apps/builder/node_modules/@ozz/infrastructure'),
);
await writeFile(
  join(output, 'builder-bundle-manifest.json'),
  JSON.stringify({ version: 1, entries }, null, 2) + '\n',
  { mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({ bundle: output, files: entries.length, includesControlPlane: false }) + '\n',
);
