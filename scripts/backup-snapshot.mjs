import { createHash } from 'node:crypto';

const MAX_XID = (1n << 64n) - 1n;
const own = (value, key) => Object.hasOwn(value, key);

export class SnapshotObservationError extends Error {
  constructor(code = 'INVALID_SNAPSHOT_OBSERVATION') {
    super(
      code === 'BACKUP_SNAPSHOT_MISMATCH'
        ? 'The snapshot observation, database archive and matching key manifest are not a verified pair.'
        : 'The backup snapshot observation is incomplete or unsupported.',
    );
    this.name = 'SnapshotObservationError';
    this.code = code;
  }
}

function requireValue(value) {
  if (!value) throw new SnapshotObservationError();
}

function fields(value, names) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).sort().join(',') === [...names].sort().join(','));
}

function decimal(value, maximum = MAX_XID) {
  requireValue(typeof value === 'string' && /^(0|[1-9]\d{0,19})$/u.test(value));
  const parsed = BigInt(value);
  requireValue(parsed <= maximum);
  return parsed;
}

function timestamp(value, precision) {
  requireValue(typeof value === 'string');
  const pattern = new RegExp(
    `^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})\\.(\\d{${precision}})Z$`,
    'u',
  );
  const match = pattern.exec(value);
  requireValue(match);
  const milliseconds = `${match[1]}.${match[2].slice(0, 3)}Z`;
  const date = new Date(milliseconds);
  requireValue(Number.isFinite(date.getTime()) && date.toISOString() === milliseconds);
  return value;
}

// This is a logical PostgreSQL MVCC boundary. Transaction IDs must retain all
// 64 bits, including across wraparound; JavaScript Number is not suitable.
function pgSnapshot(value) {
  requireValue(typeof value === 'string' && value.length <= 65536);
  const parts = value.split(':');
  requireValue(parts.length === 3);
  const xmin = decimal(parts[0]);
  const xmax = decimal(parts[1]);
  requireValue(xmin <= xmax);
  let previous;
  for (const text of parts[2] ? parts[2].split(',') : []) {
    const xid = decimal(text);
    requireValue(xid >= xmin && xid < xmax && (previous === undefined || xid > previous));
    previous = xid;
  }
  return value;
}

/** Validate and return the fixed canonical field order used by both manifests. */
export function validateSnapshotObservation(value) {
  fields(value, [
    'formatVersion',
    'isolationLevel',
    'readOnly',
    'exportId',
    'pgSnapshot',
    'databaseTimeBounds',
    'clientObservation',
    'exactAcquisitionTimeKnown',
  ]);
  requireValue(value.formatVersion === 1 && value.isolationLevel === 'repeatable-read');
  requireValue(value.readOnly === true && value.exactAcquisitionTimeKnown === false);
  requireValue(
    typeof value.exportId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{8}-[1-9]\d{0,19}$/iu.test(value.exportId),
  );
  fields(value.databaseTimeBounds, ['before', 'after', 'ordered']);
  const before = timestamp(value.databaseTimeBounds.before, 6);
  const after = timestamp(value.databaseTimeBounds.after, 6);
  requireValue(value.databaseTimeBounds.ordered === before <= after);
  fields(value.clientObservation, [
    'clockId',
    'requestStartedAt',
    'metadataReceivedAt',
    'elapsedNanoseconds',
  ]);
  const client = value.clientObservation;
  requireValue(
    typeof client.clockId === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(client.clockId),
  );
  timestamp(client.requestStartedAt, 3);
  timestamp(client.metadataReceivedAt, 3);
  decimal(client.elapsedNanoseconds);
  // Wall clocks may move backwards. Only this process's monotonic duration is
  // used for elapsed time; it must not be subtracted from a different process.
  return {
    formatVersion: 1,
    isolationLevel: 'repeatable-read',
    readOnly: true,
    exportId: value.exportId,
    pgSnapshot: pgSnapshot(value.pgSnapshot),
    databaseTimeBounds: { before, after, ordered: before <= after },
    clientObservation: {
      clockId: client.clockId,
      requestStartedAt: client.requestStartedAt,
      metadataReceivedAt: client.metadataReceivedAt,
      elapsedNanoseconds: client.elapsedNanoseconds,
    },
    exactAcquisitionTimeKnown: false,
  };
}

/** Bind the observed snapshot to the exact dump bytes; this is not a signature. */
export function hashSnapshotObservation(observation, databaseSha256) {
  requireValue(typeof databaseSha256 === 'string' && /^[a-f0-9]{64}$/u.test(databaseSha256));
  const payload = {
    databaseSha256,
    snapshotObservation: validateSnapshotObservation(observation),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Old format-1 pairs remain recoverable, with no invented snapshot observation. */
export function verifyBackupSnapshot(databaseManifest, keyManifest) {
  if (own(keyManifest, 'snapshotObservation'))
    throw new SnapshotObservationError('BACKUP_SNAPSHOT_MISMATCH');
  const present = [
    own(databaseManifest, 'snapshotObservation'),
    own(databaseManifest, 'snapshotObservationSha256'),
    own(keyManifest, 'snapshotObservationSha256'),
  ];
  if (present.every((value) => !value)) return undefined;
  if (!present.every(Boolean)) throw new SnapshotObservationError('BACKUP_SNAPSHOT_MISMATCH');
  const observation = validateSnapshotObservation(databaseManifest.snapshotObservation);
  const digest = hashSnapshotObservation(observation, databaseManifest.databaseSha256);
  if (
    databaseManifest.databaseSha256 !== keyManifest.databaseSha256 ||
    digest !== databaseManifest.snapshotObservationSha256 ||
    digest !== keyManifest.snapshotObservationSha256
  )
    throw new SnapshotObservationError('BACKUP_SNAPSHOT_MISMATCH');
  return observation;
}
