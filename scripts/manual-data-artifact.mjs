import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MANUAL_DATA_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_METADATA_BYTES,
  argumentsFor,
  date,
  digestJson,
  entrypoint,
  fail,
  fileIn,
  hashFile,
  identity,
  outputDirectory,
  privateDirectory,
  privateHandle,
  privateJson,
  publishJson,
  publishNew,
  readPrefix,
  record,
  requiredPath,
  retainedFailure,
  runManualCli,
  text,
  uuid,
} from './manual-data-core.mjs';
import { inspectTar } from './manual-data-tar.mjs';

export const ENGINES = Object.freeze({
  postgresql: {
    version: '17.11',
    layout: 'postgresql-17-pgdata-v1',
    format: 'pg-custom-v1',
    file: 'data.pgdump',
    image:
      'docker.io/library/postgres@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27',
  },
  redis: {
    version: '7.4.11',
    layout: 'redis-7-rdb-aof-v1',
    format: 'redis-rdb-v1',
    file: 'data.rdb',
    image:
      'docker.io/library/redis@sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b',
  },
  files: {
    version: 'GNU tar 1.34',
    layout: 'files-root-v1',
    format: 'ustar-regular-v1',
    file: 'data.tar',
    image:
      'docker.io/library/postgres@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27',
  },
});
export function engine(value) {
  if (!Object.hasOwn(ENGINES, value))
    fail(
      'MANUAL_ENGINE_UNSUPPORTED',
      '首版只支持固定 PostgreSQL 17.11、Redis 7.4.11 和普通文件卷。',
    );
  return ENGINES[value];
}
export function locationLabel(value) {
  text(value, 300);
  if (/(?:https?:\/\/|[A-Za-z]:\\|\/Users\/|\/home\/|password|token|secret|Bearer\s)/iu.test(value))
    fail('MANUAL_LOCATION_LABEL_INVALID', '离机位置使用不含路径、连接串或认证信息的简短资产标签。');
  return value;
}
export function parseManifest(input) {
  const value = record(input, [
    'formatVersion',
    'state',
    'backupId',
    'source',
    'sourceServiceId',
    'sourceFence',
    'engine',
    'engineVersion',
    'dataLayout',
    'format',
    'toolVersion',
    'file',
    'sizeBytes',
    'sha256',
    'startedAt',
    'completedAt',
    'dataTime',
    'writersStopped',
    'validation',
    'verificationSteps',
  ]);
  const fixed = engine(value.engine);
  if (
    value.formatVersion !== 1 ||
    value.state !== 'complete' ||
    !uuid(value.backupId) ||
    !uuid(value.sourceServiceId) ||
    value.toolVersion !== MANUAL_DATA_VERSION ||
    value.engineVersion !== fixed.version ||
    value.dataLayout !== fixed.layout ||
    value.format !== fixed.format ||
    value.file !== fixed.file ||
    typeof value.writersStopped !== 'boolean' ||
    !/^\d{1,11}$/.test(value.sizeBytes) ||
    Number(value.sizeBytes) < 1 ||
    Number(value.sizeBytes) > MAX_ARTIFACT_BYTES ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    fail('MANUAL_MANIFEST_INVALID', '备份清单版本、完成状态、身份、格式或大小无效。');
  identity(value.source);
  record(value.sourceFence);
  record(value.validation);
  const from = date(value.startedAt),
    to = date(value.completedAt);
  if (from > to) fail('MANUAL_MANIFEST_INVALID', '备份采集时间无效。');
  const time = record(value.dataTime, ['from', 'to', 'description']);
  if (time.from !== null) date(time.from);
  if (time.to !== null) date(time.to);
  if (time.from && time.to && Date.parse(time.from) > Date.parse(time.to))
    fail('MANUAL_TIME_INVALID', '数据时间范围无效。');
  text(time.description, 500);
  if (
    !Array.isArray(value.verificationSteps) ||
    value.verificationSteps.length < 1 ||
    value.verificationSteps.length > 20
  )
    fail('MANUAL_MANIFEST_INVALID', '缺少有界验证步骤。');
  value.verificationSteps.forEach((step) => text(step, 500));
  if (value.engine === 'files' && !value.writersStopped)
    fail('MANUAL_FILES_NOT_STOPPED', '普通文件归档必须在零挂载维护保护内采集。');
  return value;
}
export async function inspectArtifact(file, kind) {
  engine(kind);
  const hashed = await hashFile(file),
    prefix = await readPrefix(file, 16);
  if (kind === 'postgresql' && prefix.subarray(0, 5).toString('ascii') !== 'PGDMP')
    fail('MANUAL_ARTIFACT_FORMAT', '产物不是 PostgreSQL custom dump。');
  if (kind === 'redis' && !/^REDIS\d{4}$/.test(prefix.subarray(0, 9).toString('ascii')))
    fail('MANUAL_ARTIFACT_FORMAT', '产物不是有明确版本头的 Redis RDB。');
  const entries = kind === 'files' ? await inspectTar(file) : null;
  // Format signatures are only early rejection. Engine clients validate DB artifacts before import.
  return { ...hashed, entries };
}
export async function sealBundle(directory, fields) {
  const canonical = await privateDirectory(directory),
    fixed = engine(fields.engine);
  const inspected = await inspectArtifact(fileIn(canonical, fixed.file), fields.engine);
  const manifest = parseManifest({
    ...fields,
    formatVersion: 1,
    state: 'complete',
    toolVersion: MANUAL_DATA_VERSION,
    engineVersion: fixed.version,
    dataLayout: fixed.layout,
    format: fixed.format,
    file: fixed.file,
    sizeBytes: inspected.sizeBytes,
    sha256: inspected.sha256,
    ...(inspected.entries ? { validation: inspected.entries } : {}),
  });
  await publishJson(resolve(canonical, 'manifest.json'), manifest);
  return { directory: canonical, manifest };
}
export async function verifyBundle(directory) {
  const canonical = await privateDirectory(directory),
    manifestPath = resolve(canonical, 'manifest.json');
  const manifest = parseManifest(await privateJson(manifestPath));
  const manifestDigest = await hashFile(manifestPath, MAX_METADATA_BYTES);
  const artifact = fileIn(canonical, manifest.file),
    inspected = await inspectArtifact(artifact, manifest.engine);
  if (inspected.sha256 !== manifest.sha256 || inspected.sizeBytes !== manifest.sizeBytes)
    fail('MANUAL_ARTIFACT_INTEGRITY', '产物大小或 SHA256 不匹配；不开始恢复。');
  if (inspected.entries && digestJson(inspected.entries) !== digestJson(manifest.validation))
    fail('MANUAL_ARTIFACT_ENTRIES', '文件内容、权限或 UID/GID 清单不匹配。');
  return { directory: canonical, artifact, manifest, manifestSha256: manifestDigest.sha256 };
}
async function copyNew(source, destination, maximum) {
  const input = await privateHandle(source, maximum);
  let output;
  try {
    output = await open(destination, 'wx', 0o600);
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maximum) fail('MANUAL_ARTIFACT_TOO_LARGE', '复制产物超过受控大小。');
      let offset = 0;
      while (offset < chunk.length) {
        const written = await output.write(chunk, offset, chunk.length - offset);
        if (!written.bytesWritten) fail('MANUAL_COPY_FAILED', '副本写入未完成。');
        offset += written.bytesWritten;
      }
    }
    await output.sync();
  } finally {
    await input.close();
    await output?.close();
  }
}
export async function copyBundle(source, parent, label) {
  const checked = await verifyBundle(source);
  locationLabel(label);
  const directory = await outputDirectory(parent, checked.manifest.backupId);
  try {
    const pendingData = resolve(directory, `${checked.manifest.file}.pending`),
      pendingManifest = resolve(directory, 'manifest.json.pending');
    await copyNew(checked.artifact, pendingData, MAX_ARTIFACT_BYTES);
    await copyNew(resolve(checked.directory, 'manifest.json'), pendingManifest, MAX_METADATA_BYTES);
    const data = await inspectArtifact(pendingData, checked.manifest.engine),
      manifestDigest = await hashFile(pendingManifest, MAX_METADATA_BYTES);
    if (
      data.sha256 !== checked.manifest.sha256 ||
      data.sizeBytes !== checked.manifest.sizeBytes ||
      manifestDigest.sha256 !== checked.manifestSha256
    )
      fail('MANUAL_COPY_CHANGED', '复制期间原清单或数据发生变化；正式副本清单未发布。');
    await publishNew(pendingData, fileIn(directory, checked.manifest.file));
    await publishNew(pendingManifest, resolve(directory, 'manifest.json'));
    const destination = await verifyBundle(directory);
    if (
      destination.manifestSha256 !== checked.manifestSha256 ||
      destination.manifest.sha256 !== checked.manifest.sha256
    )
      fail('MANUAL_COPY_CHANGED', '复制期间原清单或数据发生变化；本次副本保持不完整。');
    const receipt = {
      formatVersion: 1,
      kind: 'verified-copy',
      copyId: randomUUID(),
      backupId: checked.manifest.backupId,
      artifactSha256: checked.manifest.sha256,
      manifestSha256: checked.manifestSha256,
      sizeBytes: checked.manifest.sizeBytes,
      locationLabel: label,
      completedAt: new Date().toISOString(),
      physicalLocationVerification: 'operator_reported',
    };
    const receiptPath = resolve(directory, `copy-receipt-${receipt.copyId}.json`);
    await publishJson(receiptPath, receipt);
    return { directory, receiptPath, receipt };
  } catch (error) {
    await retainedFailure(directory, error, 'verified-copy');
    throw error;
  }
}
export async function verifyCopyReceipt(bundle, receiptFile) {
  const value = record(await privateJson(receiptFile), [
    'formatVersion',
    'kind',
    'copyId',
    'backupId',
    'artifactSha256',
    'manifestSha256',
    'sizeBytes',
    'locationLabel',
    'completedAt',
    'physicalLocationVerification',
  ]);
  if (
    value.formatVersion !== 1 ||
    value.kind !== 'verified-copy' ||
    !uuid(value.copyId) ||
    value.backupId !== bundle.manifest.backupId ||
    value.artifactSha256 !== bundle.manifest.sha256 ||
    value.manifestSha256 !== bundle.manifestSha256 ||
    value.sizeBytes !== bundle.manifest.sizeBytes ||
    value.physicalLocationVerification !== 'operator_reported'
  )
    fail('MANUAL_COPY_RECEIPT_INVALID', '副本回执不能证明这份清单与数据的复制校验。');
  date(value.completedAt);
  locationLabel(value.locationLabel);
  return value;
}
if (entrypoint(import.meta.url))
  await runManualCli(async () => {
    const args = argumentsFor({
      bundle: { type: 'string' },
      'copy-to': { type: 'string' },
      'location-label': { type: 'string' },
    });
    if (args.help) {
      console.log(
        'pnpm exec node scripts/manual-data-artifact.mjs --bundle PRIVATE_DIRECTORY [--copy-to PRIVATE_PARENT --location-label ASSET_LABEL]',
      );
      return;
    }
    if (args['copy-to']) {
      const result = await copyBundle(
        requiredPath(args.bundle),
        requiredPath(args['copy-to']),
        args['location-label'],
      );
      console.log(
        JSON.stringify({
          state: 'copy-verified',
          backupId: result.receipt.backupId,
          directory: result.directory,
          receipt: result.receiptPath,
          physicalLocationVerification: 'operator_reported',
        }),
      );
    } else {
      if (args['location-label'])
        fail('MANUAL_ARGUMENTS_INVALID', '位置标签只能与 --copy-to 一起使用。');
      const result = await verifyBundle(requiredPath(args.bundle));
      console.log(
        JSON.stringify({
          state: 'integrity-verified',
          backupId: result.manifest.backupId,
          sha256: result.manifest.sha256,
          sizeBytes: result.manifest.sizeBytes,
          engineValidationRequired: result.manifest.engine !== 'files',
        }),
      );
    }
  });
