import type { ParsedKubernetesConnection } from '../kubernetes/contracts.js';
import {
  DatabaseExecError,
  executeDatabaseCheck,
  type DatabaseExecResult,
} from '../kubernetes/database-exec.js';
import type { InspectionClient } from '../kubernetes/transport.js';
import {
  WorkloadAdapterError,
  type DatabaseVerification,
  type ManagedWorkloadResource,
  type PublishedWorkload,
  type WorkloadDatabaseConfiguration,
  type WorkloadObservation,
  type WorkloadPodObservation,
  type WorkloadTarget,
} from './contracts.js';
import { keys, publishedController } from './names.js';
import { observeWorkload } from './observation.js';
import { safeWorkloadError } from './resources.js';

function initial(database: WorkloadDatabaseConfiguration, now: Date): DatabaseVerification {
  return {
    observedAt: now.toISOString(),
    state: 'unknown',
    engine: database.engine,
    authenticated: null,
    expectedMajor: database.expectedMajor,
    observedMajor: null,
    version: null,
    username: database.username,
    databaseName: database.databaseName,
    pod: null,
    redis:
      database.engine === 'redis'
        ? { aofEnabled: null, appendfsync: null, lastWriteStatus: null }
        : null,
    code: 'DATABASE_NOT_READY',
    message: '等待当前数据库 Pod 和认证验证。',
  };
}
function readyPod(
  observation: WorkloadObservation,
  published: PublishedWorkload,
): WorkloadPodObservation {
  const expected = publishedController(published),
    controller = observation.controller;
  const pods = observation.pods.filter(
    (pod) => pod.phase !== 'Succeeded' && pod.phase !== 'Failed',
  );
  if (
    observation.configurationState !== 'consistent' ||
    observation.podsTruncated ||
    !controller ||
    controller.kind !== 'StatefulSet' ||
    expected.kind !== 'StatefulSet' ||
    controller.uid !== expected.uid ||
    controller.deleting ||
    controller.snapshotId !== published.snapshotId ||
    controller.configRevision !== published.configRevision ||
    controller.image !== published.image ||
    controller.templateFingerprint !== published.templateFingerprint ||
    controller.workloadFingerprint !== published.workloadFingerprint ||
    controller.replicas !== 1 ||
    controller.currentReplicas !== 1 ||
    controller.updatedReplicas !== 1 ||
    controller.readyReplicas !== 1 ||
    pods.length !== 1 ||
    !pods[0]?.matchesControllerTemplate ||
    pods[0].ready !== true ||
    pods[0].phase !== 'Running' ||
    pods[0].deletionTimestamp ||
    pods[0].owner?.kind !== 'StatefulSet' ||
    pods[0].owner.uid !== expected.uid ||
    pods[0].snapshotId !== published.snapshotId ||
    pods[0].configRevision !== published.configRevision
  )
    throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
  return pods[0];
}
async function verifyPod(
  client: InspectionClient,
  target: WorkloadTarget,
  pod: WorkloadPodObservation,
  published: PublishedWorkload,
): Promise<void> {
  const actual = await client.core.readNamespacedPod({
    namespace: target.namespace,
    name: pod.name,
  });
  const owners =
    actual.metadata?.ownerReferences?.filter((owner) => owner.controller === true) ?? [];
  const expected = publishedController(published);
  if (
    actual.kind !== 'Pod' ||
    actual.metadata?.uid !== pod.uid ||
    actual.metadata.namespace !== target.namespace ||
    actual.metadata.deletionTimestamp ||
    owners.length !== 1 ||
    owners[0]?.apiVersion !== 'apps/v1' ||
    owners[0].kind !== expected.kind ||
    owners[0].uid !== expected.uid ||
    actual.metadata.labels?.[keys.snapshot] !== published.snapshotId ||
    !actual.spec?.containers.some(
      (container) => container.name === 'app' && container.image === published.image,
    )
  )
    throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
}
function parse(
  output: DatabaseExecResult,
  database: WorkloadDatabaseConfiguration,
  result: DatabaseVerification,
): void {
  if (output.exitCode !== 0) {
    result.state = 'failed';
    result.authenticated = false;
    result.code =
      output.exitCode === 41
        ? 'DATABASE_AUTHENTICATION_NOT_REQUIRED'
        : 'DATABASE_AUTHENTICATION_FAILED';
    result.message =
      output.exitCode === 41 ? '数据库接受了错误密码；认证保护未通过。' : '数据库凭证验证未通过。';
    return;
  }
  result.authenticated = true;
  if (database.engine === 'postgresql') {
    const data: unknown = JSON.parse(output.stdout.trim());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
    const row = data as Record<string, unknown>;
    if (
      typeof row.version !== 'string' ||
      typeof row.version_num !== 'string' ||
      !/^\d{5,6}$/u.test(row.version_num) ||
      row.username !== database.username ||
      row.database !== database.databaseName
    )
      throw new Error('invalid');
    const version = /^(\d{1,2}\.\d{1,3}(?:\.\d{1,3})?)(?: |$)/u.exec(row.version)?.[1];
    if (!version) throw new Error('invalid');
    result.version = version;
    result.observedMajor = Math.floor(Number(row.version_num) / 10000);
    if (Number(version.split('.')[0]) !== result.observedMajor) throw new Error('invalid');
  } else {
    const outputText = output.stdout.replaceAll('\r\n', '\n');
    const sections =
      /^__OZZ_USER__\n([^\n]+)\n__OZZ_SERVER__\n([\s\S]*?)__OZZ_PERSISTENCE__\n([\s\S]*?)__OZZ_APPENDONLY__\n([\s\S]*?)__OZZ_APPENDSYNC__\n([\s\S]*?)\s*$/u.exec(
        outputText,
      );
    if (!sections || sections[1] !== database.username) throw new Error('invalid');
    const field = (section: string, name: string) => {
      const matches = section.split('\n').filter((line) => line.startsWith(`${name}:`));
      if (matches.length !== 1) throw new Error('invalid');
      return matches[0]!.slice(name.length + 1).trim();
    };
    const version = field(sections[2]!, 'redis_version');
    if (!/^\d{1,2}\.\d{1,3}\.\d{1,3}$/u.test(version)) throw new Error('invalid');
    result.version = version;
    result.observedMajor = Number(version.split('.')[0]);
    const persistence = sections[3]!;
    const appendonly = sections[4]!.trim();
    const appendfsync = sections[5]!.trim();
    const sync = /^appendfsync\n(always|everysec|no)$/u.exec(appendfsync)?.[1];
    const last = field(persistence, 'aof_last_write_status');
    result.redis = {
      aofEnabled: field(persistence, 'aof_enabled') === '1' && appendonly === 'appendonly\nyes',
      appendfsync: sync === 'always' || sync === 'everysec' || sync === 'no' ? sync : null,
      lastWriteStatus: last === 'ok' ? 'ok' : last === 'err' ? 'error' : null,
    };
    if (
      !result.redis.aofEnabled ||
      result.redis.appendfsync !== 'everysec' ||
      result.redis.lastWriteStatus !== 'ok' ||
      field(persistence, 'aof_last_bgrewrite_status') !== 'ok'
    ) {
      result.state = 'failed';
      result.code = 'DATABASE_PERSISTENCE_NOT_READY';
      result.message = 'Redis 实际 AOF、everysec 或持久化写入状态未通过。';
      return;
    }
  }
  if (result.observedMajor !== database.expectedMajor) {
    result.state = 'failed';
    result.code = 'DATABASE_VERSION_MISMATCH';
    result.message = '实际数据库主版本与固定数据身份不符。';
    return;
  }
  result.state = 'ready';
  result.code = null;
  result.message = '数据库认证、身份与实际版本已验证。';
}
export async function verifyDatabaseWorkload(
  client: InspectionClient,
  connection: ParsedKubernetesConnection,
  target: WorkloadTarget,
  inventory: readonly ManagedWorkloadResource[],
  published: PublishedWorkload,
  database: WorkloadDatabaseConfiguration,
  limits: { maxPods: number; maxEvents: number },
  signal: AbortSignal,
  now: () => Date,
): Promise<DatabaseVerification> {
  const result = initial(database, now());
  try {
    const observation = await observeWorkload(client, target, inventory, limits, now());
    const selected = readyPod(observation, published);
    await verifyPod(client, target, selected, published);
    const output = await executeDatabaseCheck(
      connection,
      { namespace: target.namespace, name: selected.name },
      database.engine,
      signal,
    );
    await verifyPod(client, target, selected, published);
    const after = readyPod(
      await observeWorkload(client, target, inventory, limits, now()),
      published,
    );
    if (after.uid !== selected.uid) throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
    result.pod = {
      name: selected.name,
      uid: selected.uid,
      controller: publishedController(published),
    };
    try {
      parse(output, database, result);
    } catch {
      result.state = 'failed';
      result.code = 'DATABASE_VERIFICATION_INVALID';
      result.message = '数据库检查返回的受控字段不完整或身份不一致。';
    }
  } catch (error) {
    result.state = 'unknown';
    result.authenticated = null;
    result.code = error instanceof DatabaseExecError ? error.code : safeWorkloadError(error).code;
    result.message = '当前 Pod 身份、连接或数据库执行检查尚未确认；未宣告数据库就绪。';
  }
  result.observedAt = now().toISOString();
  return result;
}
