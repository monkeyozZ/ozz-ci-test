import { createHash } from 'node:crypto';
import {
  MAX_ARTIFACT_BYTES,
  fail,
  hasControlCharacters,
  privateHandle,
} from './manual-data-core.mjs';

const BLOCK = 512;
function string(bytes, strict = false) {
  const end = bytes.indexOf(0),
    value = (end < 0 ? bytes : bytes.subarray(0, end)).toString('utf8');
  if (strict && end >= 0 && bytes.subarray(end).some((byte) => byte !== 0))
    fail('MANUAL_TAR_ENCODING', '归档文本字段包含歧义字节。');
  if (!Buffer.from(value).equals(end < 0 ? bytes : bytes.subarray(0, end)))
    fail('MANUAL_TAR_ENCODING', '归档文件名必须为有效 UTF-8。');
  return value;
}
function octal(bytes) {
  const value = string(bytes).trim();
  if (!/^[0-7]+$/.test(value)) fail('MANUAL_TAR_NUMBER', '归档仅接受 USTAR 八进制数字字段。');
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail('MANUAL_TAR_NUMBER', '归档数字超过边界。');
  return number;
}
function safePath(value) {
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    hasControlCharacters(value) ||
    value.length > 512
  )
    fail('MANUAL_TAR_PATH', '归档包含绝对路径、控制字符或不支持的路径。');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/$/, '');
  if (value === '.') value = '';
  const parts = value.split('/');
  if (value && parts.some((part) => !part || part === '.' || part === '..'))
    fail('MANUAL_TAR_PATH', '归档路径越界或不规范。');
  return value;
}
/** No extraction occurs here. Reject links, devices, sparse/PAX records and duplicate/path-type aliases. */
export async function inspectTar(
  file,
  { maxBytes = MAX_ARTIFACT_BYTES, maxEntries = 20_000 } = {},
) {
  const handle = await privateHandle(file, maxBytes);
  const info = await handle.stat();
  const entries = [],
    seen = new Map(),
    parents = new Set();
  let offset = 0,
    totalBytes = 0,
    zeroBlocks = 0,
    root = null;
  const read = async (position, size) => {
    const value = Buffer.alloc(size);
    const result = await handle.read(value, 0, size, position);
    if (result.bytesRead !== size) fail('MANUAL_TAR_TRUNCATED', '归档在完整块或内容之前中断。');
    return value;
  };
  try {
    if (info.size < 1024 || info.size % BLOCK !== 0)
      fail('MANUAL_TAR_TRUNCATED', '归档缺少完整 USTAR 结束块。');
    while (offset < info.size) {
      const header = await read(offset, BLOCK);
      offset += BLOCK;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks++;
        continue;
      }
      if (zeroBlocks) fail('MANUAL_TAR_TRAILING_DATA', '归档结束块之后存在附加记录。');
      if (
        string(header.subarray(257, 263)) !== 'ustar' ||
        string(header.subarray(263, 265)) !== '00'
      )
        fail('MANUAL_TAR_FORMAT', '首版只接收显式 --format=ustar 的普通文件/目录归档。');
      const checksum = octal(header.subarray(148, 156));
      let actualChecksum = 0;
      for (let i = 0; i < BLOCK; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
      if (actualChecksum !== checksum) fail('MANUAL_TAR_CHECKSUM', '归档头校验失败。');
      const type = String.fromCharCode(header[156]);
      if (!['0', '5', '\0'].includes(type))
        fail('MANUAL_TAR_ENTRY_TYPE', '拒绝链接、设备、FIFO、稀疏文件及扩展记录。');
      if (header.subarray(157, 257).some((byte) => byte !== 0))
        fail('MANUAL_TAR_ENTRY_TYPE', '普通文件和目录不能含链接目标。');
      const prefix = string(header.subarray(345, 500), true);
      const path = safePath(
        `${prefix ? prefix + '/' : ''}${string(header.subarray(0, 100), true)}`,
      );
      const size = octal(header.subarray(124, 136)),
        mode = octal(header.subarray(100, 108)),
        uid = octal(header.subarray(108, 116)),
        gid = octal(header.subarray(116, 124));
      if (
        size > maxBytes ||
        mode > 0o777 ||
        uid > 4294967294 ||
        gid > 4294967294 ||
        (type === '5' && size !== 0)
      )
        fail('MANUAL_TAR_METADATA', '归档大小、权限或 UID/GID 超出支持范围。');
      const directory = type === '5';
      if (!path) {
        if (!directory || root) fail('MANUAL_TAR_DUPLICATE', '归档根记录无效或重复。');
        root = { mode, uid, gid };
        continue;
      }
      if (seen.has(path)) fail('MANUAL_TAR_DUPLICATE', '归档含重复或等价路径。');
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        if (seen.get(parent) === 'file')
          fail('MANUAL_TAR_PATH_TYPE', '归档不能在普通文件下面创建条目。');
        parents.add(parent);
      }
      if (!directory && parents.has(path))
        fail('MANUAL_TAR_PATH_TYPE', '归档不能把已有目录路径改为文件。');
      seen.set(path, directory ? 'directory' : 'file');
      if (entries.length >= maxEntries)
        fail('MANUAL_TAR_TOO_MANY_ENTRIES', '归档条目数超过首版支持边界。');
      totalBytes += size;
      if (totalBytes > maxBytes) fail('MANUAL_TAR_TOO_LARGE', '归档展开总大小超过边界。');
      const hash = createHash('sha256');
      let remaining = size;
      while (remaining) {
        const amount = Math.min(64 * 1024, remaining);
        hash.update(await read(offset, amount));
        offset += amount;
        remaining -= amount;
      }
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      if (padding && !(await read(offset, padding)).every((byte) => byte === 0))
        fail('MANUAL_TAR_PADDING', '归档内容填充不是零字节。');
      offset += padding;
      entries.push({
        path,
        type: directory ? 'directory' : 'file',
        mode,
        uid,
        gid,
        sizeBytes: String(size),
        sha256: directory ? null : hash.digest('hex'),
      });
    }
    if (zeroBlocks < 2) fail('MANUAL_TAR_TRUNCATED', '归档缺少两个结束块。');
    const after = await handle.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      fail('MANUAL_ARTIFACT_CHANGED', '归档检查期间文件发生变化。');
    return {
      format: 'ustar-regular-v1',
      root,
      entries: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      totalBytes: String(totalBytes),
      entryCount: entries.length,
    };
  } finally {
    await handle.close();
  }
}
