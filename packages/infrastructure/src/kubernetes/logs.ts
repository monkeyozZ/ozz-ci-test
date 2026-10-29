import { Agent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { connectionMaterial, verifyCredentialTime } from './config.js';
import { KubernetesAdapterError, type ParsedKubernetesConnection } from './contracts.js';
import {
  createInspectionClient,
  safeKubernetesError,
  statusError,
  transportLimits,
} from './transport.js';

export interface PodLogSelection {
  namespace: string;
  name: string;
  uid: string;
  /** Retained v1 selections use this field. New selections carry the actual owner kind. */
  replicaSetUid?: string | null;
  owner?: { kind: 'ReplicaSet' | 'StatefulSet'; uid: string };
  container: string;
}

export interface PodLogOptions {
  signal: AbortSignal;
  follow: boolean;
  previous: boolean;
  tailLines: number;
}

export class PodLogError extends Error {
  constructor(
    readonly code: 'POD_LOGS_INPUT_INVALID' | 'POD_LOGS_TARGET_CHANGED' | 'POD_LOGS_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PodLogError';
  }
}

export interface PodLogSource {
  stream: IncomingMessage;
  close(): void;
}

/** The caller first proves service ownership. This transport rechecks the selected
 * Pod UID/controller and owns a single TLS connection, with no SDK Log helper. */
export class KubernetesPodLogs {
  private async verify(
    connection: ParsedKubernetesConnection,
    selection: PodLogSelection,
    signal: AbortSignal,
  ) {
    const inspection = await createInspectionClient(
      connection,
      transportLimits({ requestTimeoutMs: 10_000 }),
      signal,
    );
    try {
      const pod = await inspection.core.readNamespacedPod({
        namespace: selection.namespace,
        name: selection.name,
      });
      const owners =
        pod.metadata?.ownerReferences?.filter((value) => value.controller === true) ?? [];
      const owner = owners[0];
      const expected = selection.owner ?? { kind: 'ReplicaSet', uid: selection.replicaSetUid };
      if (
        pod.kind !== 'Pod' ||
        pod.apiVersion !== 'v1' ||
        pod.metadata?.name !== selection.name ||
        pod.metadata?.uid !== selection.uid ||
        pod.metadata?.namespace !== selection.namespace ||
        owners.length !== 1 ||
        owner?.apiVersion !== 'apps/v1' ||
        owner.kind !== expected.kind ||
        owner.uid !== expected.uid ||
        !pod.spec?.containers.some((container) => container.name === selection.container)
      )
        throw new PodLogError('POD_LOGS_TARGET_CHANGED');
    } catch (error) {
      if (error instanceof PodLogError) throw error;
      throw safeKubernetesError(error);
    } finally {
      inspection.close();
    }
  }

  async open(
    connection: ParsedKubernetesConnection,
    selection: PodLogSelection,
    options: PodLogOptions,
  ): Promise<PodLogSource> {
    const name = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
    if (
      ![selection.namespace, selection.name, selection.container].every(
        (value) => typeof value === 'string' && value.length <= 253 && name.test(value),
      ) ||
      (selection.owner && !['ReplicaSet', 'StatefulSet'].includes(selection.owner.kind)) ||
      ![selection.uid, selection.owner?.uid ?? selection.replicaSetUid].every(
        (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/u.test(value),
      ) ||
      typeof options.follow !== 'boolean' ||
      typeof options.previous !== 'boolean' ||
      !Number.isInteger(options.tailLines) ||
      options.tailLines < 1 ||
      options.tailLines > 1000
    )
      throw new PodLogError('POD_LOGS_INPUT_INVALID');
    verifyCredentialTime(connection, new Date());
    await this.verify(connection, selection, options.signal);
    if (options.signal.aborted) throw new KubernetesAdapterError('KUBERNETES_CANCELLED');
    const material = connectionMaterial(connection);
    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      ca: material.ca,
      cert: material.certificate,
      key: material.privateKey,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    const url = new URL(
      `/api/v1/namespaces/${encodeURIComponent(selection.namespace)}/pods/${encodeURIComponent(selection.name)}/log`,
      connection.endpoint,
    );
    url.search = new URLSearchParams({
      container: selection.container,
      follow: String(options.follow),
      previous: String(options.previous),
      tailLines: String(options.tailLines),
      timestamps: 'true',
      limitBytes: String(1024 * 1024),
    }).toString();
    const opened = await new Promise<PodLogSource>((resolve, reject) => {
      let settled = false;
      let source: IncomingMessage | undefined;
      const close = () => {
        clearTimeout(headerTimer);
        source?.destroy();
        request.destroy();
        agent.destroy();
      };
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error instanceof PodLogError ? error : safeKubernetesError(error));
        }
        close();
      };
      const request = httpsRequest(
        url,
        {
          method: 'GET',
          agent,
          signal: options.signal,
          maxHeaderSize: 16 * 1024,
          headers: {
            // API-server negotiation occurs before kubelet's text stream;
            // text/plain alone yields 406 on a real Kubernetes API server.
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'User-Agent': 'ozz-pod-logs/0.1',
            ...(material.token ? { Authorization: `Bearer ${material.token}` } : {}),
          },
        },
        (response) => {
          source = response;
          // A disconnect can race the consumer attaching its iterator.
          response.on('error', () => {});
          clearTimeout(headerTimer);
          const failure = statusError(response);
          if (failure) {
            fail(
              response.statusCode === 400 || response.statusCode === 404
                ? new PodLogError('POD_LOGS_UNAVAILABLE')
                : failure,
            );
            return;
          }
          const type = response.headers['content-type']?.split(';')[0]?.trim();
          if (
            type !== 'text/plain' ||
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity')
          ) {
            fail(new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE'));
            return;
          }
          settled = true;
          response.once('close', () => agent.destroy());
          resolve({ stream: response, close });
        },
      );
      const headerTimer = setTimeout(
        () => fail(new KubernetesAdapterError('KUBERNETES_TIMEOUT', true)),
        10_000,
      );
      headerTimer.unref();
      request.on('error', fail);
      request.end();
    });
    try {
      // Pod log requests have no UID precondition. A second read closes the
      // name-reuse gap before exposing any bytes to the consumer.
      await this.verify(connection, selection, options.signal);
      return opened;
    } catch (error) {
      opened.close();
      throw error;
    }
  }
}
