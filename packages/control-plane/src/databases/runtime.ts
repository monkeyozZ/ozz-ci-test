import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@ozz/database';
import type { DatabaseVerification, WorkloadConfiguration } from '@ozz/infrastructure/workload';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError, TaskExecutionError } from '../tasks/contracts.js';
import type { ServiceConfiguration, ServiceSnapshot } from '../services/contracts.js';
import { json, type ServiceRecord } from '../services/persistence.js';
import { compileTemplate } from '../templates/catalog.js';
import type {
  DatabaseAuthenticationObservation,
  DatabaseBindingSnapshot,
  DatabaseOutputKey,
  DatabaseSnapshot,
} from './contracts.js';
import { assertDatabaseSnapshot, establishDatabaseFence } from './protection.js';

export async function assertDatabaseConfiguration(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
  candidate: ServiceConfiguration,
): Promise<void> {
  const database = await tx.databaseInstance.findUnique({ where: { serviceId: service.id } });
  if (!database) return;
  const expected = compileTemplate({
    id: database.engine as 'postgresql' | 'redis',
    version: database.templateVersion,
    parameters:
      database.engine === 'postgresql'
        ? { username: database.username, databaseName: database.databaseName! }
        : { redisDatabase: database.redisDatabase! },
  }).configuration;
  for (const key of ['image', 'replicas', 'command', 'args', 'ports', 'environment'] as const) {
    if (!isDeepStrictEqual(candidate[key], expected[key]))
      throw new OperationRequestError(
        409,
        'DATABASE_DATA_PROTECTED',
        '数据库使用固定的数据布局、启动参数、凭证和单实例控制器；普通配置只能调整资源与健康等待。',
      );
  }
}
async function password(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  identity: Pick<DatabaseSnapshot, 'credentialRefId' | 'credentialContentRevision'>,
  checkExpiry: boolean,
): Promise<string> {
  const secret = await tx.secretReference.findUnique({ where: { id: identity.credentialRefId } });
  if (
    !secret ||
    secret.kind !== 'database' ||
    secret.contentRevision !== identity.credentialContentRevision ||
    (checkExpiry && secret.expiresAt && secret.expiresAt <= new Date())
  )
    throw new TaskExecutionError('DATABASE_CREDENTIAL_CHANGED', '数据库的固定凭证版本不可用。');
  const value = cipher.decrypt(secret).password;
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    value.includes('\0')
  )
    throw new TaskExecutionError('DATABASE_CREDENTIAL_INVALID', '数据库凭证内容无效。');
  return value;
}
function outputValues(
  binding: DatabaseBindingSnapshot,
  value: string,
): Record<DatabaseOutputKey, string> {
  const user = encodeURIComponent(binding.username),
    encoded = encodeURIComponent(value);
  return {
    host: binding.host,
    port: String(binding.port),
    database: binding.databaseName ?? '',
    user: binding.username,
    password: value,
    db: String(binding.redisDatabase ?? 0),
    url:
      binding.engine === 'postgresql'
        ? `postgresql://${user}:${encoded}@${binding.host}:${binding.port}/${encodeURIComponent(binding.databaseName!)}`
        : `redis://${user}:${encoded}@${binding.host}:${binding.port}/${binding.redisDatabase ?? 0}`,
  };
}
export async function databaseBindingEnvironment(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  bindings: readonly DatabaseBindingSnapshot[],
  checkExpiry = true,
) {
  const environment: { name: string; value: string }[] = [];
  for (const binding of bindings) {
    const values = outputValues(binding, await password(tx, cipher, binding, checkExpiry));
    for (const [key, name] of Object.entries(binding.mapping)) {
      if (typeof name !== 'string' || !Object.hasOwn(values, key))
        throw new TaskExecutionError('DATABASE_BINDING_INVALID', '固定连接输出映射无效。');
      environment.push({ name, value: values[key as DatabaseOutputKey] });
    }
  }
  return environment;
}

/** Credential material exists only in the Workload call; public snapshots keep references. */
export async function augmentDatabaseRuntime(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  snapshot: ServiceSnapshot,
  configuration: WorkloadConfiguration,
): Promise<WorkloadConfiguration> {
  if (snapshot.version === 1) {
    await assertDatabaseSnapshot(tx, snapshot.serviceId, null);
    return configuration;
  }
  await assertDatabaseSnapshot(tx, snapshot.serviceId, snapshot.database);
  const bound = await databaseBindingEnvironment(tx, cipher, snapshot.databaseBindings);
  const environment = [...configuration.environment, ...bound];
  if (new Set(environment.map((entry) => entry.name)).size !== environment.length)
    throw new TaskExecutionError(
      'DATABASE_VARIABLE_CONFLICT',
      '数据库输出与手工变量重名，不能覆盖。',
    );
  if (Buffer.byteLength(JSON.stringify(environment), 'utf8') > 32 * 1024)
    throw new TaskExecutionError('SERVICE_VARIABLES_TOO_LARGE', '解析后的运行期变量超过允许大小。');
  const database = snapshot.database;
  if (!database) return { ...configuration, controller: snapshot.controller, environment };
  const value = await password(tx, cipher, database, true);
  const common = {
    ...configuration,
    controller: snapshot.controller,
    database: {
      engine: database.engine,
      expectedMajor: database.majorVersion,
      username: database.username,
      databaseName: database.databaseName,
    },
  };
  if (database.engine === 'postgresql')
    return {
      ...common,
      environment: [
        ...environment,
        { name: 'POSTGRES_USER', value: database.username },
        { name: 'POSTGRES_DB', value: database.databaseName! },
        { name: 'POSTGRES_PASSWORD', value },
        { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
        { name: 'POSTGRES_INITDB_ARGS', value: '--auth-host=scram-sha-256' },
      ],
    };
  const maxmemory =
    Math.min(128, Math.floor(configuration.resources.limits.memoryMiB / 2)) * 1024 * 1024;
  return {
    ...common,
    environment: [
      ...environment,
      { name: 'REDIS_USERNAME', value: database.username },
      { name: 'REDIS_PASSWORD', value },
    ],
    secretFiles: [
      {
        key: 'redis-config',
        path: '/run/ozz/database/redis.conf',
        mode: 0o440,
        value: `bind 0.0.0.0\nport 6379\nprotected-mode yes\naclfile /run/ozz/database/users.acl\ndir /data\nappendonly yes\nappendfsync everysec\naof-use-rdb-preamble yes\nsave ""\nmaxmemory ${maxmemory}\nmaxmemory-policy noeviction\nlogfile ""\n`,
      },
      {
        key: 'redis-acl',
        path: '/run/ozz/database/users.acl',
        mode: 0o440,
        value: `user default reset on #${createHash('sha256').update(value).digest('hex')} ~* &* +@all\n`,
      },
    ],
  };
}

export async function saveDatabaseVerification(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
  verification: DatabaseVerification,
  mode: 'execution' | 'observation' = 'execution',
): Promise<DatabaseAuthenticationObservation> {
  const database = await tx.databaseInstance.findUnique({
    where: { serviceId: service.id },
    include: { dataVolume: true },
  });
  if (
    !database ||
    verification.engine !== database.engine ||
    verification.expectedMajor !== database.majorVersion ||
    verification.username !== database.username ||
    verification.databaseName !== database.databaseName
  )
    throw new TaskExecutionError('DATABASE_IDENTITY_INVALID', '数据库认证观察与固定身份不匹配。');
  const pvcUid = database.dataVolume.pvcUid;
  if (!pvcUid)
    throw new TaskExecutionError(
      'DATABASE_INITIALIZATION_UNKNOWN',
      '数据库认证前需要确认原数据卷 UID。',
    );
  const verified =
    verification.state === 'ready' &&
    verification.authenticated === true &&
    verification.observedMajor === database.majorVersion &&
    verification.pod?.controller.kind === 'StatefulSet' &&
    (database.engine === 'postgresql' ||
      (verification.redis?.aofEnabled &&
        verification.redis.appendfsync === 'everysec' &&
        verification.redis.lastWriteStatus === 'ok'));
  const observation: DatabaseAuthenticationObservation = {
    state: verified ? 'ready' : verification.state === 'unknown' ? 'unknown' : 'failed',
    authenticated: verification.authenticated === true,
    engineVersion: verification.version,
    persistence: verified
      ? database.engine === 'postgresql'
        ? 'postgres_wal'
        : 'redis_aof_everysec'
      : 'unknown',
    podUid: verification.pod?.uid ?? null,
    pvcUid,
    observedAt: verification.observedAt,
    code: verified ? null : (verification.code ?? 'DATABASE_AUTHENTICATION_FAILED'),
    message: verified ? null : verification.message,
  };
  if (verified && mode === 'execution')
    await establishDatabaseFence(tx, database.dataVolumeId, pvcUid);
  await tx.databaseInstance.update({
    where: { id: database.id },
    data: {
      observationJson: json(observation),
      lastObservedAt: new Date(verification.observedAt),
      observationErrorCode: null,
      ...(mode === 'execution'
        ? {
            initializationState: verified
              ? 'verified'
              : observation.state === 'unknown'
                ? 'unknown'
                : 'authentication_failed',
            ...(verified
              ? {
                  initializedAt: database.initializedAt ?? new Date(verification.observedAt),
                  initializationPvcUid: pvcUid,
                }
              : {}),
          }
        : {}),
    },
  });
  return observation;
}
export async function databaseLogSecrets(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  snapshot: ServiceSnapshot,
): Promise<string[]> {
  if (snapshot.version === 1) return [];
  const values: string[] = [];
  if (snapshot.database) values.push(await password(tx, cipher, snapshot.database, false));
  for (const binding of snapshot.databaseBindings) {
    const raw = await password(tx, cipher, binding, false);
    values.push(raw, encodeURIComponent(raw), outputValues(binding, raw).url);
  }
  return values;
}
