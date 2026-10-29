import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { KubernetesStorageAdapter } from '../../packages/infrastructure/dist/storage.js';
import {
  publishedController,
  workloadNames,
  type WorkloadApplyPlan,
} from '../../packages/infrastructure/dist/workload.js';
import { journal, plan, type Deployment } from './workload-fixture.js';
import { StorageFixture, storageJournal, storagePlan } from './storage-fixture.js';
import { statefulWorkload, workloadAdapter } from './workload-s5-fixture.js';

const fixtures: StorageFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
});
async function deployed(strategy: 'RollingUpdate' | 'OnDelete' = 'RollingUpdate') {
  const server = new StorageFixture();
  fixtures.push(server);
  await server.start();
  return statefulWorkload(server, undefined, strategy);
}

describe('StatefulSet and external PVC workload protocol', () => {
  it('publishes an explicit StatefulSet identity and independently retained external claims', async () => {
    const { server, target, input, storage, state, manager, applied } = await deployed();
    const actual = server.get('StatefulSet', target) as Deployment;
    expect(applied.published.controller).toEqual({ kind: 'StatefulSet', uid: actual.metadata.uid });
    expect(applied.published.deploymentUid).toBeUndefined();
    expect(actual.spec.volumeClaimTemplates).toBeUndefined();
    expect(actual.spec.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: 'Retain',
      whenScaled: 'Retain',
    });
    expect(actual.spec.template.spec.volumes).toMatchObject([
      { persistentVolumeClaim: { claimName: storage.plan.claim.name } },
    ]);
    expect(
      server.get('Service', target, workloadNames(target).headlessService).spec!.clusterIP,
    ).toBe('None');
    expect(server.get('Service', target).spec!.clusterIP).not.toBe('None');
    const observed = await manager.waitHealthy(server.connection(), target, applied.published, {
      inventory: state.inventory,
    });
    expect(observed.deployment).toBeNull();
    expect(observed.controller).toMatchObject({
      kind: 'StatefulSet',
      strategy: 'RollingUpdate',
      uid: applied.published.controller!.uid,
    });
    expect(observed.pods[0]).toMatchObject({
      replicaSetUid: null,
      owner: { kind: 'StatefulSet', uid: applied.published.controller!.uid },
      matchesControllerTemplate: true,
      matchesDeploymentTemplate: false,
    });
    expect(observed.serviceDns).toBe(
      `${workloadNames(input.target).service}.${target.namespace}.svc`,
    );
    const mounts = (await new KubernetesStorageAdapter().observe(server.connection(), storage.plan))
      .mounts;
    expect(mounts).toMatchObject([
      {
        serviceId: target.serviceId,
        controller: { kind: 'StatefulSet', uid: applied.published.controller!.uid },
      },
    ]);
  });
  it('stops, resumes, restarts and deletes only workload resources while preserving the PVC', async () => {
    const { server, target, storage, state, manager, applied } = await deployed();
    const initialUid = storage.plan.claim.uid;
    const initial = await manager.waitHealthy(server.connection(), target, applied.published, {
      inventory: state.inventory,
    });
    let revision = 1;
    let last = initial;
    for (const action of ['stop', 'resume', 'restart'] as const) {
      const result = await manager.operate(
        server.connection(),
        {
          target,
          action,
          taskId: randomUUID(),
          mutationRevision: ++revision,
          inventory: state.inventory,
          published: applied.published,
        },
        state.hooks,
      );
      if (result.rollout)
        last = await manager.waitHealthy(server.connection(), target, result.rollout, {
          inventory: state.inventory,
        });
      expect(server.claim(storage.plan).metadata.uid).toBe(initialUid);
    }
    expect(last.pods[0]!.uid).not.toBe(initial.pods[0]!.uid);
    await manager.operate(
      server.connection(),
      {
        target,
        action: 'delete',
        taskId: randomUUID(),
        mutationRevision: ++revision,
        inventory: state.inventory,
      },
      state.hooks,
    );
    expect(server.claim(storage.plan).metadata.uid).toBe(initialUid);
    expect(server.resources.has(`Namespace//${target.namespace}`)).toBe(true);
    expect(
      server
        .writes()
        .filter((request) => request.method === 'DELETE')
        .every((request) => !request.path.includes('persistentvolume')),
    ).toBe(true);
  });
  it('cycles an OnDelete restart through zero observed Pods without force-deleting Pods', async () => {
    const { server, target, state, manager, applied } = await deployed('OnDelete');
    const result = await manager.operate(
      server.connection(),
      {
        target,
        action: 'restart',
        taskId: randomUUID(),
        mutationRevision: 2,
        inventory: state.inventory,
        published: applied.published,
      },
      state.hooks,
    );
    expect(result.rollout!.controller!.kind).toBe('StatefulSet');
    const writes = server
      .writes()
      .filter((request) => request.method === 'PUT' && request.path.includes('/statefulsets/'));
    expect(writes.map((request) => (request.body as Deployment).spec.replicas)).toEqual([1, 0, 1]);
    expect(
      server
        .writes()
        .some((request) => request.method === 'DELETE' && request.path.includes('/pods/')),
    ).toBe(false);
    await manager.waitHealthy(server.connection(), target, result.rollout!, {
      inventory: state.inventory,
    });
  });
  it('does not accept a label-matching Pod with a different direct StatefulSet owner', async () => {
    const { server, target, state, manager, applied } = await deployed();
    server.podMode = 'spoofed';
    const observation = await manager.observe(server.connection(), target, state.inventory);
    expect(observation).toMatchObject({ configurationState: 'drifted', pods: [] });
    await expect(
      manager.waitHealthy(server.connection(), target, applied.published, {
        inventory: state.inventory,
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_CONFIGURATION_DRIFT' });
  });
  it('verifies ControllerRevision ancestry and rejects missing or foreign revisions', async () => {
    const { server, target, state, manager } = await deployed();
    for (const mode of ['missing', 'foreign_owner'] as const) {
      server.controllerRevisionReadMode = mode;
      const observation = await manager.observe(server.connection(), target, state.inventory);
      expect(observation.configurationState).toBe('drifted');
      expect(observation.pods).toHaveLength(0);
    }
  });
  it('keeps an older verified revision distinct from the desired StatefulSet template', async () => {
    const { server, target, state, manager, applied } = await deployed();
    server.podMode = 'old';
    const observed = await manager.observe(server.connection(), target, state.inventory);
    expect(observed.pods[0]!.matchesControllerTemplate).toBe(false);
    expect(observed.pods[0]!.snapshotId).not.toBe(applied.published.snapshotId);
    await expect(
      manager.waitHealthy(server.connection(), target, applied.published, {
        inventory: state.inventory,
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_ROLLOUT_TIMEOUT' });
  });
  it('rejects attempts to relabel old StatefulSet Pods as the current snapshot', async () => {
    const { server, target, state, manager } = await deployed();
    server.podMode = 'relabelledOld';
    const observed = await manager.observe(server.connection(), target, state.inventory);
    expect(observed.configurationState).toBe('drifted');
    expect(observed.pods[0]!.snapshotId).toBeNull();
  });
  it('rechecks the fixed PVC UID after the write fence before sending a controller', async () => {
    const server = new StorageFixture();
    fixtures.push(server);
    await server.start();
    const target = server.target(),
      storage = storageJournal(storagePlan(server, target));
    await new KubernetesStorageAdapter().create(server.connection(), storage.plan, storage.hooks);
    const input = plan(target);
    input.configuration.controller = { kind: 'Deployment', strategy: 'Recreate' };
    input.configuration.volumes = [
      {
        volumeId: storage.plan.target.volumeId,
        claimName: storage.plan.claim.name,
        claimUid: storage.plan.claim.uid!,
        path: '/data',
        readOnly: false,
      },
    ];
    input.inventory = input.inventory.map((row) =>
      row.kind === 'Namespace' ? storage.plan.namespace : row,
    );
    const state = journal(input),
      before = state.hooks.beforeWrite;
    state.hooks.beforeWrite = async (intent) => {
      await before(intent);
      if (intent.kind === 'Deployment') server.claim(storage.plan).metadata.uid = randomUUID();
    };
    await expect(
      workloadAdapter().apply(server.connection(), input, state.hooks),
    ).rejects.toMatchObject({ code: 'WORKLOAD_OWNERSHIP_MISMATCH' });
    expect(server.writes().filter((request) => request.path.endsWith('/deployments'))).toHaveLength(
      0,
    );
  });
  it('requires single replica and Recreate for writable Deployment volumes', async () => {
    const { server, input, state, manager } = await deployed();
    const next: WorkloadApplyPlan = {
      ...input,
      inventory: state.inventory,
      configuration: {
        ...input.configuration,
        controller: { kind: 'Deployment', strategy: 'RollingUpdate' },
      },
    };
    const writes = server.writes().length;
    await expect(manager.apply(server.connection(), next, state.hooks)).rejects.toMatchObject({
      code: 'WORKLOAD_INPUT_INVALID',
    });
    next.configuration.controller = { kind: 'Deployment', strategy: 'Recreate' };
    next.configuration.replicas = 2;
    await expect(manager.apply(server.connection(), next, state.hooks)).rejects.toMatchObject({
      code: 'WORKLOAD_INPUT_INVALID',
    });
    expect(server.writes()).toHaveLength(writes);
  });
  it('rejects an opposite controller with the same stable service identity', async () => {
    const { server, input, state, manager } = await deployed();
    const next: WorkloadApplyPlan = {
      ...input,
      configuration: {
        ...input.configuration,
        controller: { kind: 'Deployment', strategy: 'Recreate' },
      },
      inventory: [
        ...state.inventory,
        {
          ...state.inventory.find((row) => row.kind === 'StatefulSet')!,
          kind: 'Deployment',
          creationNonce: randomUUID(),
          creationAttempted: false,
          uid: null,
          resourceVersion: null,
          specFingerprint: null,
        },
      ],
    };
    const writes = server.writes().length;
    await expect(manager.apply(server.connection(), next, state.hooks)).rejects.toMatchObject({
      code: 'WORKLOAD_CONFIGURATION_DRIFT',
    });
    expect(server.writes()).toHaveLength(writes);
  });
  it('preserves v1 Deployment publication interpretation for lifecycle operations', async () => {
    const server = new StorageFixture();
    fixtures.push(server);
    await server.start();
    const input = plan(server.target()),
      state = journal(input),
      manager = workloadAdapter();
    const applied = await manager.apply(server.connection(), input, state.hooks);
    const { controller, ...fields } = applied.published;
    const legacy = { ...fields, controller: undefined, deploymentUid: controller!.uid };
    expect(publishedController(legacy)).toEqual(controller);
    const result = await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'restart',
        taskId: randomUUID(),
        mutationRevision: 2,
        inventory: state.inventory,
        published: legacy,
      },
      state.hooks,
    );
    expect(result.rollout!.controller).toEqual(controller);
    await manager.waitHealthy(server.connection(), input.target, result.rollout!, {
      inventory: state.inventory,
    });
  });
  it('projects Redis configuration from Secret files without leaking files into the environment', async () => {
    const server = new StorageFixture();
    fixtures.push(server);
    await server.start();
    const { input, target, applied } = await statefulWorkload(server, 'redis');
    const actual = server.get('StatefulSet', target) as Deployment,
      container = actual.spec.template.spec.containers[0]!;
    expect(container.envFrom).toBeUndefined();
    expect(container.env).toMatchObject([
      { name: 'REDIS_USERNAME', valueFrom: { secretKeyRef: { key: 'REDIS_USERNAME' } } },
      { name: 'REDIS_PASSWORD', valueFrom: { secretKeyRef: { key: 'REDIS_PASSWORD' } } },
    ]);
    expect(actual.spec.template.spec.securityContext).toMatchObject({
      runAsUser: 999,
      runAsGroup: 999,
      fsGroup: 999,
    });
    expect(actual.spec.template.spec.volumes).toMatchObject([
      {},
      {
        secret: {
          items: [
            { key: 'redis-conf', path: 'redis.conf' },
            { key: 'redis-acl', path: 'users.acl' },
          ],
        },
      },
    ]);
    expect(JSON.stringify({ applied, controller: actual })).not.toContain(
      input.configuration.environment[1]!.value,
    );
  });
});
