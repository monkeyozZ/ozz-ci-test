import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  copyBundle,
  inspectArtifact,
  sealBundle,
  verifyBundle,
  verifyCopyReceipt,
} from '../../scripts/manual-data-artifact.mjs';
import {
  hashFile,
  newTarget,
  outputDirectory,
  privateJson,
  publishNew,
  writeNew,
} from '../../scripts/manual-data-core.mjs';
import { inspectTar } from '../../scripts/manual-data-tar.mjs';
import { dataIdentity, fields, tar, tarHeader, temporary } from './archive-fixture.mjs';

test('private files, atomic publication and copy never overwrite retained bytes', async (t) => {
  const parent = await temporary(t),
    file = join(parent, 'private.json');
  await writeNew(file, { first: true });
  await assert.rejects(writeNew(file, { first: false }), { code: 'MANUAL_OUTPUT_EXISTS' });
  assert.deepEqual(await privateJson(file), { first: true });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const staged = join(parent, 'staged.json');
  await writeNew(staged, { second: true });
  await assert.rejects(publishNew(staged, file), { code: 'MANUAL_OUTPUT_EXISTS' });
  assert.deepEqual(await privateJson(staged), { second: true });
  const linked = join(parent, 'link.json');
  await symlink(file, linked);
  await assert.rejects(privateJson(linked), { code: 'MANUAL_PRIVATE_FILE_REQUIRED' });
  await chmod(file, 0o644);
  await assert.rejects(privateJson(file), { code: 'MANUAL_PRIVATE_FILE_REQUIRED' });
});
test('source and restore target require independent Volume, PVC and Service identities', () => {
  const source = dataIdentity(),
    target = dataIdentity();
  newTarget(source, target, 'source-service', 'target-service');
  for (const changed of [
    { ...target, volumeId: source.volumeId },
    { ...target, pvcUid: source.pvcUid },
  ])
    assert.throws(() => newTarget(source, changed, 'source', 'target'), {
      code: 'MANUAL_SOURCE_TARGET_SAME',
    });
  assert.throws(() => newTarget(source, target, 'same', 'same'), {
    code: 'MANUAL_SOURCE_TARGET_SAME',
  });
});
test('USTAR inventory verifies bytes, root ownership, directories and ordinary file modes', async (t) => {
  const parent = await temporary(t),
    file = join(parent, 'data.tar');
  await writeNew(
    file,
    tar([
      { path: 'folder/', type: '5', mode: 0o750 },
      { path: 'folder/内容.txt', data: 'hello' },
    ]),
  );
  const checked = await inspectTar(file);
  assert.deepEqual(checked.root, { mode: 0o750, uid: 999, gid: 999 });
  assert.equal(checked.entryCount, 2);
  assert.equal(checked.totalBytes, '5');
  assert.equal(checked.entries[1].path, 'folder/内容.txt');
  assert.equal(checked.entries[1].mode, 0o640);
  assert.equal(
    checked.entries[1].sha256,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});
for (const path of ['../escape', './../escape', '/absolute', 'a/../escape', 'a//b', 'a\\b', 'a\nb'])
  test(`rejects unsafe tar path ${JSON.stringify(path)}`, async (t) => {
    const parent = await temporary(t),
      file = join(parent, 'data.tar');
    await writeNew(file, tar([{ path, data: 'x' }]));
    await assert.rejects(inspectTar(file), { code: 'MANUAL_TAR_PATH' });
  });
for (const type of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'S'])
  test(`rejects tar links, devices and extension type ${type}`, async (t) => {
    const parent = await temporary(t),
      file = join(parent, 'data.tar');
    await writeNew(file, tar([{ path: 'entry', type, data: '' }]));
    await assert.rejects(inspectTar(file), { code: 'MANUAL_TAR_ENTRY_TYPE' });
  });
test('rejects equivalent paths, file/directory collisions and special mode bits', async (t) => {
  const parent = await temporary(t);
  const cases = [
    [
      [
        { path: 'a', data: '1' },
        { path: './a', data: '2' },
      ],
      'MANUAL_TAR_DUPLICATE',
    ],
    [
      [
        { path: 'a', data: '1' },
        { path: 'a/b', data: '2' },
      ],
      'MANUAL_TAR_PATH_TYPE',
    ],
    [
      [
        { path: 'a/b', data: '1' },
        { path: 'a', data: '2' },
      ],
      'MANUAL_TAR_PATH_TYPE',
    ],
    [[{ path: 'a', mode: 0o4644, data: '1' }], 'MANUAL_TAR_METADATA'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const file = join(parent, `${i}.tar`);
    await writeNew(file, tar(cases[i][0]));
    await assert.rejects(inspectTar(file), { code: cases[i][1] });
  }
});
test('rejects corrupted checksums, truncation, nonzero padding and trailing concatenated archives', async (t) => {
  const parent = await temporary(t),
    original = tar();
  const corrupted = Buffer.from(original);
  corrupted[512] = 120;
  const padding = Buffer.from(original);
  padding[512 + 512 + 5] = 1;
  const cases = [
    [corrupted, 'MANUAL_TAR_CHECKSUM'],
    [original.subarray(0, original.length - 513), 'MANUAL_TAR_TRUNCATED'],
    [original.subarray(0, original.length - 512), 'MANUAL_TAR_TRUNCATED'],
    [padding, 'MANUAL_TAR_PADDING'],
    [Buffer.concat([original, tar()]), 'MANUAL_TAR_TRAILING_DATA'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const file = join(parent, `${i}.tar`);
    await writeNew(file, cases[i][0]);
    await assert.rejects(inspectTar(file), { code: cases[i][1] });
  }
});
test('rejects ambiguous NUL paths, hidden link targets and entry-count overflow', async (t) => {
  const parent = await temporary(t);
  for (const [name, bytes, code] of [
    ['ambiguous', tar([{ path: 'safe\0../hidden', data: '' }]), 'MANUAL_TAR_ENCODING'],
    [
      'link',
      Buffer.concat([tarHeader({ link: '../escape', size: 0 }), Buffer.alloc(1024)]),
      'MANUAL_TAR_ENTRY_TYPE',
    ],
  ]) {
    const file = join(parent, `${name}.tar`);
    await writeNew(file, bytes);
    await assert.rejects(inspectTar(file), { code });
  }
  const file = join(parent, 'entries.tar');
  await writeNew(
    file,
    tar([
      { path: 'a', data: '1' },
      { path: 'b', data: '2' },
    ]),
  );
  await assert.rejects(inspectTar(file, { maxEntries: 1 }), {
    code: 'MANUAL_TAR_TOO_MANY_ENTRIES',
  });
});
test('seal, verify and copy preserve the manifest byte-for-byte and verify the destination', async (t) => {
  const parent = await temporary(t),
    metadata = fields(),
    directory = await outputDirectory(parent, metadata.backupId);
  await writeNew(join(directory, 'data.tar'), tar());
  await sealBundle(directory, metadata);
  const original = await verifyBundle(directory),
    copy = await copyBundle(directory, join(parent, 'off-host-copy'), 'lab-independent-volume-B');
  const destination = await verifyBundle(copy.directory);
  await verifyCopyReceipt(destination, copy.receiptPath);
  assert.equal(destination.manifestSha256, original.manifestSha256);
  assert.deepEqual(
    await readFile(join(copy.directory, 'manifest.json')),
    await readFile(join(directory, 'manifest.json')),
  );
  await assert.rejects(
    copyBundle(directory, join(parent, 'off-host-copy'), 'lab-independent-volume-B'),
    { code: 'MANUAL_OUTPUT_EXISTS' },
  );
  await chmod(join(copy.directory, 'data.tar'), 0o644);
  await assert.rejects(verifyBundle(copy.directory), { code: 'MANUAL_PRIVATE_FILE_REQUIRED' });
  assert.equal((await hashFile(join(directory, 'data.tar'))).sha256, original.manifest.sha256);
});
test('modified artifact or manifest metadata cannot pass local verification', async (t) => {
  const parent = await temporary(t),
    metadata = fields(),
    directory = await outputDirectory(parent, metadata.backupId);
  await writeNew(join(directory, 'data.tar'), tar());
  await sealBundle(directory, metadata);
  const changed = tar([{ path: 'hello.txt', data: 'jello' }]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(directory, 'data.tar'), changed);
  await assert.rejects(verifyBundle(directory), { code: 'MANUAL_ARTIFACT_INTEGRITY' });
});
test('database signatures are only early rejection, never a semantic-validation claim', async (t) => {
  const parent = await temporary(t),
    file = join(parent, 'data.rdb');
  await writeNew(file, Buffer.from('REDIS0012fixture-only'));
  const inspected = await inspectArtifact(file, 'redis');
  assert.equal(inspected.entries, null);
  await assert.rejects(inspectArtifact(file, 'postgresql'), { code: 'MANUAL_ARTIFACT_FORMAT' });
});
