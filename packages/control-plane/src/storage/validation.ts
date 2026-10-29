import { OperationRequestError } from '../tasks/contracts.js';
import type {
  CreateManualDataRecordInput,
  CreateVolumeInput,
  ManualDataIdentity,
  SaveVolumeMountInput,
  VolumeDeletionConfirmation,
} from './contracts.js';

export function invalid(message: string, code = 'STORAGE_INPUT_INVALID'): never {
  throw new OperationRequestError(422, code, message);
}
export function inputRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求须为对象。');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) invalid('请求包含不支持的字段。');
  return raw;
}
export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value))
    invalid('资源 ID 无效。');
  return value;
}
function controlCharacters(value: string, allowWhitespace = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code === 127 || (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code)));
  });
}
export function text(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    controlCharacters(value, true)
  )
    invalid(`${label}为空、过长或含有控制字符。`);
  return value.trim();
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    invalid('版本号须为正整数。');
  return value as number;
}
export function bytes(value: unknown, min = 1n, max = BigInt(Number.MAX_SAFE_INTEGER)): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value))
    invalid('字节数须为十进制整数字符串。');
  if (BigInt(value) < min || BigInt(value) > max) invalid('申请容量超出本阶段支持范围。');
  return value;
}
export function createVolumeInput(value: unknown): CreateVolumeInput {
  const raw = inputRecord(value, [
    'environmentId',
    'name',
    'slug',
    'storageClassName',
    'requestedBytes',
  ]);
  const slug = text(raw.slug, 63, '卷标识');
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(slug))
    invalid('卷标识须为小写字母、数字和单个连字符。');
  const storageClassName = text(raw.storageClassName, 253, '存储类');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(storageClassName)) invalid('存储类名无效。');
  return {
    environmentId: resourceId(raw.environmentId),
    name: text(raw.name, 120, '卷名称'),
    slug,
    storageClassName,
    requestedBytes: bytes(raw.requestedBytes, 1024n * 1024n, 1024n ** 4n),
  };
}
export function mountPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    !value.startsWith('/') ||
    value === '/' ||
    value.includes('\\') ||
    controlCharacters(value) ||
    value
      .slice(1)
      .split('/')
      .some((segment) => ['', '.', '..'].includes(segment))
  )
    invalid('挂载路径须为不包含重复分隔符或父目录的容器内绝对路径。', 'VOLUME_MOUNT_PATH_INVALID');
  for (const prefix of ['/proc', '/sys', '/dev', '/run/secrets', '/var/run/secrets', '/etc/ozz'])
    if (value === prefix || value.startsWith(`${prefix}/`))
      invalid('不能覆盖系统或平台秘密目录。', 'VOLUME_MOUNT_PATH_FORBIDDEN');
  return value;
}
export function assertDistinctPaths(paths: readonly string[]): void {
  const sorted = [...paths].sort();
  for (let index = 0; index < sorted.length; index++) {
    mountPath(sorted[index]);
    const previous = sorted[index - 1];
    if (previous && (previous === sorted[index] || sorted[index]!.startsWith(`${previous}/`)))
      invalid('同一服务的挂载路径不能重复或互相覆盖。', 'VOLUME_MOUNT_PATH_CONFLICT');
  }
}
export function saveMountInput(value: unknown): SaveVolumeMountInput {
  const raw = inputRecord(value, [
    'revision',
    'volumeId',
    'volumeRevision',
    'mountPath',
    'readOnly',
  ]);
  if (typeof raw.readOnly !== 'boolean') invalid('请明确选择只读或读写挂载。');
  return {
    revision: revision(raw.revision),
    volumeId: resourceId(raw.volumeId),
    volumeRevision: revision(raw.volumeRevision),
    mountPath: mountPath(raw.mountPath),
    readOnly: raw.readOnly as boolean,
  };
}
export function confirmationInput(value: unknown): VolumeDeletionConfirmation {
  const raw = inputRecord(value, [
    'volumeId',
    'pvcUid',
    'reclaimPolicy',
    'previewDigest',
    'volumeName',
  ]);
  if (
    raw.pvcUid !== null &&
    (typeof raw.pvcUid !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(raw.pvcUid))
  )
    invalid('确认的 PVC UID 无效。');
  if (![null, 'Delete', 'Retain'].includes(raw.reclaimPolicy as string | null))
    invalid('确认的回收策略无效。');
  if (typeof raw.previewDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.previewDigest))
    invalid('销毁预览摘要无效。');
  return {
    volumeId: resourceId(raw.volumeId),
    pvcUid: raw.pvcUid as string | null,
    reclaimPolicy: raw.reclaimPolicy as 'Delete' | 'Retain' | null,
    previewDigest: raw.previewDigest,
    volumeName: text(raw.volumeName, 120, '卷名称'),
  };
}
export function date(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !/^\d{4}-\d\d-\d\dT/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid('时间须为有效 ISO 8601 日期。');
  return new Date(value).toISOString();
}
function dataIdentity(value: unknown): ManualDataIdentity {
  const raw = inputRecord(value, [
    'installationId',
    'clusterId',
    'kubeSystemUid',
    'environmentId',
    'volumeId',
    'pvcUid',
  ]);
  const uid = (v: unknown) => {
    if (typeof v !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(v))
      invalid('实际资源 UID 无效。');
    return v;
  };
  return {
    installationId: resourceId(raw.installationId),
    clusterId: resourceId(raw.clusterId),
    kubeSystemUid: uid(raw.kubeSystemUid),
    environmentId: resourceId(raw.environmentId),
    volumeId: resourceId(raw.volumeId),
    pvcUid: uid(raw.pvcUid),
  };
}
export function manualRecordInput(value: unknown): CreateManualDataRecordInput {
  const raw = inputRecord(value, [
    'type',
    'backupId',
    'source',
    'target',
    'engine',
    'engineVersion',
    'dataLayout',
    'format',
    'toolVersion',
    'sizeBytes',
    'sha256',
    'startedAt',
    'completedAt',
    'dataTime',
    'offHostLocationLabel',
    'integrity',
    'verificationSteps',
    'result',
    'evidenceReferences',
  ]);
  if (
    !['backup', 'restore'].includes(String(raw.type)) ||
    !['postgresql', 'redis', 'files'].includes(String(raw.engine)) ||
    !['passed', 'failed', 'unknown'].includes(String(raw.integrity)) ||
    !['passed', 'failed', 'incomplete'].includes(String(raw.result))
  )
    invalid('手工记录的类型、引擎或验证结果无效。');
  const strings = (value: unknown, maximum: number): string[] => {
    if (!Array.isArray(value) || value.length > 20) invalid('证据或验证步骤过多。');
    return value.map((item) => text(item, maximum, '记录项'));
  };
  const time = inputRecord(raw.dataTime, ['from', 'to', 'description']);
  const startedAt = date(raw.startedAt);
  const completedAt = date(raw.completedAt);
  if (
    Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(completedAt) > Date.now() + 300_000
  )
    invalid('记录起止时间不一致。');
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256))
    invalid('产物 SHA256 无效。');
  const source = dataIdentity(raw.source);
  const target = raw.target === null ? null : dataIdentity(raw.target);
  if ((raw.type === 'backup') !== (target === null))
    invalid('备份记录不带目标；恢复记录必须指向明确的新目标。');
  if (target && (target.volumeId === source.volumeId || target.pvcUid === source.pvcUid))
    invalid('恢复记录必须使用新的卷和 PVC 身份。');
  const from = time.from === null ? null : date(time.from);
  const to = time.to === null ? null : date(time.to);
  if (from && to && Date.parse(from) > Date.parse(to)) invalid('数据时间范围无效。');
  return {
    type: raw.type as 'backup' | 'restore',
    backupId: resourceId(raw.backupId),
    source,
    target,
    engine: raw.engine as CreateManualDataRecordInput['engine'],
    engineVersion: text(raw.engineVersion, 80, '引擎版本'),
    dataLayout: text(raw.dataLayout, 100, '数据布局'),
    format: text(raw.format, 80, '备份格式'),
    toolVersion: text(raw.toolVersion, 120, '工具版本'),
    sizeBytes: bytes(raw.sizeBytes),
    sha256: raw.sha256,
    startedAt,
    completedAt,
    dataTime: { from, to, description: text(time.description, 500, '数据时间说明') },
    offHostLocationLabel: text(raw.offHostLocationLabel, 300, '离机位置标签'),
    integrity: raw.integrity as CreateManualDataRecordInput['integrity'],
    verificationSteps: strings(raw.verificationSteps, 500),
    result: raw.result as CreateManualDataRecordInput['result'],
    evidenceReferences: strings(raw.evidenceReferences, 300),
  };
}
export function decodeCursor(value: string | undefined): { createdAt: Date; id: string } | null {
  if (!value) return null;
  try {
    if (value.length > 512 || !/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error();
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return { id: resourceId(raw.id), createdAt: new Date(date(raw.createdAt)) };
  } catch {
    invalid('分页游标无效。', 'INVALID_CURSOR');
  }
}
export function encodeCursor(row: { id: string; createdAt: Date }): string {
  return Buffer.from(
    JSON.stringify({ id: row.id, createdAt: row.createdAt.toISOString() }),
  ).toString('base64url');
}
