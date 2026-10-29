const order = [
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

function requireValue(value, code) {
  if (!value) throw new Error(`GMVP_TIMING_${code}`);
}

/** Acknowledgement observations bound commit time; neither is an exact SQL snapshot timestamp. */
export function summarizeRecoveryTiming({ clockId, marks, checkpoint, restored, omitted }) {
  requireValue(typeof clockId === 'string' && clockId.length > 0, 'CLOCK_REQUIRED');
  let previous = -Infinity;
  for (const name of order) {
    const mark = marks[name];
    requireValue(
      mark?.clockId === clockId &&
        Number.isFinite(mark.elapsedMs) &&
        mark.elapsedMs >= 0 &&
        Number.isFinite(Date.parse(mark.at)),
      'CLOCK_OBSERVATION_INVALID',
    );
    requireValue(mark.elapsedMs >= previous, 'EVENT_ORDER_INVALID');
    previous = mark.elapsedMs;
  }
  requireValue(
    checkpoint?.id === restored?.id &&
      checkpoint?.revision === restored?.revision &&
      checkpoint?.contentSha256 === restored?.contentSha256 &&
      typeof checkpoint?.contentSha256 === 'string' &&
      /^[0-9a-f]{64}$/u.test(checkpoint.contentSha256),
    'RECOVERY_POINT_NOT_VERIFIED',
  );
  requireValue(
    omitted?.id === checkpoint.id &&
      Number.isSafeInteger(omitted.revision) &&
      omitted.revision > checkpoint.revision &&
      /^[0-9a-f]{64}$/u.test(omitted.contentSha256 ?? '') &&
      omitted.contentSha256 !== restored.contentSha256,
    'POST_BACKUP_LOSS_NOT_VERIFIED',
  );
  const delta = (end, start) =>
    Math.round((marks[end].elapsedMs - marks[start].elapsedMs) * 1000) / 1000;
  return {
    clock: 'one process.hrtime.bigint timebase; wall-clock timestamps are labels only',
    clockId,
    recoveryPoint: {
      kind: 'verified-application-metadata-checkpoint',
      ...checkpoint,
      requestStartedAt: marks.checkpointRequested.at,
      acknowledgedAt: marks.checkpointAcknowledged.at,
      acknowledgedCheckpointRpoMs: delta('incident', 'checkpointAcknowledged'),
      checkpointCommitRpoBoundsMs: {
        minimum: delta('incident', 'checkpointAcknowledged'),
        maximum: delta('incident', 'checkpointRequested'),
      },
      backupSnapshotRpoBoundsMs: {
        minimum: delta('incident', 'backupCompleted'),
        maximum: delta('incident', 'backupStarted'),
      },
      exactPostgresSnapshotRpoMs: null,
      omittedAcknowledgedCheckpoint: omitted,
      explanation:
        'The restored revision and content were checked through the real HTTPS API. The later acknowledged revision is absent. The commit lies between request and acknowledgement; the consistent snapshot lies inside the backup command. No observation is presented as PostgreSQL exact commit or snapshot time.',
    },
    recoveryTime: {
      start: 'immediately before stopping the owned source API and Worker',
      end: 'new-generation diagnostic succeeded and restored metadata re-read over the same HTTPS origin',
      endToEndRtoMs: delta('recovered', 'incident'),
      failureDetectionMs: delta('failureDetected', 'incident'),
      targetDatabaseCreationMs: delta('targetCreated', 'failureDetected'),
      localBackupRetrievalMs: delta('backupRetrieved', 'targetCreated'),
      databaseImportMs: delta('importCompleted', 'importStarted'),
      incidentToReadOnlyMs: delta('readOnlyAvailable', 'incident'),
      incidentToUnlockMs: delta('unlockCompleted', 'incident'),
      incidentToWriteReadyMs: delta('writeReady', 'incident'),
      finalDiagnosticAndVerificationMs: delta('recovered', 'writeReady'),
    },
  };
}
