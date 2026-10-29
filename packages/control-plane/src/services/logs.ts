import { StringDecoder } from 'node:string_decoder';
import { KubernetesPodLogs, PodLogError, type PodLogSource } from '@ozz/infrastructure/kubernetes';
import {
  KubernetesWorkloadAdapter,
  type KubernetesWorkloadManager,
} from '@ozz/infrastructure/workload';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError } from '../tasks/contracts.js';
import { TaskRepository } from '../tasks/repository.js';
import { readServiceSnapshot } from './snapshots.js';
import { databaseLogSecrets } from '../databases/runtime.js';
import { serviceFailure } from './executor.js';
import { LogRedactor } from './log-redaction.js';
import { currentTarget, inventory, kubeAccess, serviceInclude } from './persistence.js';

export interface ServiceLogInput {
  podUid: string;
  container: string;
  previous: boolean;
  follow: boolean;
  tailLines: number;
}

export type LogEndReason =
  'eof' | 'duration_limit' | 'byte_limit' | 'source_error' | 'access_changed';
export type ServiceLogEvent =
  | { type: 'log'; data: { text: string } }
  | { type: 'end'; data: { reason: LogEndReason; message: string } };

const endMessages: Record<LogEndReason, string> = {
  eof: '本次日志读取已结束；Pod 日志会随容器轮转或删除而丢失。',
  duration_limit: '已达到本次 60 秒读取上限，可重新连接。',
  byte_limit: '已达到本次 1 MiB 读取上限，可重新读取最新日志。',
  source_error: '日志连接已中断，请检查 Pod 状态后重新连接。',
  access_changed: '会话、凭证或服务目标已变化，日志连接已关闭。',
};

export interface ServiceLogSession {
  events: AsyncIterable<ServiceLogEvent>;
  close(): void;
}

/** No log text is persisted. Each reader has one owned upstream, bounded
 * lifetime/bytes and a periodically revalidated user, generation and target. */
export class ServiceLogReader {
  private readonly active = new Map<string, Set<() => void>>();

  constructor(
    private readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly workloads: Pick<
      KubernetesWorkloadManager,
      'observe'
    > = new KubernetesWorkloadAdapter(),
    private readonly upstream: Pick<KubernetesPodLogs, 'open'> = new KubernetesPodLogs(),
  ) {}

  async open(
    id: string,
    input: ServiceLogInput,
    principal: { userId: string; sessionId: string },
    clientSignal: AbortSignal,
  ): Promise<ServiceLogSession> {
    const entries = this.active.get(principal.userId) ?? new Set<() => void>();
    if (entries.size >= 4)
      throw new OperationRequestError(429, 'LOG_SESSION_LIMIT', '最多同时打开 4 个日志连接。');
    const abort = new AbortController();
    let reason: LogEndReason = 'eof';
    let source: PodLogSource | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cleaned = false;
    const stop = (next: LogEndReason) => {
      if (abort.signal.aborted) return;
      reason = next;
      abort.abort();
      source?.close();
      close();
    };
    const close = () => {
      if (cleaned) return;
      cleaned = true;
      stop(reason);
      clearTimeout(deadline);
      clearInterval(timer);
      clientSignal.removeEventListener('abort', close);
      entries.delete(close);
      if (!entries.size) this.active.delete(principal.userId);
    };
    entries.add(close);
    this.active.set(principal.userId, entries);
    const deadline = setTimeout(() => stop('duration_limit'), 60_000);
    deadline.unref();
    clientSignal.addEventListener('abort', close, { once: true });
    if (clientSignal.aborted) close();
    const db = this.repository.db;
    try {
      const context = await db.$transaction(async (tx) => {
        const service = await tx.service.findUnique({ where: { id }, include: serviceInclude });
        if (!service) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '服务不存在。');
        const state = await tx.controlPlaneState.findUniqueOrThrow({
          where: { id: 'control-plane' },
        });
        const target = await currentTarget(tx, service);
        const cluster = service.environment.project.cluster;
        const access = await kubeAccess(tx, this.cipher, cluster, target);
        const credential = await tx.secretReference.findUniqueOrThrow({
          where: { id: cluster.credentialRefId! },
        });
        return {
          service,
          state,
          target,
          access,
          credentialRevision: credential.revision,
          resources: await inventory(tx, target),
        };
      });
      const cluster = context.service.environment.project.cluster;
      const verify = async () => {
        const [session, state, service, credential] = await Promise.all([
          db.session.findUnique({ where: { id: principal.sessionId } }),
          db.controlPlaneState.findUnique({ where: { id: 'control-plane' } }),
          db.service.findUnique({
            where: { id },
            include: { environment: { include: { project: { include: { cluster: true } } } } },
          }),
          db.secretReference.findUnique({
            where: { id: cluster.credentialRefId! },
            select: { revision: true, expiresAt: true },
          }),
        ]);
        const current = service?.environment.project.cluster;
        if (
          !session ||
          session.adminId !== principal.userId ||
          session.revokedAt ||
          session.expiresAt <= new Date() ||
          !state ||
          state.generation !== context.state.generation ||
          state.installationId !== context.state.installationId ||
          !service ||
          service.environmentId !== context.service.environmentId ||
          service.environment.projectId !== context.target.projectId ||
          !current ||
          current.id !== cluster.id ||
          current.connectionRevision !== cluster.connectionRevision ||
          current.credentialRefId !== cluster.credentialRefId ||
          current.kubeSystemUid !== cluster.kubeSystemUid ||
          current.caFingerprint !== cluster.caFingerprint ||
          current.apiEndpoint !== cluster.apiEndpoint ||
          !credential ||
          credential.revision !== context.credentialRevision ||
          (credential.expiresAt && credential.expiresAt <= new Date())
        )
          throw new OperationRequestError(
            409,
            'LOG_ACCESS_CHANGED',
            '会话、凭证或服务目标已变化，请刷新后重新连接。',
          );
      };
      await verify();
      const observation = await this.workloads.observe(
        context.access.connection,
        context.access.target,
        context.resources,
        { signal: abort.signal },
      );
      const pod = observation.pods.find((value) => value.uid === input.podUid);
      if (!pod || !pod.containers.some((value) => value.name === input.container))
        throw new OperationRequestError(
          409,
          'POD_LOGS_TARGET_CHANGED',
          '所选 Pod 或容器已消失或不属于此服务，请刷新后选择。',
        );
      const secrets: string[] = [];
      if (!pod.snapshotId)
        throw new OperationRequestError(
          409,
          'LOG_SNAPSHOT_UNAVAILABLE',
          '所选 Pod 的发布快照无法验证，不能安全读取日志。',
        );
      {
        const deployment = await db.deployment.findFirst({
          where: { id: pod.snapshotId, serviceId: id },
        });
        const snapshot = deployment?.snapshotJson
          ? readServiceSnapshot(deployment.snapshotJson)
          : null;
        if (!snapshot || snapshot.serviceId !== id)
          throw new OperationRequestError(
            409,
            'LOG_SNAPSHOT_UNAVAILABLE',
            '所选 Pod 的发布快照无法验证，不能安全读取日志。',
          );
        for (const variable of snapshot.configuration.environment) {
          if (!variable.secretRefId) continue;
          const row = await db.secretReference.findUnique({ where: { id: variable.secretRefId } });
          if (!row)
            throw new OperationRequestError(
              409,
              'LOG_SECRET_UNAVAILABLE',
              '日志脱敏所需的秘密版本不可用。',
            );
          const value = this.cipher.decrypt(row)[variable.secretKey ?? 'value'];
          if (typeof value === 'string' && value) secrets.push(value);
        }
        secrets.push(
          ...(await db.$transaction((tx) => databaseLogSecrets(tx, this.cipher, snapshot))),
        );
      }
      await verify();
      const owner =
        pod.owner ??
        (pod.replicaSetUid ? { kind: 'ReplicaSet' as const, uid: pod.replicaSetUid } : null);
      if (!owner)
        throw new OperationRequestError(
          409,
          'POD_LOGS_TARGET_CHANGED',
          '所选 Pod 缺少可验证的控制器身份，请刷新后选择。',
        );
      source = await this.upstream.open(
        context.access.connection,
        {
          namespace: context.target.namespace,
          name: pod.name,
          uid: pod.uid,
          owner,
          container: input.container,
        },
        { ...input, signal: abort.signal },
      );
      if (abort.signal.aborted) {
        source.close();
        throw new OperationRequestError(409, 'LOG_SESSION_CLOSED', '本次日志连接已结束。');
      }
      await verify();
      if (abort.signal.aborted) {
        source.close();
        throw new OperationRequestError(409, 'LOG_SESSION_CLOSED', '本次日志连接已结束。');
      }
      let verifying = false;
      timer = setInterval(() => {
        if (verifying || abort.signal.aborted) return;
        verifying = true;
        void verify()
          .catch(() => stop('access_changed'))
          .finally(() => {
            verifying = false;
          });
      }, 5_000);
      timer.unref();
      const selectedSource = source;
      const events = (async function* (): AsyncGenerator<ServiceLogEvent> {
        const decoder = new StringDecoder('utf8');
        const redactor = new LogRedactor(secrets);
        let bytes = 0;
        let encodedBytes = 0;
        function* eventsFor(text: string): Generator<ServiceLogEvent> {
          for (let offset = 0; offset < text.length;) {
            if (abort.signal.aborted) return;
            let end = Math.min(offset + 4096, text.length);
            if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
            const part = text.slice(offset, end);
            const size = Buffer.byteLength(
              `event: log\ndata: ${JSON.stringify({ text: part })}\n\n`,
            );
            // Reserve room for the connection comment and explicit end event.
            // Short secrets and JSON escaping can expand otherwise small logs.
            if (encodedBytes + size > 1024 * 1024 - 512) {
              stop('byte_limit');
              return;
            }
            encodedBytes += size;
            yield { type: 'log', data: { text: part } };
            offset = end;
          }
        }
        try {
          for await (const raw of selectedSource.stream) {
            if (abort.signal.aborted) break;
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
            const remaining = 1024 * 1024 - bytes;
            const accepted = chunk.subarray(0, remaining);
            bytes += accepted.length;
            const text = redactor.push(decoder.write(accepted));
            if (text) yield* eventsFor(text);
            if (abort.signal.aborted) break;
            if (bytes >= 1024 * 1024) {
              stop('byte_limit');
              break;
            }
          }
          if (!abort.signal.aborted) {
            const text = redactor.push(decoder.end(), true);
            if (text) yield* eventsFor(text);
          }
        } catch {
          if (!abort.signal.aborted) reason = 'source_error';
        } finally {
          redactor.clear();
          secrets.length = 0;
          close();
        }
        yield { type: 'end', data: { reason, message: endMessages[reason] } };
      })();
      return { events, close };
    } catch (error) {
      close();
      if (error instanceof OperationRequestError) throw error;
      if (error instanceof PodLogError)
        throw new OperationRequestError(
          409,
          error.code,
          '所选 Pod、容器或上一轮日志已不可用，请刷新后重试。',
        );
      const failure = serviceFailure(error);
      throw new OperationRequestError(502, failure.code, failure.message);
    }
  }

  close(): void {
    for (const entries of this.active.values()) for (const close of entries) close();
  }
}
