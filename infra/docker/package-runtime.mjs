import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string', default: '/output' } } });
const outputRoot = resolve(values.output);

const databaseRequire = createRequire(resolve('packages/database/package.json'));
const prismaRequire = createRequire(databaseRequire.resolve('@prisma/client'));
const generatedClient = dirname(prismaRequire.resolve('.prisma/client/default'));

function copyGeneratedClient(output, deployedDatabase) {
  // pnpm's nested postinstall placeholder otherwise shadows a root-level .prisma.
  const clientPackage = dirname(deployedDatabase.resolve('@prisma/client/package.json'));
  const destination = resolve(clientPackage, '../../.prisma/client');
  if (!destination.startsWith(`${output}/`)) throw new Error('Prisma deployment escaped output');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(generatedClient, destination, { recursive: true });
}

const runtimeImportProof = `
  const assert = require('node:assert/strict');
  const { createRequire } = require('node:module');
  const { pathToFileURL } = require('node:url');
  const { PrismaClient } = require('@ozz/database');
  const client = new PrismaClient();
  for (const name of ['tasks', 'builds', 'git', 'integrations']) require('@ozz/control-plane/' + name);
  const control = createRequire(require.resolve('@ozz/control-plane/infrastructure'));
  for (const name of ['ssh', 'build', 'github', 'registry']) control('@ozz/infrastructure/' + name);
  assert.throws(() => require.resolve('@ozz/builder/package.json'), { code: 'MODULE_NOT_FOUND' });
  const infra = createRequire(control.resolve('@ozz/infrastructure/kubernetes'));
  import(pathToFileURL(infra.resolve('@kubernetes/client-node')).href)
    .then(() => client.$disconnect()).catch(() => process.exit(1));
`;

for (const name of ['api', 'worker']) {
  const output = resolve(outputRoot, name);
  execFileSync(
    'pnpm',
    ['--filter', `@ozz/${name}`, 'deploy', '--legacy', '--prod', '--no-runtime', output],
    { stdio: 'inherit' },
  );
  const appRequire = createRequire(`${output}/package.json`);
  copyGeneratedClient(output, createRequire(appRequire.resolve('@ozz/database')));
  execFileSync(process.execPath, ['-e', runtimeImportProof], { cwd: output, stdio: 'inherit' });
}

// The migration image needs the database package and its Prisma CLI. Keep the
// CLI's pinned dev dependency, without shipping the compiled workspace or build tools.
const migrateOutput = resolve(outputRoot, 'migrate');
execFileSync(
  'pnpm',
  ['--filter', '@ozz/database', 'deploy', '--legacy', '--no-runtime', migrateOutput],
  { stdio: 'inherit' },
);
copyGeneratedClient(migrateOutput, createRequire(`${migrateOutput}/package.json`));
for (const path of [
  'node_modules/prisma/build/index.js',
  'prisma/schema.prisma',
  'prisma/migrations',
]) {
  if (!existsSync(resolve(migrateOutput, path)))
    throw new Error(`Migration package is missing ${path}`);
}
execFileSync(
  process.execPath,
  [
    '-e',
    'const { PrismaClient } = require("./dist/index.js"); new PrismaClient().$disconnect().catch(() => process.exit(1));',
  ],
  { cwd: migrateOutput, stdio: 'inherit' },
);
