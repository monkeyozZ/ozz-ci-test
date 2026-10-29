import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, link, unlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const MANUAL_DATA_VERSION = 'ozz-manual-data/1.0.0';
export const MAX_ARTIFACT_BYTES = 1024 ** 3;
export const MAX_METADATA_BYTES = 16 * 1024 * 1024;
export class ManualDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManualDataError';
    this.code = code;
  }
}
export function fail(code, message) {
  throw new ManualDataError(code, message);
}
export function uuid(value) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))
    fail('MANUAL_INPUT_INVALID', '数据库标识符必须是有界 ASCII 名称。');
  return value;
}
export function uid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
export function record(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (keys && Object.keys(value).some((key) => !keys.includes(key)))
  )
    fail('MANUAL_INPUT_INVALID', '输入对象包含无效或不支持的字段。');
  return value;
}
export const hasControlCharacters = (value) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export function text(value, maximum = 300) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    hasControlCharacters(value)
  )
    fail('MANUAL_INPUT_INVALID', '输入文本无效或超过边界。');
  return value;
}
export function identity(value) {
  const raw = record(value, [
    'installationId',
    'clusterId',
    'kubeSystemUid',
    'environmentId',
    'volumeId',
    'pvcUid',
  ]);
  if (
    ![raw.installationId, raw.clusterId, raw.environmentId, raw.volumeId].every(uuid) ||
    !uid(raw.kubeSystemUid) ||
    !uid(raw.pvcUid)
  )
    fail('MANUAL_IDENTITY_INVALID', '必须使用产品返回的完整 ManualDataIdentity。');
  return { ...raw };
}
export function sameIdentity(a, b) {
  return [
    'installationId',
    'clusterId',
    'kubeSystemUid',
    'environmentId',
    'volumeId',
    'pvcUid',
  ].every((key) => a?.[key] === b?.[key]);
}
export function newTarget(source, target, sourceServiceId, targetServiceId) {
  identity(source);
  identity(target);
  if (
    source.volumeId === target.volumeId ||
    source.pvcUid === target.pvcUid ||
    (sourceServiceId && sourceServiceId === targetServiceId)
  )
    fail('MANUAL_SOURCE_TARGET_SAME', '恢复必须使用新的 Volume、PVC 和 Service 身份；源数据保留。');
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function privateHandle(file, maximum = MAX_METADATA_BYTES) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maximum ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      fail('MANUAL_PRIVATE_FILE_REQUIRED', '输入必须是当前用户拥有的普通 0600 文件，且大小受限。');
    return handle;
  } catch (error) {
    await handle?.close();
    if (error instanceof ManualDataError) throw error;
    fail('MANUAL_PRIVATE_FILE_REQUIRED', '无法打开受保护的输入文件。');
  }
}
export async function privateJson(file, maximum = MAX_METADATA_BYTES) {
  const handle = await privateHandle(file, maximum);
  try {
    const bytes = await boundedRead(handle, maximum),
      value = bytes.toString('utf8');
    if (!Buffer.from(value).equals(bytes)) throw new Error();
    return JSON.parse(value);
  } catch {
    fail('MANUAL_JSON_INVALID', '受保护的 JSON 文件无效。');
  } finally {
    await handle.close();
  }
}
export async function boundedRead(handle, maximum = MAX_METADATA_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    size += chunk.length;
    if (size > maximum) fail('MANUAL_INPUT_TOO_LARGE', '输入超过受控大小。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
export async function writeNew(file, data) {
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(
      typeof data === 'string' || Buffer.isBuffer(data)
        ? data
        : JSON.stringify(data, null, 2) + '\n',
    );
    await handle.sync();
  } catch (error) {
    if (error.code === 'EEXIST')
      fail('MANUAL_OUTPUT_EXISTS', '目标文件已存在；工具不会覆盖旧备份或证据。');
    throw error;
  } finally {
    await handle?.close();
  }
}
export async function publishNew(staging, destination) {
  try {
    await link(staging, destination);
  } catch (error) {
    if (error.code === 'EEXIST')
      fail('MANUAL_OUTPUT_EXISTS', '最终产物已存在；保留原文件和本次不完整文件。');
    throw error;
  }
  await unlink(staging);
}
export async function publishJson(file, value) {
  const temporary = `${file}.pending-${randomUUID()}`;
  await writeNew(temporary, value);
  await publishNew(temporary, file);
}
export async function outputDirectory(parent, id = randomUUID()) {
  if (!uuid(id)) fail('MANUAL_INPUT_INVALID', '备份或恢复标识必须为 UUID。');
  await mkdir(resolve(parent), { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolve(parent));
  const directory = resolve(canonical, id);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') fail('MANUAL_OUTPUT_EXISTS', '本次标识已经存在；旧证据不会覆盖。');
    throw error;
  }
  return directory;
}
export async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    fail('MANUAL_PRIVATE_DIRECTORY_REQUIRED', '备份目录必须由当前用户持有并限制为 0700。');
  return realpath(directory);
}
export async function hashFile(file, maximum = MAX_ARTIFACT_BYTES) {
  const handle = await privateHandle(file, maximum),
    hash = createHash('sha256'),
    before = await handle.stat();
  let bytes = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maximum) fail('MANUAL_ARTIFACT_TOO_LARGE', '产物超过受控大小。');
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      after.size !== bytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail('MANUAL_ARTIFACT_CHANGED', '读取期间产物发生变化。');
    return { sha256: hash.digest('hex'), sizeBytes: String(bytes) };
  } finally {
    await handle.close();
  }
}
export function contained(parent, child) {
  const part = relative(parent, child);
  return !part || (!part.startsWith('..') && !isAbsolute(part));
}
export function fileIn(directory, name) {
  if (basename(name) !== name || !/^data\.(pgdump|rdb|tar)$/.test(name))
    fail('MANUAL_MANIFEST_INVALID', '清单只能引用同目录下的固定产物名称。');
  return resolve(directory, name);
}
export function argumentsFor(options) {
  try {
    return parseArgs({
      options: { help: { type: 'boolean', default: false }, ...options },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    fail('MANUAL_ARGUMENTS_INVALID', '参数无效；使用 --help 查看受支持的选项。');
  }
}
export async function runManualCli(work) {
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24)
      fail('NODE_24_REQUIRED', '请使用 pnpm exec node 运行项目 Node 24。');
    await work();
  } catch (error) {
    console.error(
      JSON.stringify({
        code: error instanceof ManualDataError ? error.code : 'MANUAL_DATA_FAILED',
        message:
          error instanceof ManualDataError
            ? error.message
            : '手工数据操作未完成；原数据、维护状态和已有证据均保留。',
      }),
    );
    process.exitCode = 1;
  }
}
export async function retainedFailure(directory, error, stage) {
  await writeNew(resolve(directory, `failure-${randomUUID()}.json`), {
    toolVersion: MANUAL_DATA_VERSION,
    state: 'incomplete',
    stage,
    code: error instanceof ManualDataError ? error.code : 'MANUAL_DATA_FAILED',
    observedAt: new Date().toISOString(),
    maintenanceReleased: false,
  });
}
export async function readPrefix(file, bytes = 512) {
  const handle = await privateHandle(file, MAX_ARTIFACT_BYTES);
  try {
    const buffer = Buffer.alloc(bytes);
    const read = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
}
export function requiredPath(value) {
  return resolve(text(value, 4096));
}
export const streamFile = (file) =>
  createReadStream(file, { flags: constants.O_RDONLY | constants.O_NOFOLLOW });
export const contextPath = (file, value) => resolve(dirname(file), text(value, 4096));
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const digestJson = (value) => sha256(JSON.stringify(canonical(value)));
export function date(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail('MANUAL_TIME_INVALID', '时间必须是明确的 UTC 时间。');
  return new Date(value).toISOString();
}
export function entrypoint(url) {
  return Boolean(process.argv[1] && fileURLToPath(url) === resolve(process.argv[1]));
}
