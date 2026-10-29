import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KubernetesPodLogs,
  type PodLogSelection,
} from '../../packages/infrastructure/dist/kubernetes.js';
import { WorkloadFixture } from './workload-fixture.js';

describe('owned Kubernetes Pod log transport', () => {
  const fixture = new WorkloadFixture();
  const adapter = new KubernetesPodLogs();
  const legacyReplicaSetUid = randomUUID();
  let actualOwnerKind: 'ReplicaSet' | 'StatefulSet' = 'ReplicaSet';
  const selection: PodLogSelection = {
    namespace: 'ozz-log-protocol',
    name: 'app-abcdef',
    uid: randomUUID(),
    replicaSetUid: legacyReplicaSetUid,
    container: 'app',
  };
  let mode: 'finite' | 'follow' | 'redirect' | 'forbidden' | 'missing' | 'replaced' | 'flood' =
    'finite';
  let reads = 0;
  let logRequests = 0;
  let closed = 0;
  let redirects = 0;
  let query: URLSearchParams;

  beforeAll(async () => {
    await fixture.start();
    // Reuse only the local TLS/connection fixture; these routes deliberately
    // exercise the real HTTPS transport, without a Kubernetes SDK mock.
    fixture.server.removeAllListeners('request');
    fixture.server.on('request', (request, response) => {
      const url = new URL(request.url!, fixture.endpoint);
      if (request.headers.authorization !== `Bearer ${fixture.token}`) {
        response.writeHead(401).end();
        return;
      }
      if (url.pathname.endsWith('/sink')) {
        redirects++;
        response.end();
        return;
      }
      if (!url.pathname.endsWith('/log')) {
        reads++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
              name: selection.name,
              namespace: selection.namespace,
              uid:
                mode === 'missing' || (mode === 'replaced' && reads > 1)
                  ? randomUUID()
                  : selection.uid,
              ownerReferences: [
                {
                  apiVersion: 'apps/v1',
                  kind: actualOwnerKind,
                  name: 'app-rs',
                  uid: selection.owner?.uid ?? selection.replicaSetUid,
                  controller: true,
                },
              ],
            },
            spec: { containers: [{ name: selection.container, image: 'example' }] },
          }),
        );
        return;
      }
      logRequests++;
      query = url.searchParams;
      response.once('close', () => {
        closed++;
      });
      if (request.headers.accept !== '*/*') {
        response.writeHead(406, { 'content-type': 'application/json' }).end();
        return;
      }
      if (mode === 'redirect') {
        response.writeHead(302, { Location: fixture.endpoint + '/sink' }).end();
        return;
      }
      if (mode === 'forbidden') {
        response
          .writeHead(403, { 'content-type': 'application/json' })
          .end(JSON.stringify({ message: fixture.token }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.flushHeaders();
      if (mode === 'follow') {
        response.write('first line\n');
        return;
      }
      if (mode === 'flood') {
        const chunk = Buffer.alloc(16 * 1024, 120);
        const write = () => {
          while (!response.destroyed) {
            if (!response.write(chunk)) {
              response.once('drain', write);
              return;
            }
          }
        };
        write();
        return;
      }
      response.end('2026-10-26T00:00:00Z 日志第一行\nsecond line\n');
    });
  });
  beforeEach(() => {
    mode = 'finite';
    reads = 0;
    logRequests = 0;
    closed = 0;
    redirects = 0;
    actualOwnerKind = 'ReplicaSet';
    delete selection.owner;
    selection.replicaSetUid = legacyReplicaSetUid;
  });
  afterAll(() => fixture.close());

  const open = (abort = new AbortController()) =>
    adapter.open(fixture.connection(), selection, {
      signal: abort.signal,
      follow: mode === 'follow' || mode === 'flood',
      previous: true,
      tailLines: 23,
    });

  it('reads finite UTF-8 logs only after two UID/controller checks', async () => {
    const source = await open();
    let text = '';
    for await (const chunk of source.stream) text += Buffer.from(chunk).toString('utf8');
    source.close();
    expect(text).toContain('日志第一行');
    expect(reads).toBe(2);
    expect(Object.fromEntries(query)).toMatchObject({
      container: 'app',
      previous: 'true',
      follow: 'false',
      tailLines: '23',
      limitBytes: '1048576',
    });
  });

  it('rejects a stale UID before opening a log request', async () => {
    mode = 'missing';
    await expect(open()).rejects.toMatchObject({ code: 'POD_LOGS_TARGET_CHANGED' });
    expect(logRequests).toBe(0);
  });

  it('checks a direct StatefulSet owner without inventing a ReplicaSet UID', async () => {
    actualOwnerKind = 'StatefulSet';
    selection.owner = { kind: 'StatefulSet', uid: randomUUID() };
    selection.replicaSetUid = null;
    const source = await open();
    let output = '';
    for await (const chunk of source.stream) output += Buffer.from(chunk).toString('utf8');
    source.close();
    expect(output).toContain('日志第一行');
    expect(reads).toBe(2);
  });

  it('does not accept the same owner UID under a different controller kind', async () => {
    selection.owner = { kind: 'StatefulSet', uid: legacyReplicaSetUid };
    selection.replicaSetUid = null;
    await expect(open()).rejects.toMatchObject({ code: 'POD_LOGS_TARGET_CHANGED' });
    expect(logRequests).toBe(0);
  });

  it('closes a Pod name-reuse race without exposing bytes', async () => {
    mode = 'replaced';
    await expect(open()).rejects.toMatchObject({ code: 'POD_LOGS_TARGET_CHANGED' });
    expect(logRequests).toBe(1);
    await expect.poll(() => closed).toBe(1);
  });

  it('rejects redirects without forwarding authentication', async () => {
    mode = 'redirect';
    await expect(open()).rejects.toMatchObject({ code: 'KUBERNETES_REDIRECT_REJECTED' });
    expect(redirects).toBe(0);
  });

  it('reports authorization failure without retaining the Kubernetes body', async () => {
    mode = 'forbidden';
    const error = await open().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'KUBERNETES_FORBIDDEN' });
    expect(String(error) + JSON.stringify(error)).not.toContain(fixture.token);
  });

  it('owns and closes the live source when the consumer disconnects', async () => {
    mode = 'follow';
    const abort = new AbortController();
    const source = await open(abort);
    const iterator = source.stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    abort.abort();
    source.close();
    await expect.poll(() => closed).toBe(1);
    expect(source.stream.destroyed).toBe(true);
  });

  it('keeps a stalled consumer bounded through socket backpressure', async () => {
    mode = 'flood';
    const abort = new AbortController();
    const source = await open(abort);
    await delay(100);
    expect(source.stream.readableLength).toBeLessThanOrEqual(128 * 1024);
    abort.abort();
    source.close();
    await expect.poll(() => closed).toBe(1);
  });
});
