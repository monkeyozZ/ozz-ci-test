import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  KubernetesAdapter,
  KubernetesAdapterError,
  parseKubeconfig,
} from '../../packages/infrastructure/dist/kubernetes.js';
import {
  createInspectionClient,
  transportLimits,
} from '../../packages/infrastructure/dist/kubernetes/transport.js';
import { RegistryAdapter } from '../../packages/infrastructure/dist/registry.js';
import {
  KubernetesWorkloadAdapter,
  workloadNames,
} from '../../packages/infrastructure/dist/workload.js';

const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const stateFile = resolve(lab, 'workload-adapter-a.state.json');
const reportFile = resolve(root, 'docs/acceptance/s3-workload-local-results.json');
const cacheAssistanceFile = resolve(root, 'docs/acceptance/s3-workload-image-cache-assist.json');
const imageReference =
  'ghcr.io/stefanprodan/podinfo@sha256:ec73780a8425f59ea49f5bc8cdff0d598805a224fbaa1f86c67a244f250fa9da';
const controller = new globalThis.AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let state;
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw new Error('WORKLOAD_PROBE_STATE_INVALID');
}
if (state && state.version !== 1) throw new Error('WORKLOAD_PROBE_STATE_INVALID');
const report = {
  scope:
    '真实本地 K3s A 的 Registry/Workload Adapter 发布与操作；文件 ledger，不代表产品 API/Worker、私有镜像或公网入口验收。',
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: [],
  resourcesRetained: true,
};
let stage = 'preflight';
const manager = new KubernetesWorkloadAdapter({
  operationTimeoutMs: 180_000,
  rolloutTimeoutMs: 300_000,
  pollIntervalMs: 2_000,
});

async function save(running = true) {
  state.pid = running ? process.pid : null;
  state.updatedAt = new Date().toISOString();
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${stateFile}.tmp`, stateFile);
}

function check(name, passed, details = {}) {
  report.checks.push({ name, passed: Boolean(passed), ...details });
  console.log(JSON.stringify({ check: name, passed: Boolean(passed) }));
  if (!passed) throw new Error('WORKLOAD_PROBE_ASSERTION_FAILED');
}

function begin(value) {
  stage = value;
  console.log(JSON.stringify({ stage }));
}

function activePods(observation) {
  return observation.pods.filter((pod) => pod.phase !== 'Succeeded' && pod.phase !== 'Failed');
}

function rememberObservation(value) {
  state.lastObservation = {
    observedAt: value.observedAt,
    configurationState: value.configurationState,
    deployment: value.deployment,
    pods: value.pods,
    metrics: value.metrics,
    drift: value.drift,
    resources: value.resources,
  };
}

const hooks = {
  signal: controller.signal,
  async beforeWrite(intent) {
    const resource = state.inventory.find(
      (value) =>
        value.kind === intent.kind &&
        value.name === intent.name &&
        value.namespace === intent.namespace,
    );
    if (!resource || resource.creationNonce !== intent.creationNonce)
      throw new Error('WORKLOAD_PROBE_LEDGER_MISMATCH');
    if (intent.expectedUid && resource.uid && resource.uid !== intent.expectedUid)
      throw new Error('WORKLOAD_PROBE_UID_MISMATCH');
    if (intent.action === 'create') resource.creationAttempted = true;
    state.lastWriteIntent = intent;
    await save();
  },
  async onReceipt(receipt) {
    const index = state.inventory.findIndex(
      (value) =>
        value.kind === receipt.kind &&
        value.name === receipt.name &&
        value.namespace === receipt.namespace,
    );
    if (index < 0 || state.inventory[index].creationNonce !== receipt.creationNonce)
      throw new Error('WORKLOAD_PROBE_LEDGER_MISMATCH');
    const resource = state.inventory[index];
    if (resource.uid && resource.uid !== receipt.uid)
      throw new Error('WORKLOAD_PROBE_UID_MISMATCH');
    state.receipts.push(receipt);
    if (receipt.action === 'deleted') state.inventory.splice(index, 1);
    else
      state.inventory[index] = {
        ...resource,
        uid: receipt.uid,
        resourceVersion: receipt.resourceVersion,
        creationAttempted: true,
        mutationRevision: receipt.mutationRevision,
        specFingerprint: receipt.specFingerprint,
      };
    await save();
  },
};

async function waitHealthy(connection, expected) {
  return manager.waitHealthy(connection, state.target, expected, {
    inventory: state.inventory,
    signal: controller.signal,
    async onObservation(value) {
      rememberObservation(value);
      await save();
    },
  });
}

async function operate(connection, action, mutationRevision) {
  begin(action);
  return manager.operate(
    connection,
    {
      target: state.target,
      action,
      taskId: state.operations[action],
      mutationRevision,
      inventory: state.inventory,
      ...(action === 'resume' || action === 'restart'
        ? { published: state.applied.published, pullSecret: null }
        : {}),
    },
    hooks,
  );
}

async function cleanOwnedNamespace(connection) {
  begin('cleanup-owned-namespace');
  const namespace = state.inventory.find((value) => value.kind === 'Namespace');
  if (!namespace?.uid) throw new Error('WORKLOAD_PROBE_NAMESPACE_PROOF_REQUIRED');
  const client = await createInspectionClient(connection, transportLimits({}), controller.signal);
  try {
    let current;
    try {
      current = await client.core.readNamespace({ name: state.target.namespace });
    } catch (error) {
      if (!(error instanceof KubernetesAdapterError) || error.httpStatus !== 404) throw error;
      return;
    }
    if (
      current.metadata?.uid !== namespace.uid ||
      current.metadata.annotations?.['ozz.dev/creation-nonce'] !== namespace.creationNonce
    )
      throw new Error('WORKLOAD_PROBE_NAMESPACE_PROOF_MISMATCH');
    const query = { namespace: state.target.namespace, limit: 10 };
    const collections = await Promise.all([
      client.core.listNamespacedPod(query),
      client.core.listNamespacedPersistentVolumeClaim(query),
      client.core.listNamespacedSecret(query),
      client.core.listNamespacedService(query),
      client.apps.listNamespacedDeployment(query),
      client.apps.listNamespacedStatefulSet(query),
      client.apps.listNamespacedDaemonSet(query),
      client.apps.listNamespacedReplicaSet(query),
      client.batch.listNamespacedJob(query),
      client.batch.listNamespacedCronJob(query),
    ]);
    if (collections.some((value) => value.items.length || value.metadata?._continue))
      throw new Error('WORKLOAD_PROBE_NAMESPACE_NOT_EMPTY');
    const maps = await client.core.listNamespacedConfigMap(query);
    const accounts = await client.core.listNamespacedServiceAccount(query);
    if (
      maps.items.some((item) => item.metadata?.name !== 'kube-root-ca.crt') ||
      accounts.items.some((item) => item.metadata?.name !== 'default') ||
      maps.metadata?._continue ||
      accounts.metadata?._continue
    )
      throw new Error('WORKLOAD_PROBE_NAMESPACE_HAS_UNEXPECTED_RESOURCES');
    await client.core.deleteNamespace({
      name: state.target.namespace,
      body: {
        preconditions: { uid: namespace.uid, resourceVersion: current.metadata.resourceVersion },
        propagationPolicy: 'Foreground',
      },
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const remaining = await client.core.readNamespace({ name: state.target.namespace });
        if (remaining.metadata?.uid !== namespace.uid)
          throw new Error('WORKLOAD_PROBE_NAMESPACE_REPLACED');
      } catch (error) {
        if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return;
        throw error;
      }
      await delay(1_000, undefined, { signal: controller.signal });
    }
    throw new Error('WORKLOAD_PROBE_NAMESPACE_CLEANUP_TIMEOUT');
  } finally {
    client.close();
  }
}

try {
  await mkdir(lab, { recursive: true, mode: 0o700 });
  const connection = parseKubeconfig(
    await readFile(resolve(lab, 'credentials/a.kubeconfig.json'), 'utf8'),
  );
  if (connection.endpoint !== 'https://127.0.0.1:16443')
    throw new Error('WORKLOAD_PROBE_NOT_LOCAL_A');
  const trusted = JSON.parse(
    await readFile(resolve(lab, 'verification.json'), 'utf8'),
  ).clusters.find((item) => item.instance === 'ozz-lab-a');
  if (!trusted?.kubeSystemUid) throw new Error('WORKLOAD_PROBE_TRUST_RECORD_MISSING');
  const inspection = await new KubernetesAdapter().inspect(connection, {
    expectedIdentity: {
      kubeSystemUid: trusted.kubeSystemUid,
      caFingerprint: connection.caFingerprint,
    },
    signal: controller.signal,
  });
  check(
    'local A retains its trusted cluster UID and ARM64 node',
    inspection.nodes.length === 1 &&
      inspection.nodes[0].architecture === 'arm64' &&
      inspection.nodes[0].conditions.ready === 'true',
  );
  if (!state) {
    const product = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
    const runId = randomUUID();
    const target = {
      installationId: runId,
      clusterId: product.clusters.a,
      kubeSystemUid: inspection.identity.kubeSystemUid,
      caFingerprint: connection.caFingerprint,
      projectId: randomUUID(),
      environmentId: randomUUID(),
      serviceId: randomUUID(),
      namespace: '',
    };
    target.namespace = workloadNames(target).namespace;
    const snapshotId = randomUUID();
    const names = workloadNames(target, snapshotId);
    state = {
      version: 1,
      runId,
      target,
      snapshotId,
      receipts: [],
      completed: {},
      operations: Object.fromEntries(
        ['stop', 'resume', 'restart', 'delete'].map((name) => [name, randomUUID()]),
      ),
      inventory: [
        ['Namespace', names.namespace],
        ['Secret', names.runtimeSecret],
        ['Service', names.service],
        ['Deployment', names.deployment],
      ].map(([kind, name]) => ({
        kind,
        name,
        namespace: kind === 'Namespace' ? null : target.namespace,
        creationNonce: randomUUID(),
        creationAttempted: false,
        uid: null,
        resourceVersion: null,
        mutationRevision: 0,
        specFingerprint: null,
      })),
    };
    await save();
  }
  if (
    state.target.kubeSystemUid !== inspection.identity.kubeSystemUid ||
    state.target.caFingerprint !== connection.caFingerprint
  )
    throw new Error('WORKLOAD_PROBE_TARGET_CHANGED');
  report.runId = state.runId;
  report.namespace = state.target.namespace;
  let cacheAssistance;
  try {
    cacheAssistance = JSON.parse(await readFile(cacheAssistanceFile, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('WORKLOAD_PROBE_CACHE_PROVENANCE_INVALID');
  }
  if (cacheAssistance?.nodeCacheImported) {
    if (
      cacheAssistance.sourceReference !== imageReference ||
      cacheAssistance.nodeImport?.kubeSystemUid !== state.target.kubeSystemUid ||
      cacheAssistance.nodeImport.registeredRootDigest !== cacheAssistance.rootDigest
    )
      throw new Error('WORKLOAD_PROBE_CACHE_PROVENANCE_INVALID');
    report.imageCacheAssistance = {
      mode: 'verified-local-cache',
      originalPublicPullSucceeded: false,
      sourceReference: cacheAssistance.sourceReference,
      rootDigest: cacheAssistance.rootDigest,
      platformDigest: cacheAssistance.platformDigest,
      archiveSha256: cacheAssistance.archiveSha256,
      importedAt: cacheAssistance.nodeImport.importedAt,
      evidenceFile: cacheAssistanceFile,
    };
    report.scope += ' 同一镜像采用完整 SHA256 校验的本地缓存辅助，原 K3s 公网拉取未通过。';
  }
  if (!state.resolved) {
    begin('resolve-fixed-image');
    state.resolved = await new RegistryAdapter().resolve(imageReference, {
      platforms: [{ os: 'linux', architecture: 'arm64' }],
      signal: controller.signal,
    });
    await save();
  }
  check(
    'fixed OCI image includes verified ARM64 manifest',
    state.resolved.requestedDigest === state.resolved.manifestDigest &&
      state.resolved.platformManifests[0].architecture === 'arm64',
    { reference: state.resolved.deployReference },
  );
  if (!state.completed.apply) {
    begin('apply');
    state.applied = await manager.apply(
      connection,
      {
        target: state.target,
        snapshotId: state.snapshotId,
        taskId: state.snapshotId,
        configRevision: 1,
        mutationRevision: 1,
        inventory: state.inventory,
        pullSecret: null,
        configuration: {
          image: state.resolved.deployReference,
          replicas: 1,
          command: [],
          args: [],
          ports: [{ name: 'http', protocol: 'http', containerPort: 9898, servicePort: 80 }],
          environment: [
            { name: 'PODINFO_UI_MESSAGE', value: 'Ozz local workload adapter verification' },
          ],
          resources: {
            requests: { cpuMillis: 25, memoryMiB: 32 },
            limits: { cpuMillis: 200, memoryMiB: 128 },
          },
          readiness: {
            type: 'http',
            port: 'http',
            path: '/readyz',
            initialDelaySeconds: 0,
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 3,
          },
          startup: {
            type: 'tcp',
            port: 'http',
            initialDelaySeconds: 0,
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 60,
          },
        },
      },
      hooks,
    );
    state.completed.apply = true;
    await save();
  }
  check(
    'real Kubernetes resources completely applied with UID receipts',
    state.applied.state === 'complete' && state.applied.resources.length === 4,
  );
  if (!state.completed.healthy) {
    begin('wait-initial-health');
    state.healthy = await waitHealthy(connection, state.applied.published);
    state.completed.healthy = true;
    await save();
  }
  check(
    'actual Pod is ready for the requested digest and HTTP probe',
    state.healthy.pods.length === 1 &&
      state.healthy.pods[0].ready === true &&
      state.healthy.pods[0].matchesDeploymentTemplate === true &&
      state.healthy.pods[0].containers[0].image === state.resolved.deployReference &&
      [
        state.resolved.manifestDigest,
        state.resolved.platformManifests[0].manifestDigest,
        state.resolved.platformManifests[0].configDigest,
      ].includes(state.healthy.pods[0].containers[0].imageId?.match(/sha256:[a-f0-9]{64}$/u)?.[0]),
    {
      nodeName: state.healthy.pods[0].nodeName,
      imageId: state.healthy.pods[0].containers[0].imageId,
    },
  );
  if (!state.completed.metrics) {
    begin('wait-real-metrics');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      state.metrics = (
        await manager.observe(connection, state.target, state.inventory, {
          signal: controller.signal,
        })
      ).metrics;
      if (state.metrics.state === 'available') break;
      await delay(2_000, undefined, { signal: controller.signal });
    }
    state.completed.metrics = state.metrics.state === 'available';
    await save();
  }
  check(
    'Metrics API supplies current Pod CPU and memory',
    state.metrics.state === 'available',
    state.metrics,
  );
  if (!state.completed.stop) {
    state.stop = await operate(connection, 'stop', 2);
    state.stopped = await manager.observe(connection, state.target, state.inventory, {
      signal: controller.signal,
    });
    state.completed.stop = true;
    await save();
  }
  check(
    'stop waits for zero active Pods and keeps the published template',
    state.stopped.deployment?.replicas === 0 &&
      activePods(state.stopped).length === 0 &&
      state.stopped.deployment.templateFingerprint === state.applied.published.templateFingerprint,
  );
  if (!state.completed.resume) {
    state.resume = await operate(connection, 'resume', 3);
    state.resumed = await waitHealthy(connection, state.resume.rollout);
    state.completed.resume = true;
    await save();
  }
  check(
    'resume restores the original published snapshot and replicas',
    state.resumed.deployment.snapshotId === state.snapshotId &&
      state.resumed.deployment.replicas === 1 &&
      state.resume.rollout.workloadFingerprint === state.applied.published.workloadFingerprint,
  );
  if (!state.completed.restart) {
    state.restart = await operate(connection, 'restart', 4);
    state.restarted = await waitHealthy(connection, state.restart.rollout);
    state.completed.restart = true;
    await save();
  }
  const resumedPods = activePods(state.resumed);
  const restartedPods = activePods(state.restarted);
  check(
    'restart replaces the Pod while preserving immutable published configuration',
    resumedPods.length === 1 &&
      restartedPods.length === 1 &&
      restartedPods[0].uid !== resumedPods[0].uid &&
      restartedPods[0].ready === true &&
      restartedPods[0].matchesDeploymentTemplate === true &&
      state.restarted.deployment.rolloutId === state.operations.restart &&
      state.restart.rollout.workloadFingerprint === state.applied.published.workloadFingerprint,
    {
      previousActivePodUids: resumedPods.map((pod) => pod.uid),
      currentActivePodUids: restartedPods.map((pod) => pod.uid),
      retainedTerminalPods: state.restarted.pods.length - restartedPods.length,
    },
  );
  if (!state.completed.delete) {
    state.deleted = await operate(connection, 'delete', 5);
    state.completed.delete = true;
    await save();
  }
  check(
    'product adapter deletes only its workload resources and retains the Namespace',
    state.deleted.resources.filter((item) => item.action === 'deleted').length === 3 &&
      state.inventory.length === 1 &&
      state.inventory[0].kind === 'Namespace',
  );
  if (!state.completed.namespaceCleanup) {
    await cleanOwnedNamespace(connection);
    state.completed.namespaceCleanup = true;
    await save();
  }
  check(
    'probe cleanup verifies the exclusively owned empty Namespace UID and final 404',
    state.completed.namespaceCleanup,
  );
  report.resourcesRetained = false;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    stage,
    code:
      typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
        ? error.code
        : /^[A-Z0-9_]+$/u.test(error.message)
          ? error.message
          : 'WORKLOAD_PROBE_FAILED',
  };
  report.lastObservation = state?.lastObservation ?? null;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.stateFile = stateFile;
  if (state) {
    state.lastReport = report;
    await save(false);
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'passed')
    await writeFile(
      resolve(root, `docs/acceptance/s3-workload-local-failure-${Date.now()}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      report: reportFile,
      resourcesRetained: report.resourcesRetained,
    }),
  );
}
