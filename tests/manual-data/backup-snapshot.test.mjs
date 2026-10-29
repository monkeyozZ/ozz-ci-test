import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashSnapshotObservation,
  validateSnapshotObservation,
  verifyBackupSnapshot,
} from '../../scripts/backup-snapshot.mjs';

function observation() {
  return {
    formatVersion: 1,
    isolationLevel: 'repeatable-read',
    readOnly: true,
    exportId: '00000005-00000011-1',
    pgSnapshot: '9007199254740993:9007199254740999:9007199254740993,9007199254740997',
    databaseTimeBounds: {
      before: '2026-10-29T02:30:00.123456Z',
      after: '2026-10-29T02:30:00.124001Z',
      ordered: true,
    },
    clientObservation: {
      clockId: '513d81d4-cc0e-4fb1-89ac-6d6893c68fe2',
      requestStartedAt: '2026-10-29T02:30:00.100Z',
      metadataReceivedAt: '2026-10-29T02:30:00.140Z',
      elapsedNanoseconds: '40320512',
    },
    exactAcquisitionTimeKnown: false,
  };
}

test('snapshot observations preserve transaction IDs beyond Number precision', () => {
  const value = observation();
  assert.deepEqual(validateSnapshotObservation(value), value);
  for (const pgSnapshot of [
    '9007199254740994:9007199254740999:9007199254740993',
    '9007199254740999:9007199254740993:',
    '9007199254740993:9007199254740999:9007199254740999',
    '9007199254740993:9007199254740999:9007199254740997,9007199254740993',
    '9007199254740993:9007199254740999:9007199254740993,9007199254740993',
    '0:18446744073709551616:',
  ])
    assert.throws(() => validateSnapshotObservation({ ...value, pgSnapshot }), {
      code: 'INVALID_SNAPSHOT_OBSERVATION',
    });
  assert.equal(
    validateSnapshotObservation({ ...value, pgSnapshot: '42:42:' }).pgSnapshot,
    '42:42:',
  );
});

test('a backwards database wall clock is retained as unordered, never as a valid time bound', () => {
  const value = observation();
  value.databaseTimeBounds.after = '2026-10-29T02:29:59.999999Z';
  value.databaseTimeBounds.ordered = false;
  assert.equal(validateSnapshotObservation(value).databaseTimeBounds.ordered, false);
  value.databaseTimeBounds.ordered = true;
  assert.throws(() => validateSnapshotObservation(value), { code: 'INVALID_SNAPSHOT_OBSERVATION' });
});

test('client wall labels do not replace the independent monotonic duration', () => {
  const value = observation();
  value.clientObservation.metadataReceivedAt = '2026-10-29T02:29:59.000Z';
  assert.equal(validateSnapshotObservation(value).clientObservation.elapsedNanoseconds, '40320512');
  for (const duration of ['-1', '1.5', '1e6', 10, '01']) {
    value.clientObservation.elapsedNanoseconds = duration;
    assert.throws(() => validateSnapshotObservation(value), {
      code: 'INVALID_SNAPSHOT_OBSERVATION',
    });
  }
});

test('unsupported claims, extra fields and invalid calendar dates cannot become evidence', () => {
  const invalid = [
    { ...observation(), formatVersion: 2 },
    { ...observation(), exactAcquisitionTimeKnown: true },
    { ...observation(), readOnly: false },
    { ...observation(), unverified: 'private-marker' },
    { ...observation(), pgSnapshot: 'private-marker' },
  ];
  const date = observation();
  date.databaseTimeBounds.before = '2026-02-30T02:30:00.123456Z';
  invalid.push(date);
  for (const value of invalid) {
    assert.throws(
      () => validateSnapshotObservation(value),
      (error) => {
        assert.equal(error.code, 'INVALID_SNAPSHOT_OBSERVATION');
        assert.equal(error.message.includes('private-marker'), false);
        return true;
      },
    );
  }
});

test('snapshot binding is independent of JSON key order and binds the exact database bytes', () => {
  const value = observation();
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.clientObservation = Object.fromEntries(
    Object.entries(value.clientObservation).reverse(),
  );
  const digest = hashSnapshotObservation(value, 'a'.repeat(64));
  assert.equal(hashSnapshotObservation(reordered, 'a'.repeat(64)), digest);
  assert.notEqual(hashSnapshotObservation(value, 'b'.repeat(64)), digest);
  assert.notEqual(
    hashSnapshotObservation({ ...value, exportId: '00000005-00000012-1' }, 'a'.repeat(64)),
    digest,
  );
});

test('legacy pairs remain valid while partial or mismatched snapshot evidence fails closed', () => {
  const legacy = { databaseSha256: 'a'.repeat(64) };
  assert.equal(verifyBackupSnapshot(legacy, legacy), undefined);
  const snapshotObservation = observation();
  const digest = hashSnapshotObservation(snapshotObservation, legacy.databaseSha256);
  const database = { ...legacy, snapshotObservation, snapshotObservationSha256: digest };
  const key = { ...legacy, snapshotObservationSha256: digest };
  assert.deepEqual(verifyBackupSnapshot(database, key), snapshotObservation);
  for (const pair of [
    [database, legacy],
    [legacy, { ...legacy, snapshotObservation }],
    [legacy, key],
    [{ ...legacy, snapshotObservation }, key],
    [database, { ...key, snapshotObservationSha256: 'f'.repeat(64) }],
    [database, { ...key, databaseSha256: 'b'.repeat(64) }],
    [{ ...database, snapshotObservation: { ...snapshotObservation, pgSnapshot: '42:42:' } }, key],
  ])
    assert.throws(() => verifyBackupSnapshot(...pair), { code: 'BACKUP_SNAPSHOT_MISMATCH' });
});
