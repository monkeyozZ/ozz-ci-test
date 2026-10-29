import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRecoveryTiming } from '../probes/support/g-mvp-recovery-timing.mjs';

function observation() {
  const names = [
    'checkpointRequested',
    'checkpointAcknowledged',
    'backupStarted',
    'backupCompleted',
    'omittedRequested',
    'omittedAcknowledged',
    'incident',
    'failureDetected',
    'targetCreated',
    'backupRetrieved',
    'importStarted',
    'importCompleted',
    'readOnlyAvailable',
    'unlockCompleted',
    'writeReady',
    'recovered',
  ];
  const checkpoint = { id: 'resource-a', revision: 2, contentSha256: 'a'.repeat(64) };
  return {
    clockId: 'one-observed-attempt',
    marks: Object.fromEntries(
      names.map((name, index) => [
        name,
        {
          clockId: 'one-observed-attempt',
          elapsedMs: index * 100,
          at: new Date(Date.UTC(2026, 9, 28) + index * 100).toISOString(),
        },
      ]),
    ),
    checkpoint,
    restored: { ...checkpoint },
    omitted: { ...checkpoint, revision: 3, contentSha256: 'b'.repeat(64) },
  };
}

test('recovery timing includes detection and target preparation without calling an archive date exact RPO', () => {
  const result = summarizeRecoveryTiming(observation());
  assert.equal(result.recoveryTime.endToEndRtoMs, 900);
  assert.equal(result.recoveryTime.databaseImportMs, 100);
  assert.equal(result.recoveryPoint.acknowledgedCheckpointRpoMs, 500);
  assert.deepEqual(result.recoveryPoint.checkpointCommitRpoBoundsMs, {
    minimum: 500,
    maximum: 600,
  });
  assert.deepEqual(result.recoveryPoint.backupSnapshotRpoBoundsMs, { minimum: 300, maximum: 400 });
  assert.equal(result.recoveryPoint.exactPostgresSnapshotRpoMs, null);
});

test('a changed wall clock cannot change measured RTO', () => {
  const input = observation();
  input.marks.recovered.at = '2026-10-27T00:00:00.000Z';
  assert.equal(summarizeRecoveryTiming(input).recoveryTime.endToEndRtoMs, 900);
});

test('an interrupted attempt cannot combine clocks or infer missing recovery observations', () => {
  const changedClock = observation();
  changedClock.marks.recovered.clockId = 'a-later-process';
  assert.throws(() => summarizeRecoveryTiming(changedClock), /CLOCK_OBSERVATION_INVALID/u);
  const missing = observation();
  delete missing.marks.readOnlyAvailable;
  assert.throws(() => summarizeRecoveryTiming(missing), /CLOCK_OBSERVATION_INVALID/u);
  const backwards = observation();
  backwards.marks.importCompleted.elapsedMs = 1;
  assert.throws(() => summarizeRecoveryTiming(backwards), /EVENT_ORDER_INVALID/u);
});

test('metadata time alone cannot prove the recovery point or the post-backup loss', () => {
  const changed = observation();
  changed.restored.contentSha256 = 'c'.repeat(64);
  assert.throws(() => summarizeRecoveryTiming(changed), /RECOVERY_POINT_NOT_VERIFIED/u);
  const changedIdentity = observation();
  changedIdentity.restored.id = 'another-resource';
  assert.throws(() => summarizeRecoveryTiming(changedIdentity), /RECOVERY_POINT_NOT_VERIFIED/u);
  const noLoss = observation();
  noLoss.omitted = { ...noLoss.checkpoint };
  assert.throws(() => summarizeRecoveryTiming(noLoss), /POST_BACKUP_LOSS_NOT_VERIFIED/u);
});
