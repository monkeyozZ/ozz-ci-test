import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Writable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  KubernetesAdapter,
  parseKubeconfig,
} from '../../packages/infrastructure/dist/kubernetes.js';

// Dependency resolution stays inside the workspace package; no global kubeconfig
// or Kubernetes/SSH tool installation is read or changed by this probe.
const dependency = createRequire(
  new URL('../../packages/infrastructure/package.json', import.meta.url),
);
const sdk = await import(pathToFileURL(dependency.resolve('@kubernetes/client-node')).href);
const { WebSocketHandler } = await import(
  pathToFileURL(dependency.resolve('@kubernetes/client-node/dist/web-socket-handler.js')).href
);
const WebSocket = createRequire(dependency.resolve('@kubernetes/client-node'))('ws');
const output = resolve('tests/probes/results/kubernetes-sdk.json');
const runId = randomUUID().slice(0, 8);
const namespace = `ozz-b04-${runId}`;
const inputPaths = ['a', 'b'].map((name) =>
  resolve(`.local/local-lab/credentials/${name}.kubeconfig.json`),
);
const report = {
  runId,
  startedAt: new Date().toISOString(),
  node: process.version,
  sdk: '2.0.1',
  environment: 'local Lima VZ / real K3s APIs',
  cloudValidated: false,
  checks: [],
  inspections: [],
  cleanup: [],
  limitations: [
    'This is a dependency/protocol probe, not the log or interactive terminal product.',
    'IngressClass and StorageClass discovery does not validate public routing or PVC durability.',
  ],
};
const cleanup = [];
const configurations = [];
const { AbortController, AbortSignal, clearTimeout } = globalThis;

/** Uses only the public SDK extension points to own dispatcher/agent lifetimes. */
class OwnedKubeConfig extends sdk.KubeConfig {
  dispatchers = new Set();
  agents = new Set();
  createDispatcherOptions(cluster, options) {
    const result = super.createDispatcherOptions(cluster, { ...options, rejectUnauthorized: true });
    return result;
  }
  async applySecurityAuthentication(context) {
    await super.applySecurityAuthentication(context);
    const dispatcher = context.getDispatcher();
    if (dispatcher) this.dispatchers.add(dispatcher);
    context.setSignal(AbortSignal.timeout(15_000));
  }
  async applyToHTTPSOptions(options) {
    options.rejectUnauthorized = true;
    await super.applyToHTTPSOptions(options);
    if (options.agent && typeof options.agent.destroy === 'function')
      this.agents.add(options.agent);
  }
  async close() {
    for (const agent of this.agents) agent.destroy();
    const results = await Promise.allSettled(
      [...this.dispatchers].map((dispatcher) => dispatcher.destroy()),
    );
    assert(results.every((result) => result.status === 'fulfilled'));
    this.agents.clear();
    this.dispatchers.clear();
  }
}

async function load(path) {
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode & 0o077, 0, 'Probe kubeconfig must be protected');
  const raw = await readFile(path, 'utf8');
  const parsed = parseKubeconfig(raw);
  const config = new OwnedKubeConfig();
  config.loadFromString(raw);
  configurations.push(config);
  return {
    raw,
    parsed,
    config,
    core: config.makeApiClient(sdk.CoreV1Api),
    rbac: config.makeApiClient(sdk.RbacAuthorizationV1Api),
  };
}

async function until(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await delay(75);
  } while (Date.now() < deadline);
  throw new Error('PROBE_WAIT_TIMEOUT');
}

async function check(name, action) {
  report.currentCheck = name;
  const started = performance.now();
  const details = await action();
  report.checks.push({
    name,
    passed: true,
    durationMs: Math.round(performance.now() - started),
    details,
  });
  console.log(JSON.stringify({ check: name, passed: true }));
  return details;
}

function publicInspection(name, value) {
  return {
    name,
    endpoint: value.endpoint,
    version: value.version,
    identity: value.identity,
    credential: {
      authentication: value.credential.authentication,
      expiresAt: value.credential.expiresAt,
    },
    nodes: value.nodes,
    metrics: value.metrics,
    capabilities: value.capabilities,
    workloads: { state: value.workloads.state, collections: value.workloads.collections },
    permissions: value.permissions,
    observedAt: value.observedAt,
  };
}

async function remove(core, kind, name, uid, extra = {}) {
  const body = { preconditions: { uid }, propagationPolicy: 'Foreground', gracePeriodSeconds: 0 };
  try {
    await core[`delete${kind}`]({ name, body, ...extra });
    const entry = { kind, name, requested: true, uidPinned: true, confirmedAbsent: false };
    report.cleanup.push(entry);
    await until(async () => {
      try {
        await core[`read${kind}`]({ name, ...extra });
        return false;
      } catch (error) {
        if (error.code === 404) return true;
        throw error;
      }
    });
    entry.confirmedAbsent = true;
  } catch (error) {
    if (error.code !== 404) throw error;
    report.cleanup.push({
      kind,
      name,
      alreadyAbsent: true,
      uidPinned: true,
      confirmedAbsent: true,
    });
  }
}

async function createNamespace(target) {
  const value = await target.core.createNamespace({
    body: {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: { 'app.kubernetes.io/managed-by': 'ozz-sdk-probe', 'ozz-probe-id': runId },
      },
    },
  });
  cleanup.push(() => remove(target.core, 'Namespace', namespace, value.metadata.uid));
  return value;
}

async function inspectTwo(targets) {
  const adapter = new KubernetesAdapter();
  const values = await Promise.all(targets.map((target) => adapter.inspect(target.parsed)));
  assert.notEqual(values[0].identity.kubeSystemUid, values[1].identity.kubeSystemUid);
  assert.notEqual(values[0].identity.caFingerprint, values[1].identity.caFingerprint);
  assert.equal(values[0].nodes[0].name, values[1].nodes[0].name);
  assert.notEqual(values[0].nodes[0].uid, values[1].nodes[0].uid);
  for (const [index, value] of values.entries())
    report.inspections.push(publicInspection(index === 0 ? 'a' : 'b', value));
  return {
    sameNodeName: true,
    distinctNodeUid: true,
    distinctClusterUid: true,
    distinctCa: true,
    nodes: values.map((value) => value.nodes.length),
  };
}

function tokenConfig(target, token) {
  const selected = target.config.getCurrentCluster();
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    preferences: {},
    clusters: [
      {
        name: 'same-cluster',
        cluster: { server: selected.server, 'certificate-authority-data': selected.caData },
      },
    ],
    users: [{ name: 'same-user', user: { token } }],
    contexts: [{ name: 'same-context', context: { cluster: 'same-cluster', user: 'same-user' } }],
    'current-context': 'same-context',
  });
}

async function credentialRotation(target) {
  const roleName = namespace;
  const role = await target.rbac.createClusterRole({
    body: {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: roleName, labels: { 'ozz-probe-id': runId } },
      rules: [
        {
          apiGroups: [''],
          resources: ['nodes', 'namespaces', 'pods'],
          verbs: ['get', 'list', 'watch'],
        },
        {
          apiGroups: ['apps'],
          resources: ['deployments', 'statefulsets', 'daemonsets'],
          verbs: ['get', 'list'],
        },
        { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['list'] },
        { apiGroups: ['networking.k8s.io'], resources: ['ingressclasses'], verbs: ['list'] },
        { apiGroups: ['storage.k8s.io'], resources: ['storageclasses'], verbs: ['list'] },
        { apiGroups: ['metrics.k8s.io'], resources: ['nodes'], verbs: ['list'] },
      ],
    },
  });
  cleanup.push(() => remove(target.rbac, 'ClusterRole', roleName, role.metadata.uid));
  const binding = await target.rbac.createClusterRoleBinding({
    body: {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: roleName },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: roleName },
      subjects: [{ kind: 'ServiceAccount', name: 'same-user', namespace }],
    },
  });
  cleanup.push(() => remove(target.rbac, 'ClusterRoleBinding', roleName, binding.metadata.uid));
  const create = () =>
    target.core.createNamespacedServiceAccount({
      namespace,
      body: { metadata: { name: 'same-user' } },
    });
  const token = async () =>
    (
      await target.core.createNamespacedServiceAccountToken({
        namespace,
        name: 'same-user',
        body: {
          apiVersion: 'authentication.k8s.io/v1',
          kind: 'TokenRequest',
          spec: { audiences: [], expirationSeconds: 600 },
        },
      })
    ).status.token;
  const account = await create();
  const old = parseKubeconfig(tokenConfig(target, await token()));
  const adapter = new KubernetesAdapter();
  const initial = await adapter.inspect(old);
  assert.equal(initial.permissions.clusterWideAdmin, false);
  await remove(target.core, 'NamespacedServiceAccount', 'same-user', account.metadata.uid, {
    namespace,
  });
  await until(async () => {
    try {
      await adapter.inspect(old);
      return false;
    } catch (error) {
      if (error.code === 'KUBERNETES_UNAUTHENTICATED') return true;
      throw error;
    }
  }, 70_000);
  await create();
  const next = parseKubeconfig(tokenConfig(target, await token()));
  const renewed = await adapter.inspect(next, { expectedIdentity: initial.identity });
  assert.equal(renewed.identity.kubeSystemUid, initial.identity.kubeSystemUid);
  assert.equal(renewed.credential.expirationSource, 'token_claim');
  return {
    oldTokenRevoked: true,
    replacementAccepted: true,
    clusterUidPreserved: true,
    broadPrivileges: false,
  };
}

async function watchRecovery(target) {
  const existing = await target.core.listNamespacedConfigMap({ namespace });
  let resourceVersion = existing.metadata.resourceVersion;
  const events = [];
  let completed = 0;
  const watch = new sdk.Watch(target.config);
  watch.requestTimeoutMs = 5000;
  const start = () =>
    watch.watch(
      `/api/v1/namespaces/${namespace}/configmaps`,
      { resourceVersion, allowWatchBookmarks: true, timeoutSeconds: 10 },
      (type, object) => {
        if (object.metadata?.resourceVersion) resourceVersion = object.metadata.resourceVersion;
        events.push({ type, name: object.metadata?.name, uid: object.metadata?.uid });
      },
      () => {
        completed += 1;
      },
    );
  let controller = await start();
  try {
    const created = await target.core.createNamespacedConfigMap({
      namespace,
      body: { metadata: { name: 'recovery' }, data: { revision: 'one' } },
    });
    await until(() =>
      events.some((event) => event.type === 'ADDED' && event.uid === created.metadata.uid),
    );
    controller.abort();
    await until(() => completed === 1);
    await target.core.replaceNamespacedConfigMap({
      namespace,
      name: 'recovery',
      body: {
        ...created,
        data: { revision: 'two' },
      },
    });
    controller = await start();
    await until(() =>
      events.some((event) => event.type === 'MODIFIED' && event.uid === created.metadata.uid),
    );
    controller.abort();
    await until(() => completed === 2);
    return {
      added: true,
      recoveredMissedModification: true,
      doneCalledExactlyOncePerWatch: completed === 2,
    };
  } finally {
    controller.abort();
  }
}

async function oldResourceVersion(target) {
  const events = [];
  let complete = false;
  const watch = new sdk.Watch(target.config);
  watch.requestTimeoutMs = 2000;
  const controller = await watch.watch(
    `/api/v1/namespaces/${namespace}/configmaps`,
    { resourceVersion: '1', timeoutSeconds: 1 },
    (type, object) => {
      events.push({ type, code: object.code });
    },
    (error) => {
      if (error?.statusCode) events.push({ type: 'HTTP_ERROR', code: error.statusCode });
      complete = true;
    },
  );
  try {
    await until(() => complete || events.some((event) => event.code === 410), 5000);
    const expired = events.some((event) => event.code === 410);
    if (expired) {
      const current = await target.core.listNamespacedConfigMap({ namespace });
      assert(current.items.some((item) => item.metadata.name === 'recovery'));
      return { source: 'real API', expired410: true, relistSucceeded: true };
    }
    return {
      source: 'real API',
      expired410: false,
      note: 'This API still retains resourceVersion 1; TLS protocol tests independently cover 410 classification.',
    };
  } finally {
    controller.abort();
  }
}

async function createStreamPod(target) {
  const line = 'x'.repeat(1024);
  const installed = await target.core.listNamespacedPod({
    namespace: 'kube-system',
    labelSelector: 'app.kubernetes.io/name=traefik',
    limit: 10,
  });
  const image = installed.items
    .flatMap((pod) => pod.status?.containerStatuses ?? [])
    .find((container) => container.name === 'traefik')?.imageID;
  assert(
    /^docker\.io\/rancher\/mirrored-library-traefik@sha256:[a-f0-9]{64}$/u.test(image ?? ''),
    'The local SDK probe requires the already-running lab Traefik image digest',
  );
  const pod = await target.core.createNamespacedPod({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'streams', labels: { 'ozz-probe-id': runId } },
      spec: {
        restartPolicy: 'Never',
        terminationGracePeriodSeconds: 1,
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'stream',
            image,
            imagePullPolicy: 'Never',
            command: ['sh', '-c', `line='${line}'; while :; do echo "$line"; sleep 0.02; done`],
            resources: {
              requests: { cpu: '10m', memory: '8Mi' },
              limits: { cpu: '100m', memory: '32Mi' },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
          },
        ],
      },
    },
  });
  cleanup.push(() =>
    remove(target.core, 'NamespacedPod', 'streams', pod.metadata.uid, { namespace }),
  );
  await until(async () => {
    const current = await target.core.readNamespacedPod({ namespace, name: 'streams' });
    report.lastPodWait = {
      phase: current.status?.phase ?? 'Unknown',
      containers: (current.status?.containerStatuses ?? []).map((container) => ({
        name: container.name,
        waitingReason: container.state?.waiting?.reason ?? null,
        exitCode: container.state?.terminated?.exitCode ?? null,
      })),
      conditions: (current.status?.conditions ?? []).map((condition) => ({
        type: condition.type,
        status: condition.status,
        reason: condition.reason ?? null,
      })),
    };
    if (current.status?.phase === 'Failed') throw new Error('PROBE_POD_FAILED');
    return current.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    );
  }, 120_000);
  return {
    uid: pod.metadata.uid,
    image,
    imageSource: 'already-running local lab Traefik image, reused only for shell stream probes',
  };
}

function slowSink(delayMs = 15) {
  let bytes = 0;
  let maxBufferedBytes = 0;
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      maxBufferedBytes = Math.max(maxBufferedBytes, sink.writableLength);
      setTimeout(callback, delayMs);
    },
  });
  return { sink, stats: () => ({ bytes, maxBufferedBytes }) };
}

async function finiteSdkLog(target) {
  const consumer = slowSink();
  const completion = finished(consumer.sink);
  const controller = await new sdk.Log(target.config).log(
    namespace,
    'streams',
    'stream',
    consumer.sink,
    { follow: false, tailLines: 150, limitBytes: 128 * 1024, timestamps: true },
  );
  try {
    await completion;
    assert(consumer.stats().bytes > 0);
    assert(consumer.stats().bytes <= 140 * 1024);
    return { ...consumer.stats(), finiteBody: true, slowConsumerFinished: true };
  } finally {
    controller.abort();
    consumer.sink.destroy();
  }
}

/** Technical spike for the explicit transport required by S3 streaming logs. */
async function guardedLogDisconnect(target) {
  const options = { rejectUnauthorized: true };
  await target.config.applyToHTTPSOptions(options);
  const agent = new Agent({ ...options, keepAlive: false, rejectUnauthorized: true });
  const consumer = slowSink(25);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  const url = new URL(`/api/v1/namespaces/${namespace}/pods/streams/log`, target.parsed.endpoint);
  url.searchParams.set('container', 'stream');
  url.searchParams.set('follow', 'true');
  url.searchParams.set('tailLines', '10');
  let received = 0;
  let sourceClosed = false;
  const limiter = new Transform({
    highWaterMark: 16 * 1024,
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > 512 * 1024 ? new Error('PROBE_LOG_BOUND') : null, chunk);
    },
  });
  let clientRequest;
  try {
    const response = await new Promise((resolveResponse, reject) => {
      clientRequest = request(
        url,
        { ...options, agent, signal: controller.signal, timeout: 10_000 },
        resolveResponse,
      );
      clientRequest.on('error', reject);
      clientRequest.end();
    });
    assert.equal(response.statusCode, 200);
    response.on('close', () => {
      sourceClosed = true;
    });
    try {
      await pipeline(response, limiter, consumer.sink, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    await until(() => sourceClosed, 2000);
    assert(consumer.sink.destroyed);
    assert(received > 0);
    return {
      ...consumer.stats(),
      received,
      sourceClosed,
      sinkDestroyed: consumer.sink.destroyed,
      implementation: 'bounded HTTPS + pipeline spike, not the native Log helper',
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    clientRequest?.destroy();
    agent.destroy();
    consumer.sink.destroy();
    limiter.destroy();
  }
}

async function nativeLogAbortChild(target) {
  const script = fileURLToPath(import.meta.url);
  const result = await new Promise((resolveChild) => {
    const child = spawn(
      process.execPath,
      [script, '--native-log-abort', inputPaths[0], namespace],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 4096) child.kill('SIGKILL');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const traces = stdout
        .trim()
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      resolveChild({
        exitCode: code,
        signal,
        connected: traces.some((trace) => trace.stage === 'connected'),
        unhandledAbort: traces.some(
          (trace) =>
            trace.stage === 'uncaught' &&
            (trace.code === 'ABORT_ERR' || trace.name === 'AbortError'),
        ),
      });
    });
  });
  assert.equal(result.connected, true);
  assert.equal(result.signal, null);
  return {
    ...result,
    nativeHelperHandledAbort: result.exitCode === 0,
    target: target.parsed.endpoint,
  };
}

async function guardedExec(target, disconnect = false) {
  const consumer = slowSink();
  const stderr = slowSink();
  let socket;
  let pausedBeforeOpen = false;
  let paused = 0;
  let maxBufferedBytes = 0;
  let status = null;
  let streamFailure = null;
  const input = Readable.from([]);
  const native = new WebSocketHandler(
    target.config,
    (uri, protocols, options) =>
      new WebSocket(uri, protocols, {
        ...options,
        maxPayload: 256 * 1024,
        handshakeTimeout: 15_000,
        perMessageDeflate: false,
        followRedirects: false,
        rejectUnauthorized: true,
      }),
    { stdin: input, stdout: consumer.sink, stderr: stderr.sink },
  );
  const handler = {
    connect: async (path, textHandler, binaryHandler) => {
      socket = await native.connect(path, textHandler, (stream, buffer) => {
        // The helper has already handled v5 channel-close frames. Do not feed
        // them to Exec.handleStandardStreams, which accepts data/status only.
        if (stream === WebSocketHandler.CloseStream) return true;
        const keep = binaryHandler(stream, buffer);
        maxBufferedBytes = Math.max(
          maxBufferedBytes,
          consumer.sink.writableLength,
          stderr.sink.writableLength,
        );
        if (maxBufferedBytes > 256 * 1024) {
          streamFailure = new Error('PROBE_EXEC_BUFFER_BOUND');
          socket?.terminate();
          return false;
        }
        if (consumer.sink.writableNeedDrain || stderr.sink.writableNeedDrain) {
          paused += 1;
          if (socket) socket.pause();
          else pausedBeforeOpen = true;
        }
        return keep;
      });
      if (pausedBeforeOpen) socket.pause();
      return socket;
    },
  };
  const resume = () => {
    if (!consumer.sink.writableNeedDrain && !stderr.sink.writableNeedDrain) socket?.resume();
  };
  consumer.sink.on('drain', resume);
  stderr.sink.on('drain', resume);
  let closed = false;
  let timer;
  try {
    const exec = new sdk.Exec(target.config, handler);
    const command = disconnect
      ? ['sh', '-c', 'while :; do head -c 65536 /dev/zero; sleep 0.01; done']
      : ['head', '-c', '2097152', '/dev/zero'];
    socket = await exec.exec(
      namespace,
      'streams',
      'stream',
      command,
      consumer.sink,
      stderr.sink,
      null,
      false,
      (value) => {
        status = value.status;
      },
    );
    report.lastExec = { connected: true, protocol: socket.protocol, disconnect };
    socket.on('close', () => {
      closed = true;
    });
    if (disconnect) {
      // Disconnect an actively producing stream, not merely an open handshake.
      await until(() => consumer.stats().bytes > 0, 5000);
      timer = setTimeout(() => socket.terminate(), 100);
    }
    await until(() => closed, 15_000);
    if (streamFailure) throw streamFailure;
    report.lastExec = {
      ...report.lastExec,
      ...consumer.stats(),
      closed,
      status,
      maxBufferedBytes,
      paused,
    };
    if (!disconnect) {
      await Promise.all([finished(consumer.sink), finished(stderr.sink)]);
      assert.equal(consumer.stats().bytes, 2 * 1024 * 1024);
      assert.equal(status, 'Success');
      assert(paused > 0);
    }
    return {
      ...consumer.stats(),
      maxBufferedBytes,
      pauses: paused,
      socketClosed: closed,
      status,
      disconnectedByConsumer: disconnect,
      maxPayloadBytes: 256 * 1024,
      implementation: 'SDK Exec + public WebSocket pause/resume Adapter',
    };
  } finally {
    clearTimeout(timer);
    socket?.terminate();
    consumer.sink.destroy();
    stderr.sink.destroy();
    input.destroy();
    consumer.sink.off('drain', resume);
    stderr.sink.off('drain', resume);
  }
}

// The native live-log abort runs in a disposable process so a library's
// unhandled stream error cannot terminate the acceptance runner or be hidden.
if (process.argv[2] === '--native-log-abort') {
  process.on('uncaughtExceptionMonitor', (error) => {
    console.log(
      JSON.stringify({
        stage: 'uncaught',
        code: error.code === 'ABORT_ERR' ? 'ABORT_ERR' : 'OTHER',
        name: ['AbortError', 'Error', 'TypeError', 'DOMException'].includes(error.name)
          ? error.name
          : 'OTHER',
      }),
    );
  });
  const target = await load(process.argv[3]);
  const consumer = slowSink(25);
  const controller = await new sdk.Log(target.config).log(
    process.argv[4],
    'streams',
    'stream',
    consumer.sink,
    { follow: true, tailLines: 1 },
  );
  console.log(JSON.stringify({ stage: 'connected' }));
  await delay(100);
  controller.abort();
  consumer.sink.destroy();
  await delay(150);
  await target.config.close();
  process.exit(0);
}

let failed = false;
try {
  const targets = await Promise.all(inputPaths.map(load));
  await check('two_actual_apis_and_same_named_nodes', () => inspectTwo(targets));
  if (!process.argv.includes('--inspect-only')) {
    const namespaces = await check('same_named_namespace_isolation', async () => {
      const values = await Promise.all(targets.map(createNamespace));
      assert.notEqual(values[0].metadata.uid, values[1].metadata.uid);
      return { sameName: namespace, differentUids: true };
    });
    assert(namespaces.differentUids);
    if (!process.argv.includes('--exec-only')) {
      await check('real_serviceaccount_revocation_and_replacement', () =>
        credentialRotation(targets[0]),
      );
      await check('official_watch_resume_after_disconnect', () => watchRecovery(targets[0]));
      await check('old_resource_version_and_relist', () => oldResourceVersion(targets[0]));
    }
    await check('real_stream_pod', () => createStreamPod(targets[0]));
    await delay(500);
    if (!process.argv.includes('--exec-only')) {
      await check('official_finite_log_slow_consumer', () => finiteSdkLog(targets[0]));
      const rawLog = await check('native_live_log_abort_characterization', () =>
        nativeLogAbortChild(targets[0]),
      );
      if (!rawLog.nativeHelperHandledAbort)
        report.limitations.push(
          'Native SDK Log abort exits its isolated process nonzero; use owned HTTPS/pipeline transport for S3 live logs.',
        );
      await check('guarded_log_disconnect_closes_source_and_sink', () =>
        guardedLogDisconnect(targets[0]),
      );
    }
    await check('official_exec_with_bounded_slow_consumer', () => guardedExec(targets[0]));
    await check('exec_consumer_disconnect_closes_socket', () => guardedExec(targets[0], true));
  }
} catch (error) {
  failed = true;
  const source = error?.error ?? error;
  const upgradeStatus = /^Unexpected server response: (\d+)$/u.exec(source.message ?? '');
  report.failure = {
    code:
      typeof error.code === 'string' || typeof error.code === 'number'
        ? String(error.code)
        : 'PROBE_FAILED',
    stage: report.currentCheck ?? 'startup',
    nestedCode:
      typeof source.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(source.code)
        ? source.code
        : null,
    errorType: ['Error', 'TypeError', 'AssertionError', 'AbortError'].includes(source.name)
      ? source.name
      : null,
    upgradeStatus: upgradeStatus ? Number(upgradeStatus[1]) : null,
    location: String(source.stack ?? '')
      .split('\n')
      .filter((line) => line.includes('kubernetes-sdk.mjs:'))
      .map((line) => line.match(/kubernetes-sdk\.mjs:\d+:\d+/u)?.[0])
      .filter(Boolean)
      .slice(0, 3),
    diagnostic: ['PROBE_WAIT_TIMEOUT', 'PROBE_EXEC_BUFFER_BOUND', 'PROBE_LOG_BOUND'].includes(
      error.message,
    )
      ? error.message
      : null,
  };
  console.error(JSON.stringify(report.failure));
} finally {
  for (const action of cleanup.reverse()) {
    try {
      await action();
    } catch {
      failed = true;
      report.cleanup.push({ failed: true });
    }
  }
  for (const config of configurations) {
    try {
      await config.close();
    } catch {
      failed = true;
      report.cleanup.push({ dispatcherCleanupFailed: true });
    }
  }
  report.finishedAt = new Date().toISOString();
  report.passed = !failed;
  await mkdir(resolve('tests/probes/results'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  console.log(
    JSON.stringify({ passed: report.passed, checks: report.checks.length, evidence: output }),
  );
  if (failed) process.exitCode = 1;
}
