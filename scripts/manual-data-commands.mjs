import { fail, identifier, record, text, uuid } from './manual-data-core.mjs';

export function probes(kind, value) {
  if (kind === 'files') {
    record(value ?? {}, []);
    return {};
  }
  if (kind === 'postgresql') {
    const input = record(value, ['tables']);
    if (!Array.isArray(input.tables) || !input.tables.length || input.tables.length > 32)
      fail('MANUAL_PROBES_INVALID', 'PostgreSQL 需要 1–32 张用于内容比较的完整表。');
    const tables = input.tables.map((value) => {
      const row = record(value, ['schema', 'table']);
      identifier(row.schema);
      identifier(row.table);
      if (row.schema === 'information_schema' || row.schema.startsWith('pg_'))
        fail('MANUAL_PROBES_INVALID', '只比较用户数据表。');
      return { schema: row.schema, table: row.table };
    });
    if (new Set(tables.map((v) => `${v.schema}.${v.table}`)).size !== tables.length)
      fail('MANUAL_PROBES_INVALID', '验证表不能重复。');
    return { tables };
  }
  if (kind === 'redis') {
    const input = record(value, ['database', 'keys']);
    if (
      !Number.isInteger(input.database) ||
      input.database < 0 ||
      input.database > 15 ||
      !Array.isArray(input.keys) ||
      !input.keys.length ||
      input.keys.length > 32 ||
      new Set(input.keys).size !== input.keys.length ||
      input.keys.some(
        (key) => typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/.test(key),
      )
    )
      fail('MANUAL_PROBES_INVALID', 'Redis 需要数据库 0–15 内 1–32 个有界固定键名。');
    return { database: input.database, keys: [...input.keys] };
  }
  fail('MANUAL_ENGINE_UNSUPPORTED', '不支持的数据引擎。');
}
const q = (value) => `"${identifier(value)}"`;
const digest = (expr) => `encode(sha256(convert_to((${expr})::text, 'UTF8')), 'hex')`;
const columns = `COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb)`;
const constraints = `COALESCE((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb)`;
const userTables = `FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p')`;
export function postgresProbeSql(definition) {
  const checked = probes('postgresql', definition);
  const tables = checked.tables.map((row) => {
    const name = `${q(row.schema)}.${q(row.table)}`;
    return `(SELECT jsonb_build_object('schema','${row.schema}','table','${row.table}','rowCount',(SELECT count(*) FROM (SELECT 1 FROM ${name} LIMIT 10001) bounded_rows),'rowsSha256',(SELECT ${digest(`COALESCE(jsonb_agg(value ORDER BY value COLLATE "C"),'[]'::jsonb)`)} FROM (SELECT ${digest('to_jsonb(t)')} AS value FROM ${name} t LIMIT 10001) bounded_rows),'columnsSha256',${digest(columns)},'constraintsSha256',${digest(constraints)}) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${row.schema}' AND c.relname='${row.table}' AND c.relkind IN ('r','p'))`;
  });
  return `SELECT jsonb_build_object('version',current_setting('server_version'),'versionNumber',current_setting('server_version_num'),'username',current_user,'database',current_database(),'transactionStartedAt',to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'tableCount',(SELECT count(*) ${userTables}),'schemaSha256',CASE WHEN (SELECT count(*) ${userTables})<=256 THEN (SELECT ${digest(`COALESCE(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'kind',c.relkind,'columns',${columns},'constraints',${constraints}) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"),'[]'::jsonb)`)} ${userTables}) ELSE NULL END,'tables',jsonb_build_array(${tables.join(',')}))::text;`;
}
const pgAuth = `export PGHOST=127.0.0.1 PGPORT=5432 PGCONNECT_TIMEOUT=4 PGAPPNAME=ozz-manual-data
export PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB" PGPASSWORD="$POSTGRES_PASSWORD"
export PGOPTIONS='-c statement_timeout=60000 -c search_path=pg_catalog'
[ -n "$PGPASSWORD" ]
if PGPASSWORD=ozz-deliberately-invalid-auth-probe psql -X -q -A -t -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then exit 41; fi
pg() { psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
`;
const redisAuth = `export REDISCLI_AUTH="$REDIS_PASSWORD"
[ -n "$REDISCLI_AUTH" ] && [ "$REDIS_USERNAME" = default ]
redis() { redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" "$@"; }
if REDISCLI_AUTH=ozz-deliberately-invalid-auth-probe redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" ACL WHOAMI >/dev/null 2>&1; then exit 41; fi
[ "$(redis ACL WHOAMI)" = default ]
`;
const redisStart = (
  appendonly,
) => `redis-server /run/ozz/database/redis.conf --bind 127.0.0.1 --dir /data --dbfilename dump.rdb --appendonly ${appendonly} --appendfsync everysec --daemonize yes --pidfile /tmp/ozz-redis.pid --logfile /tmp/ozz-redis.log --save ''
for attempt in $(seq 1 60); do
  if REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --raw -e -h 127.0.0.1 --user "$REDIS_USERNAME" PING 2>/dev/null | grep -qx PONG; then break; fi
  sleep 1
done
`;
const redisStop = `[ -f /tmp/ozz-redis.pid ] && [ ! -L /tmp/ozz-redis.pid ]
pid=$(cat /tmp/ozz-redis.pid)
case "$pid" in ''|*[!0-9]*) exit 50;; esac
redis SHUTDOWN NOSAVE
for attempt in $(seq 1 60); do if ! kill -0 "$pid" 2>/dev/null; then exit 0; fi; sleep 1; done
exit 51
`;
const lua = `local now=redis.call('TIME'); local out={observedAtMs=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000),keys={}}; for _,key in ipairs(KEYS) do local kind=redis.call('TYPE',key).ok; if kind~='none' and kind~='string' then return redis.error_reply('OZZ_STRING_PROBE_REQUIRED') end; local raw=false; if kind=='string' then raw=redis.call('GET',key) end; local hex=false; if raw then if string.len(raw)>262144 then return redis.error_reply('OZZ_PROBE_TOO_LARGE') end; hex=(raw:gsub('.',function(c) return string.format('%02x',string.byte(c)) end)); end; table.insert(out.keys,{key=key,type=kind,valueHex=hex,expiresAtMs=redis.call('PEXPIRETIME',key)}); end; return cjson.encode(out)`;
const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function operationId(value) {
  if (!uuid(value)) fail('MANUAL_OPERATION_ID', '操作 ID 必须为 UUID。');
  return value;
}
export const scratchPath = (id) => `/tmp/ozz-manual-${operationId(id)}`;
export const stagedPath = (id) => `${scratchPath(id)}/data.input`;
function artifactExpected(values) {
  if (
    typeof values.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(values.sha256) ||
    !/^[1-9]\d{0,10}$/.test(values.sizeBytes) ||
    Number(values.sizeBytes) > 1024 ** 3
  )
    fail('MANUAL_ARTIFACT_INTEGRITY', '缺少明确的产物大小和 SHA256。');
}
export function fixedCommand(operation, values = {}) {
  let code;
  const id = values.operationId ? operationId(values.operationId) : null;
  switch (operation) {
    case 'pg-backup': {
      const directory = scratchPath(id),
        sql = postgresProbeSql(values.probes);
      code = `${pgAuth}
umask 077; ulimit -f 1048576
mkdir ${directory}
: > ${directory}/snapshot.txt
psql -X -q -A -t -v ON_ERROR_STOP=1 > ${directory}/snapshot.txt <<'OZZ_SNAPSHOT_SQL' &
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot();
${sql}
SET LOCAL statement_timeout = 0;
SELECT pg_sleep(850);
OZZ_SNAPSHOT_SQL
holder=$!
trap 'kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true' EXIT
for attempt in $(seq 1 200); do
  [ "$(wc -l < ${directory}/snapshot.txt)" -ge 2 ] && break
  kill -0 "$holder" 2>/dev/null || exit 50
  sleep 0.1
done
snapshot=$(head -n 1 ${directory}/snapshot.txt)
case "$snapshot" in ''|*[!0-9A-Fa-f-]*) exit 50;; esac
[ "$(wc -l < ${directory}/snapshot.txt)" -ge 2 ]
pg_dump --format=custom --no-owner --no-acl --snapshot="$snapshot" --file=${directory}/data.pgdump
pg_restore --list ${directory}/data.pgdump >/dev/null
cat ${directory}/data.pgdump
`;
      break;
    }
    case 'pg-backup-metadata':
      code = `directory=${scratchPath(id)}
snapshot=$(head -n 1 "$directory/snapshot.txt")
case "$snapshot" in ''|*[!0-9A-Fa-f-]*) exit 50;; esac
printf '{"snapshot":"%s","observation":' "$snapshot"
sed -n '2p' "$directory/snapshot.txt"
printf '}\\n'`;
      break;
    case 'pg-probe':
      code = `${pgAuth}
pg <<'OZZ_PROBE_SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
${postgresProbeSql(values.probes)}
COMMIT;
OZZ_PROBE_SQL`;
      break;
    case 'pg-start':
      code = `[ "$PGDATA" = /var/lib/postgresql/data/pgdata ]
[ -d "$PGDATA" ] && [ ! -L "$PGDATA" ] && [ -f "$PGDATA/PG_VERSION" ] && [ ! -L "$PGDATA/PG_VERSION" ]
[ "$(cat "$PGDATA/PG_VERSION")" = 17 ]
[ -z "$(find "$PGDATA" -type l -print -quit)" ]
pg_ctl -D "$PGDATA" -l /tmp/ozz-postgres.log -o '-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp' -t 60 -w start >/dev/null
${pgAuth}
pg -c "SELECT json_build_object('version',current_setting('server_version'),'username',current_user,'database',current_database(),'objects',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'),'functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'))::text"`;
      break;
    case 'pg-import':
      code = `${pgAuth}
[ "$(pg -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'")" = 0 ]
pg_restore --single-transaction --exit-on-error --no-owner --no-acl --dbname="$POSTGRES_DB" ${stagedPath(id)}`;
      break;
    case 'pg-stop':
      code = `[ "$PGDATA" = /var/lib/postgresql/data/pgdata ]
pg_ctl -D "$PGDATA" -m fast -t 60 -w stop >/dev/null`;
      break;
    case 'pg-stop-if-running':
      code = `[ "$PGDATA" = /var/lib/postgresql/data/pgdata ]
if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDATA" -m fast -t 60 -w stop >/dev/null
else
  result=$?; [ "$result" = 3 ]
  for process in /proc/[0-9]*/comm; do [ -r "$process" ] || continue; name=$(cat "$process" 2>/dev/null || true); [ "$name" != postgres ] || exit 56; done
fi`;
      break;
    case 'upload':
      code = `umask 077; ulimit -f 1048576
mkdir ${scratchPath(id)}
set -o noclobber
cat > ${stagedPath(id)}`;
      break;
    case 'validate-upload': {
      artifactExpected(values);
      const file = stagedPath(id);
      if (!['postgresql', 'redis', 'files'].includes(values.engine))
        fail('MANUAL_ENGINE_UNSUPPORTED', '产物引擎无效。');
      code = `[ -f ${file} ] && [ ! -L ${file} ]
[ "$(stat -c %s ${file})" = ${values.sizeBytes} ]
[ "$(sha256sum ${file} | cut -d ' ' -f 1)" = ${values.sha256} ]
${values.engine === 'postgresql' ? `pg_restore --list ${file} >/dev/null` : values.engine === 'redis' ? `redis-check-rdb ${file} >/dev/null` : 'true'}
printf '{"integrity":"passed","engineValidator":"passed"}\\n'`;
      break;
    }
    case 'redis-probe': {
      const checked = probes('redis', values.probes);
      code = `${redisAuth}
redis -n ${checked.database} EVAL ${shell(lua)} ${checked.keys.length} ${checked.keys.map(shell).join(' ')}`;
      break;
    }
    case 'redis-status':
      code = `${redisAuth}
printf '__SERVER__\\n'; redis INFO server
printf '__PERSISTENCE__\\n'; redis INFO persistence
printf '__APPENDONLY__\\n'; redis CONFIG GET appendonly
printf '__APPENDFSYNC__\\n'; redis CONFIG GET appendfsync`;
      break;
    case 'redis-backup':
      code = `${redisAuth}
umask 077; ulimit -f 1048576
mkdir ${scratchPath(id)}
redis --rdb ${scratchPath(id)}/data.rdb >/dev/null
redis-check-rdb ${scratchPath(id)}/data.rdb >/dev/null
cat ${scratchPath(id)}/data.rdb`;
      break;
    case 'redis-start-empty':
      code = `[ ! -e /data/.ozz-preserved-${id} ]
for path in /data/* /data/.[!.]* /data/..?*; do
  [ -e "$path" ] || [ -L "$path" ] || continue
  case "$path" in /data/appendonlydir|/data/dump.rdb) [ ! -L "$path" ];; *) exit 53;; esac
done
${redisStart('yes')}
${redisAuth}
keyspace=$(redis INFO keyspace)
printf '%s\\n' "$keyspace" | tr -d '\\r' | grep -qx '# Keyspace'
if printf '%s\\n' "$keyspace" | grep -Eq '^db[0-9]+:'; then exit 54; fi
printf '{"allDatabasesEmpty":true}\\n'`;
      break;
    case 'redis-stop':
      code = `${redisAuth}
${redisStop}`;
      break;
    case 'redis-stop-if-running':
      code = `if [ ! -e /tmp/ozz-redis.pid ]; then
  for process in /proc/[0-9]*/comm; do [ -r "$process" ] || continue; name=$(cat "$process" 2>/dev/null || true); [ "$name" != redis-server ] || exit 56; done
  exit 0
fi
${redisAuth}
${redisStop}`;
      break;
    case 'redis-preserve-empty':
      code = `[ ! -e /tmp/ozz-redis.pid ]
umask 077
mkdir /data/.ozz-preserved-${operationId(id)}
for path in /data/* /data/.[!.]* /data/..?*; do
  [ -e "$path" ] || [ -L "$path" ] || continue
  case "$path" in /data/.ozz-preserved-${id}) ;; /data/appendonlydir|/data/dump.rdb) [ ! -L "$path" ]; leaf=$(basename "$path"); mv -T -- "$path" /data/.ozz-preserved-${id}/"$leaf";; *) exit 53;; esac
done
[ ! -e /data/dump.rdb ] && [ ! -e /data/appendonlydir ]`;
      break;
    case 'redis-load-rdb':
      code = `[ ! -e /tmp/ozz-redis.pid ] && [ ! -e /data/dump.rdb ] && [ ! -e /data/appendonlydir ]
[ -d /data/.ozz-preserved-${operationId(id)} ] && [ ! -L /data/.ozz-preserved-${id} ]
set -o noclobber; umask 077
cat ${stagedPath(id)} > /data/dump.rdb
redis-check-rdb /data/dump.rdb >/dev/null
${redisStart('no')}
${redisAuth}
[ "$(redis CONFIG GET appendonly | tail -n 1)" = no ]
printf '{"rdbLoadedWithAofDisabled":true}\\n'`;
      break;
    case 'redis-enable-aof':
      code = `${redisAuth}
[ "$(redis CONFIG GET appendonly | tail -n 1)" = no ]
redis CONFIG SET appendfsync everysec >/dev/null
redis CONFIG SET appendonly yes >/dev/null
for attempt in $(seq 1 180); do
  status=$(redis INFO persistence | tr -d '\\r')
  if printf '%s\\n' "$status" | grep -qx 'aof_rewrite_in_progress:0' && printf '%s\\n' "$status" | grep -qx 'aof_rewrite_scheduled:0' && printf '%s\\n' "$status" | grep -qx 'aof_last_bgrewrite_status:ok' && printf '%s\\n' "$status" | grep -qx 'aof_last_write_status:ok' && [ -s /data/appendonlydir/appendonly.aof.manifest ]; then
    [ "$(redis CONFIG GET appendonly | tail -n 1)" = yes ]
    [ "$(redis CONFIG GET appendfsync | tail -n 1)" = everysec ]
    printf '{"aofEnabled":true,"appendfsync":"everysec","rewrite":"ok","lastWrite":"ok"}\\n'; exit 0
  fi
  sleep 1
done
exit 55`;
      break;
    case 'files-version':
      code = 'tar --version | head -n 1';
      break;
    case 'files-backup':
    case 'files-probe':
      code = `tar --format=ustar --numeric-owner --one-file-system --sort=name -C /data -cf - .`;
      break;
    case 'files-import':
      code = `[ -d /data ] && [ ! -L /data ]
[ -z "$(find /data -mindepth 1 -print -quit)" ]
tar --extract --file=${stagedPath(id)} --directory=/data --numeric-owner --same-owner --same-permissions --keep-old-files --delay-directory-restore`;
      break;
    default:
      fail('MANUAL_OPERATION_UNSUPPORTED', '只接受已实现的固定备份、导入和验证操作。');
  }
  text(operation, 80);
  return [
    'timeout',
    '--signal=TERM',
    '--kill-after=5',
    '880',
    'bash',
    '--noprofile',
    '--norc',
    '-ceu',
    `set -o pipefail\n${code}`,
  ];
}
