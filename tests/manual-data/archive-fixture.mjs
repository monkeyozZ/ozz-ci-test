import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function temporary(test) {
  const directory = await mkdtemp(join(tmpdir(), 'ozz-manual-data-test-'));
  test.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
export const dataIdentity = () => ({
  installationId: randomUUID(),
  clusterId: randomUUID(),
  kubeSystemUid: randomUUID(),
  environmentId: randomUUID(),
  volumeId: randomUUID(),
  pvcUid: randomUUID(),
});
export function tarHeader({
  path = 'hello.txt',
  type = '0',
  size = 5,
  mode = 0o640,
  uid = 999,
  gid = 999,
  prefix = '',
  link = '',
} = {}) {
  const out = Buffer.alloc(512),
    field = (value, offset, length) => Buffer.from(value).copy(out, offset, 0, length);
  const oct = (value, offset, length) =>
    field(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  field(path, 0, 100);
  oct(mode, 100, 8);
  oct(uid, 108, 8);
  oct(gid, 116, 8);
  oct(size, 124, 12);
  oct(1, 136, 12);
  out.fill(32, 148, 156);
  field(type, 156, 1);
  field(link, 157, 100);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  field(prefix, 345, 155);
  field(
    [...out]
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
    8,
  );
  return out;
}
export function tar(entries = [{ path: 'hello.txt', data: 'hello' }], { root = true } = {}) {
  const blocks = [];
  if (root) blocks.push(tarHeader({ path: './', type: '5', size: 0, mode: 0o750 }));
  for (const entry of entries) {
    const bytes = Buffer.from(entry.data ?? '');
    blocks.push(
      tarHeader({ ...entry, size: entry.size ?? bytes.length }),
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
export function fields(kind = 'files') {
  return {
    backupId: randomUUID(),
    source: dataIdentity(),
    sourceServiceId: randomUUID(),
    sourceFence: { protocol: 'synthetic-only' },
    engine: kind,
    startedAt: '2026-10-25T01:00:00.000Z',
    completedAt: '2026-10-25T01:01:00.000Z',
    dataTime: {
      from: null,
      to: null,
      description: 'Synthetic test data; no remote backup was performed.',
    },
    writersStopped: kind === 'files',
    validation: { synthetic: true },
    verificationSteps: ['Synthetic fixture integrity only'],
  };
}
