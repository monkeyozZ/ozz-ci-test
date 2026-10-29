import { date, digestJson, fail, record, sha256 } from './manual-data-core.mjs';
import { probes } from './manual-data-commands.mjs';

const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function outputJson(result) {
  try {
    const raw = result.stdout.toString('utf8');
    if (!Buffer.from(raw).equals(result.stdout)) throw new Error();
    return JSON.parse(raw);
  } catch {
    fail('MANUAL_PROBE_INVALID', '固定检查返回无效或不完整的数据。');
  }
}
export function postgresProof(raw, definition, database) {
  const expected = probes('postgresql', definition);
  if (
    !raw ||
    !/^17\.11(?: |$)/.test(raw.version) ||
    raw.versionNumber !== '170011' ||
    raw.username !== database.connection.username ||
    raw.database !== database.connection.database ||
    !Number.isInteger(raw.tableCount) ||
    raw.tableCount < expected.tables.length ||
    raw.tableCount > 256 ||
    !hash(raw.schemaSha256) ||
    raw.tables?.length !== expected.tables.length
  )
    fail('MANUAL_POSTGRES_PROOF', 'PostgreSQL 版本、身份、表结构或有界验证结果无效。');
  date(raw.transactionStartedAt);
  date(raw.observedAt);
  const tables = raw.tables.map((row, index) => {
    if (
      !row ||
      row.schema !== expected.tables[index].schema ||
      row.table !== expected.tables[index].table ||
      !Number.isInteger(row.rowCount) ||
      row.rowCount < 0 ||
      row.rowCount > 10_000 ||
      ![row.rowsSha256, row.columnsSha256, row.constraintsSha256].every(hash)
    )
      fail('MANUAL_POSTGRES_PROOF', '选定表缺失、超过 10000 行或结构/内容摘要不完整。');
    return {
      schema: row.schema,
      table: row.table,
      rowCount: row.rowCount,
      rowsSha256: row.rowsSha256,
      columnsSha256: row.columnsSha256,
      constraintsSha256: row.constraintsSha256,
    };
  });
  return {
    kind: 'postgresql-selected-tables-v1',
    definition: expected,
    tableCount: raw.tableCount,
    schemaSha256: raw.schemaSha256,
    tables,
  };
}
export function postgresEmpty(raw, database) {
  if (
    !raw ||
    !/^17\.11(?: |$)/.test(raw.version) ||
    raw.username !== database.connection.username ||
    raw.database !== database.connection.database ||
    raw.objects !== 0 ||
    raw.functions !== 0
  )
    fail('MANUAL_POSTGRES_NOT_EMPTY', '新目标数据库不是匹配版本的空库；不会覆盖或删除已有对象。');
}
export function redisProof(raw, definition, { checkClock = true } = {}) {
  const expected = probes('redis', definition);
  if (
    !Number.isSafeInteger(raw?.observedAtMs) ||
    raw.observedAtMs < 0 ||
    (checkClock && Math.abs(Date.now() - raw.observedAtMs) > 5000) ||
    raw.keys?.length !== expected.keys.length
  )
    fail('MANUAL_REDIS_PROOF', 'Redis 时间或固定键检查不完整；校准时钟后重新采集。');
  const keys = raw.keys.map((value, index) => {
    if (
      value?.key !== expected.keys[index] ||
      !['none', 'string'].includes(value.type) ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs < -2 ||
      (value.type === 'none' && (value.valueHex !== false || value.expiresAtMs !== -2)) ||
      (value.type !== 'none' &&
        (typeof value.valueHex !== 'string' ||
          value.valueHex.length > 524288 ||
          value.valueHex.length % 2 !== 0 ||
          !/^[a-f0-9]*$/.test(value.valueHex) ||
          value.expiresAtMs === -2))
    )
      fail('MANUAL_REDIS_PROOF', '首版只验证字符串键；类型、内容或绝对过期时间无效。');
    return {
      key: value.key,
      type: value.type,
      valueSha256: value.valueHex === false ? null : sha256(Buffer.from(value.valueHex, 'hex')),
      expiresAtMs: value.expiresAtMs,
    };
  });
  return {
    kind: 'redis-selected-string-keys-v1',
    definition: expected,
    observedAtMs: raw.observedAtMs,
    keys,
  };
}
export function expectedProof(kind, value) {
  if (kind === 'files') return value;
  record(
    value,
    kind === 'postgresql'
      ? ['kind', 'definition', 'tableCount', 'schemaSha256', 'tables']
      : ['kind', 'definition', 'observedAtMs', 'keys'],
  );
  const definition = probes(kind, value.definition);
  if (kind === 'postgresql') {
    if (
      value.kind !== 'postgresql-selected-tables-v1' ||
      !Number.isInteger(value.tableCount) ||
      value.tableCount < definition.tables.length ||
      value.tableCount > 256 ||
      !hash(value.schemaSha256) ||
      value.tables?.length !== definition.tables.length ||
      value.tables.some(
        (v, i) =>
          v?.schema !== definition.tables[i].schema ||
          v?.table !== definition.tables[i].table ||
          !Number.isInteger(v.rowCount) ||
          v.rowCount < 0 ||
          v.rowCount > 10000 ||
          ![v.rowsSha256, v.columnsSha256, v.constraintsSha256].every(hash),
      )
    )
      fail('MANUAL_POSTGRES_PROOF', '备份缺少有效的表/行/约束验证摘要。');
  } else if (
    value.kind !== 'redis-selected-string-keys-v1' ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.keys?.length !== definition.keys.length ||
    value.keys.some(
      (v, i) =>
        v?.key !== definition.keys[i] ||
        !['none', 'string'].includes(v.type) ||
        !Number.isSafeInteger(v.expiresAtMs) ||
        v.expiresAtMs < -2 ||
        (v.type === 'none'
          ? v.valueSha256 !== null || v.expiresAtMs !== -2
          : !hash(v.valueSha256) || v.expiresAtMs === -2),
    )
  )
    fail('MANUAL_REDIS_PROOF', '备份缺少有效的 Redis 键/值/绝对 TTL 摘要。');
  return value;
}
export function comparePostgres(expected, actual) {
  expectedProof('postgresql', expected);
  expectedProof('postgresql', actual);
  if (digestJson(expected) !== digestJson(actual))
    fail(
      'MANUAL_POSTGRES_DATA_MISMATCH',
      '新目标的用户表结构、选定表行、关键值或约束与备份不一致。',
    );
}
export function compareRedis(expected, actual) {
  expectedProof('redis', expected);
  expectedProof('redis', actual);
  if (
    digestJson(expected.definition) !== digestJson(actual.definition) ||
    actual.observedAtMs < expected.observedAtMs - 5000
  )
    fail('MANUAL_REDIS_DATA_MISMATCH', 'Redis 验证定义或时钟范围不一致。');
  const expired = [];
  for (let i = 0; i < expected.keys.length; i++) {
    const source = expected.keys[i],
      target = actual.keys[i];
    if (source.expiresAtMs > 0 && source.expiresAtMs <= actual.observedAtMs) {
      if (target.type !== 'none' || target.expiresAtMs !== -2)
        fail('MANUAL_REDIS_TTL_MISMATCH', '已到绝对过期时间的 Redis 键仍然存在。');
      expired.push(source.key);
    } else if (digestJson(source) !== digestJson(target))
      fail('MANUAL_REDIS_DATA_MISMATCH', 'Redis 的字符串键、GET 内容摘要或绝对过期时间不匹配。');
  }
  return {
    expiredKeys: expired,
    checkedKeys: expected.keys.length,
    observedAt: new Date(actual.observedAtMs).toISOString(),
  };
}
export function redisStatus(result, { appendonly = true } = {}) {
  const value = result.stdout.toString('utf8').replaceAll('\r\n', '\n');
  const parts =
    /^__SERVER__\n([\s\S]*?)__PERSISTENCE__\n([\s\S]*?)__APPENDONLY__\n([\s\S]*?)__APPENDFSYNC__\n([\s\S]*?)\s*$/.exec(
      value,
    );
  if (!parts) fail('MANUAL_REDIS_PERSISTENCE', 'Redis 持久化检查响应不完整。');
  const field = (body, key) => {
    const found = body.split('\n').filter((line) => line.startsWith(`${key}:`));
    if (found.length !== 1) fail('MANUAL_REDIS_PERSISTENCE', 'Redis 持久化字段缺失或重复。');
    return found[0].slice(key.length + 1).trim();
  };
  if (
    field(parts[1], 'redis_version') !== '7.4.11' ||
    field(parts[2], 'loading') !== '0' ||
    field(parts[2], 'aof_enabled') !== (appendonly ? '1' : '0') ||
    parts[3].trim() !== `appendonly\n${appendonly ? 'yes' : 'no'}` ||
    parts[4].trim() !== 'appendfsync\neverysec'
  )
    fail('MANUAL_REDIS_PERSISTENCE', 'Redis 实际版本、AOF 或 everysec 设置未通过。');
  if (
    appendonly &&
    ['aof_last_write_status', 'aof_last_bgrewrite_status'].some(
      (key) => field(parts[2], key) !== 'ok',
    )
  )
    fail('MANUAL_REDIS_PERSISTENCE', 'Redis AOF 写入或 rewrite 失败。');
  if (
    appendonly &&
    ['aof_rewrite_in_progress', 'aof_rewrite_scheduled'].some((key) => field(parts[2], key) !== '0')
  )
    fail('MANUAL_REDIS_PERSISTENCE', 'Redis AOF rewrite 尚未完成。');
  return {
    version: '7.4.11',
    aofEnabled: appendonly,
    appendfsync: 'everysec',
    lastWrite: appendonly ? 'ok' : null,
    rewrite: appendonly ? 'ok' : null,
  };
}
