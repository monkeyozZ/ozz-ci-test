import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { KubernetesStorageAdapter } from '../../packages/infrastructure/dist/storage.js';
import { KubernetesWorkloadAdapter } from '../../packages/infrastructure/dist/workload.js';
import { journal, plan } from './workload-fixture.js';
import { StorageFixture, storageJournal, storagePlan } from './storage-fixture.js';

const fixtures: StorageFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
});
const manager = () =>
  new KubernetesStorageAdapter({
    requestTimeoutMs: 700,
    operationTimeoutMs: 2500,
    pollIntervalMs: 15,
  });
async function fixture() {
  const server = new StorageFixture();
  fixtures.push(server);
  await server.start();
  return server;
}
async function created() {
  const server = await fixture(),
    target = server.target(),
    input = storagePlan(server, target),
    state = storageJournal(input),
    adapter = manager();
  const result = await adapter.create(server.connection(), state.plan, state.hooks);
  return { server, target, input, state, adapter, result };
}
async function bound() {
  const context = await created();
  const pv = context.server.bind(context.state.plan);
  const observation = await context.adapter.observe(
    context.server.connection(),
    context.state.plan,
  );
  expect(observation.state).toBe('ready');
  await context.state.hooks.onReceipt(observation.verifiedReceipt!);
  return { ...context, pv, observation };
}

describe('registered local-path PVC lifecycle over bounded Kubernetes HTTPS', () => {
  it('accepts omitted item TypeMeta from a verified typed list while rejecting an explicit conflicting kind', async () => {
    const server = await fixture();
    delete server.storageClass.kind;
    delete server.storageClass.apiVersion;
    const observed = await manager().inspect(server.connection(), server.target());
    expect(observed.storageClasses).toMatchObject([
      { name: 'local-path', uid: server.storageClass.metadata!.uid, supported: true },
    ]);
    server.storageClass.kind = 'PersistentVolume';
    const rejected = await manager().inspect(server.connection(), server.target());
    expect(rejected.storageClasses).toEqual([]);
    expect(rejected.issues).toContainEqual(
      expect.objectContaining({ code: 'KUBERNETES_INVALID_RESPONSE' }),
    );
  });
  it.each(['kind', 'apiVersion'] as const)(
    'rejects an untrusted list %s before inferring an item type',
    async (field) => {
      const server = await fixture();
      delete server.storageClass.kind;
      delete server.storageClass.apiVersion;
      if (field === 'kind') server.storageClassListKind = 'List';
      else server.storageClassListApiVersion = 'storage.k8s.io/v1beta1';
      const rejected = await manager().inspect(server.connection(), server.target());
      expect(rejected.storageClasses).toEqual([]);
      expect(rejected.issues).toContainEqual(
        expect.objectContaining({ code: 'KUBERNETES_INVALID_RESPONSE' }),
      );
    },
  );
  it('reports actual provisioner, permissions and the absence of hard quota support', async () => {
    const server = await fixture();
    const observed = await manager().inspect(server.connection(), server.target());
    expect(observed).toMatchObject({
      provisioner: { state: 'ready', version: 'v0.0.34' },
      permissions: 'ready',
      truncated: false,
    });
    expect(observed.storageClasses).toMatchObject([
      {
        name: 'local-path',
        supported: true,
        hardQuotaSupport: 'unsupported',
        bindingMode: 'WaitForFirstConsumer',
      },
    ]);
    expect(
      server.writes().every((request) => request.path.endsWith('/selfsubjectaccessreviews')),
    ).toBe(true);
    server.storageClass.provisioner = 'unknown.invalid/provisioner';
    server.permissions = false;
    expect(await manager().inspect(server.connection(), server.target())).toMatchObject({
      permissions: 'insufficient',
      storageClasses: [{ supported: false, hardQuotaSupport: 'unknown' }],
    });
  });
  it('completes WFFC creation while Pending and retains a durable nonce and UID', async () => {
    const { server, state, result } = await created();
    expect(result.observation).toMatchObject({
      state: 'pending',
      locality: 'waiting_for_consumer',
      pvc: { phase: 'Pending' },
      hardQuotaSupport: 'unsupported',
    });
    expect(state.plan.claim.uid).toBe(server.claim(state.plan).metadata.uid);
    expect(state.intents[0]).toMatchObject({
      action: 'create',
      expectedUid: null,
      storageClassUid: server.storageClass.metadata!.uid,
    });
    expect(state.receipts[0]!.uid).toBeTruthy();
    expect(result.observation.usage.usedBytes).toBeNull();
  });
  it('shares the existing Namespace ledger with later Service publication', async () => {
    const { server, target, state } = await created();
    const workload = plan(target);
    workload.inventory = workload.inventory.map((row) =>
      row.kind === 'Namespace' ? state.plan.namespace : row,
    );
    const writes = journal(workload);
    await new KubernetesWorkloadAdapter().apply(server.connection(), workload, writes.hooks);
    expect(server.writes().filter((request) => request.path === '/api/v1/namespaces')).toHaveLength(
      1,
    );
    expect(writes.inventory.find((row) => row.kind === 'Namespace')!.uid).toBe(
      state.plan.namespace.uid,
    );
    expect(writes.inventory.find((row) => row.kind === 'Namespace')!.creationNonce).toBe(
      state.plan.namespace.creationNonce,
    );
  });
  it('recovers a lost create receipt by exact nonce and never sends a second POST', async () => {
    const server = await fixture(),
      state = storageJournal(storagePlan(server)),
      adapter = manager();
    server.loseNextCreate = 'PersistentVolumeClaim';
    await expect(
      adapter.create(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'KUBERNETES_UNREACHABLE' });
    expect(state.plan.claim.creationAttempted).toBe(true);
    expect(state.plan.claim.uid).toBeNull();
    state.plan.mutationRevision = 2;
    const replay = await adapter.create(server.connection(), state.plan, state.hooks);
    expect(replay.resources[0]!.action).toBe('verified');
    expect(
      server.writes().filter((request) => request.path.endsWith('/persistentvolumeclaims')),
    ).toHaveLength(1);
  });
  it('rejects a foreign matching name instead of adopting labels or nonce-free PVCs', async () => {
    const { server, state, adapter } = await created();
    server.claim(state.plan).metadata.annotations!['ozz.dev/creation-nonce'] = randomUUID();
    const writes = server.writes().length;
    await expect(
      adapter.create(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_OWNERSHIP_MISMATCH' });
    expect(server.writes()).toHaveLength(writes);
  });
  it('never recreates a known missing PVC or accepts a same-name UID replacement', async () => {
    const { server, state, adapter } = await created();
    const original = server.claim(state.plan);
    const key = `PersistentVolumeClaim/${state.plan.target.namespace}/${state.plan.claim.name}`;
    server.resources.delete(key);
    const writes = server.writes().length;
    await expect(
      adapter.create(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_CLAIM_MISSING' });
    original.metadata.uid = randomUUID();
    server.resources.set(key, original);
    await expect(
      adapter.create(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_OWNERSHIP_MISMATCH' });
    expect(server.writes()).toHaveLength(writes);
  });
  it('pins PV claimRef, StorageClass UID and the actual node UID', async () => {
    const { server, state, pv, adapter, observation } = await bound();
    expect(observation.pv).toMatchObject({
      uid: pv.metadata!.uid,
      claimUid: state.plan.claim.uid,
      provisioner: 'rancher.io/local-path',
      reclaimPolicy: 'Delete',
    });
    expect(state.plan.knownBinding!.nodes).toEqual([
      { name: 'storage-node-a', uid: server.nodes[0]!.metadata!.uid },
    ]);
    pv.spec!.claimRef!.uid = randomUUID();
    expect(await adapter.observe(server.connection(), state.plan)).toMatchObject({
      state: 'drifted',
      code: 'STORAGE_BINDING_INVALID',
    });
  });
  it('rejects a same-name replacement StorageClass', async () => {
    const { server, state, adapter } = await created();
    server.storageClass.metadata!.uid = randomUUID();
    expect(await adapter.observe(server.connection(), state.plan)).toMatchObject({
      state: 'drifted',
      code: 'STORAGE_CLASS_REPLACED',
    });
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_CLASS_REPLACED' });
    expect(server.writes().filter((request) => request.method === 'DELETE')).toHaveLength(0);
  });
  it('does not let a same-name replacement node inherit local data identity', async () => {
    const { server, target, state, adapter } = await bound();
    server.nodes[0]!.metadata!.uid = randomUUID();
    expect(await adapter.observe(server.connection(), state.plan)).toMatchObject({
      state: 'drifted',
      code: 'STORAGE_NODE_REPLACED',
    });
    await expect(
      adapter.prepareBindings(server.connection(), target, [
        { plan: state.plan, path: '/data', readOnly: false },
      ]),
    ).rejects.toMatchObject({ code: 'STORAGE_NODE_REPLACED' });
  });
  it('reports unavailable nodes as unknown and refuses a new writer', async () => {
    const { server, target, state, adapter } = await bound();
    server.nodes[0]!.status!.conditions![0]!.status = 'False';
    expect(await adapter.observe(server.connection(), state.plan)).toMatchObject({
      state: 'unknown',
      code: 'STORAGE_NODE_UNAVAILABLE',
      locality: 'unavailable',
    });
    await expect(
      adapter.prepareBindings(server.connection(), target, [
        { plan: state.plan, path: '/data', readOnly: false },
      ]),
    ).rejects.toMatchObject({ code: 'STORAGE_NODE_UNAVAILABLE' });
  });
  it('blocks destruction on actual Retain or unknown provisioner evidence', async () => {
    const { server, state, pv, adapter } = await bound();
    pv.spec!.persistentVolumeReclaimPolicy = 'Retain';
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_RECLAIM_RETAIN' });
    pv.spec!.persistentVolumeReclaimPolicy = 'Delete';
    pv.metadata!.annotations!['pv.kubernetes.io/provisioned-by'] = 'other.invalid';
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_PROVISIONER_UNVERIFIED' });
    expect(server.writes().filter((request) => request.method === 'DELETE')).toHaveLength(0);
  });
  it('finds unlabeled, read-only and terminating actual Pod references', async () => {
    const { server, state, adapter } = await bound();
    const pod = server.addPodMount(state.plan, { readOnly: true, phase: 'Succeeded' });
    pod.metadata.deletionTimestamp = new Date().toISOString();
    const observation = await adapter.observe(server.connection(), state.plan);
    expect(observation.mounts).toMatchObject([
      {
        podUid: pod.metadata.uid,
        readOnly: true,
        deleting: true,
        paths: ['/data'],
        serviceId: null,
      },
    ]);
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_VOLUME_MOUNTED' });
    const podReads = server.requests.filter((request) => request.path.endsWith('/pods'));
    expect(podReads.every((request) => !request.query.includes('labelSelector'))).toBe(true);
  });
  it('fails closed when the actual Pod-reference list is truncated or forbidden', async () => {
    const { server, state, adapter } = await bound();
    server.podListTruncated = true;
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_MOUNTS_INCOMPLETE' });
    server.podListTruncated = false;
    server.podListStatus = 403;
    const observed = await adapter.observe(server.connection(), state.plan);
    expect(observed.state).toBe('unknown');
    expect(JSON.stringify(observed)).not.toContain('storage-private-fixture');
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'KUBERNETES_FORBIDDEN' });
  });
  it('checks again after the durable delete fence and stops on PV policy drift', async () => {
    const { server, state, pv, adapter } = await bound();
    const before = state.hooks.beforeWrite;
    state.hooks.beforeWrite = async (intent) => {
      await before(intent);
      if (intent.action === 'delete') pv.spec!.persistentVolumeReclaimPolicy = 'Retain';
    };
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_RECLAIM_RETAIN' });
    expect(server.writes().filter((request) => request.method === 'DELETE')).toHaveLength(0);
  });
  it('deletes only the PVC with UID/RV preconditions and observes provisioner PV absence', async () => {
    const { server, state, adapter } = await bound();
    const uid = state.plan.claim.uid,
      resourceVersion = server.claim(state.plan).metadata.resourceVersion;
    const result = await adapter.destroy(server.connection(), state.plan, state.hooks);
    expect(result.observation.state).toBe('destroyed');
    expect(result.resources.at(-1)).toMatchObject({ action: 'deleted', uid });
    const deletes = server.writes().filter((request) => request.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.path).toContain('/persistentvolumeclaims/');
    expect(deletes[0]!.body).toMatchObject({ preconditions: { uid, resourceVersion } });
    expect(server.resources.has(`Namespace//${state.plan.target.namespace}`)).toBe(true);
    expect(server.pvs.size).toBe(0);
  });
  it('recovers a lost DELETE receipt and never deletes a replacement PV', async () => {
    const { server, state, adapter } = await bound();
    server.loseNextDelete = true;
    server.holdPv = true;
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'KUBERNETES_UNREACHABLE' });
    server.pvs.get(state.plan.knownBinding!.pvName)!.metadata!.uid = randomUUID();
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_BINDING_CHANGED' });
    server.pvs.clear();
    expect(
      (await adapter.destroy(server.connection(), state.plan, state.hooks)).observation.state,
    ).toBe('destroyed');
    expect(server.writes().filter((request) => request.method === 'DELETE')).toHaveLength(1);
  });
  it('retains incomplete deletion when the provisioner has not removed the PV', async () => {
    const { server, state } = await bound();
    server.holdPv = true;
    const adapter = new KubernetesStorageAdapter({
      operationTimeoutMs: 150,
      requestTimeoutMs: 100,
      pollIntervalMs: 10,
    });
    await expect(
      adapter.destroy(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_OPERATION_TIMEOUT' });
    expect(server.pvs.size).toBe(1);
    expect(state.receipts.some((receipt) => receipt.action === 'deleted')).toBe(false);
  });
  it('rejects multiple local volumes on disjoint node UIDs before publication', async () => {
    const { server, target, state, adapter } = await bound();
    const input = storagePlan(server, target);
    input.namespace = state.plan.namespace;
    const other = storageJournal(input);
    await adapter.create(server.connection(), other.plan, other.hooks);
    const node = server.node('storage-node-b');
    server.nodes.push(node);
    server.bind(other.plan, node);
    await expect(
      adapter.prepareBindings(server.connection(), target, [
        { plan: state.plan, path: '/data-a', readOnly: false },
        { plan: other.plan, path: '/data-b', readOnly: true },
      ]),
    ).rejects.toMatchObject({ code: 'STORAGE_LOCALITY_CONFLICT' });
  });
  it('refuses cross-environment bindings and protected or overlapping paths', async () => {
    const { server, target, state, adapter } = await created();
    for (const path of [
      '/run/ozz/database',
      '/run/secrets/x',
      '/var/run/secrets/x',
      '/etc/ozz/x',
      '/data/../etc',
    ])
      await expect(
        adapter.prepareBindings(server.connection(), target, [
          { plan: state.plan, path, readOnly: false },
        ]),
      ).rejects.toMatchObject({ code: 'STORAGE_TARGET_MISMATCH' });
    const other = server.target();
    await expect(
      adapter.prepareBindings(server.connection(), other, [
        { plan: state.plan, path: '/data', readOnly: false },
      ]),
    ).rejects.toMatchObject({ code: 'STORAGE_TARGET_MISMATCH' });
  });
  it('enforces the current write fence before creating a remote Namespace or claim', async () => {
    const server = await fixture(),
      state = storageJournal(storagePlan(server));
    state.hooks.checkpoint = async () => {
      throw new Error('secret-lease-error');
    };
    await expect(
      manager().create(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'WORKLOAD_CALLBACK_FAILED' });
    expect(server.writes()).toHaveLength(0);
  });
  it('returns verified root-controller ancestry and permits read-only consumers beside one writer', async () => {
    const { server, target, state, adapter } = await bound();
    const input = plan(target);
    input.inventory = input.inventory.map((row) =>
      row.kind === 'Namespace' ? state.plan.namespace : row,
    );
    input.configuration.controller = { kind: 'Deployment', strategy: 'Recreate' };
    input.configuration.volumes = [
      {
        volumeId: state.plan.target.volumeId,
        claimName: state.plan.claim.name,
        claimUid: state.plan.claim.uid!,
        path: '/data',
        readOnly: false,
      },
    ];
    const work = journal(input),
      applied = await new KubernetesWorkloadAdapter().apply(server.connection(), input, work.hooks);
    const observed = await adapter.observe(server.connection(), state.plan);
    expect(observed.mounts).toMatchObject([
      {
        serviceId: target.serviceId,
        controller: { kind: 'Deployment', uid: applied.published.controller!.uid },
      },
    ]);
    expect(
      await adapter.prepareBindings(server.connection(), target, [
        { plan: state.plan, path: '/data', readOnly: false },
      ]),
    ).toHaveLength(1);
    const reader = { ...target, serviceId: randomUUID() };
    expect(
      await adapter.prepareBindings(server.connection(), reader, [
        { plan: state.plan, path: '/data', readOnly: true },
      ]),
    ).toHaveLength(1);
    await expect(
      adapter.prepareBindings(server.connection(), reader, [
        { plan: state.plan, path: '/data', readOnly: false },
      ]),
    ).rejects.toMatchObject({ code: 'STORAGE_VOLUME_IN_USE' });
  });
  it('does not exempt a foreign Pod that only spoofs the serviceId label', async () => {
    const { server, target, state, adapter } = await bound();
    server.addPodMount(state.plan, { serviceId: target.serviceId });
    expect((await adapter.observe(server.connection(), state.plan)).mounts).toMatchObject([
      { serviceId: null, controller: null },
    ]);
    await expect(
      adapter.prepareBindings(server.connection(), target, [
        { plan: state.plan, path: '/data', readOnly: false },
      ]),
    ).rejects.toMatchObject({ code: 'STORAGE_VOLUME_IN_USE' });
  });
  it('rechecks StorageClass identity after the durable creation fence', async () => {
    const server = await fixture(),
      state = storageJournal(storagePlan(server));
    const before = state.hooks.beforeWrite;
    state.hooks.beforeWrite = async (intent) => {
      await before(intent);
      server.storageClass.metadata!.uid = randomUUID();
    };
    await expect(
      manager().create(server.connection(), state.plan, state.hooks),
    ).rejects.toMatchObject({ code: 'STORAGE_CLASS_REPLACED' });
    expect(
      server.writes().filter((request) => request.path.endsWith('/persistentvolumeclaims')),
    ).toHaveLength(0);
  });
  it('can tombstone a never-created claim after proving both the Namespace and PV references absent', async () => {
    const server = await fixture(),
      state = storageJournal(storagePlan(server));
    const result = await manager().destroy(server.connection(), state.plan, state.hooks);
    expect(result.observation.state).toBe('destroyed');
    expect(result.resources.at(-1)).toMatchObject({ action: 'deleted', uid: null });
    expect(server.writes()).toHaveLength(0);
  });
});
