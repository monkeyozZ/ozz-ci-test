import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { restoredKeyOwner, writeNew } from '../../scripts/backup-helpers.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
const bytes = randomBytes(64);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const source = `/tmp/ozz-source-${randomUUID()}`;
await writeNew(source, bytes);
const owners = [];
for (const fixture of [
  { env: {}, uid: 1000, gid: 1000 },
  { env: { OZZ_RUNTIME_UID: '12345', OZZ_RUNTIME_GID: '12346' }, uid: 12345, gid: 12346 },
]) {
  const target = `/tmp/ozz-restored-${randomUUID()}`;
  const owner = restoredKeyOwner({ composeFile: '/proof-compose.yaml', env: fixture.env });
  await writeNew(target, bytes, owner);
  const info = await lstat(target);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(info.uid, fixture.uid);
  assert.equal(info.gid, fixture.gid);
  const readAsRuntimeUser = () =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'));",
        target,
      ],
      { encoding: 'utf8', uid: fixture.uid, gid: fixture.gid },
    );
  assert.equal(readAsRuntimeUser(), digest(bytes));
  await assert.rejects(writeNew(target, randomBytes(64), owner), { code: 'EEXIST' });
  assert.equal(readAsRuntimeUser(), digest(bytes));
  owners.push({ uid: info.uid, gid: info.gid, mode: '0600', readableByRuntimeUser: true });
}
assert.equal((await lstat(source)).uid, 0);
assert.equal((await lstat(source)).mode & 0o777, 0o600);
assert.equal(digest(await readFile(source)), digest(bytes));
assert.throws(
  () => restoredKeyOwner({ composeFile: '/proof-compose.yaml', env: { OZZ_RUNTIME_UID: '-1' } }),
  { code: 'INVALID_RUNTIME_OWNER' },
);
const refusal = execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    "import { restoredKeyOwner } from '/proof/scripts/backup-helpers.mjs'; try { restoredKeyOwner({ composeFile: '/proof-compose.yaml', env: {} }); process.exit(1); } catch (error) { if (error.code !== 'RUNTIME_KEY_OWNER_MISMATCH') throw error; process.stdout.write(error.code); }",
  ],
  { encoding: 'utf8', uid: 12345, gid: 12346 },
);
assert.equal(refusal, 'RUNTIME_KEY_OWNER_MISMATCH');
console.log(
  JSON.stringify({
    status: 'passed',
    platform: process.platform,
    node: process.version,
    owners,
    existingFilesUnchanged: true,
    nonRootOwnerMismatchRefused: true,
  }),
);
