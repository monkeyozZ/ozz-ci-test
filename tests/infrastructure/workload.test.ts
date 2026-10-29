import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KubernetesWorkloadAdapter,
  WorkloadAdapterError,
  workloadNames,
  type WorkloadApplyPlan,
  type WorkloadOperation,
} from '../../packages/infrastructure/dist/workload.js';
import {
  WorkloadFixture,
  journal,
  plan,
  type Deployment,
  type Resource,
} from './workload-fixture.js';

const fixtures: WorkloadFixture[] = [];
const adapter = () =>
  new KubernetesWorkloadAdapter({
    requestTimeoutMs: 1000,
    operationTimeoutMs: 5000,
    rolloutTimeoutMs: 400,
    pollIntervalMs: 20,
  });

async function fixture() {
  const value = new WorkloadFixture();
  fixtures.push(value);
  await value.start();
  return value;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function deployed(privateImage = false) {
  const server = await fixture();
  const input = plan(server.target());
  if (privateImage)
    input.pullSecret = {
      dockerConfigJson: JSON.stringify({
        auths: { 'docker.io': { username: 'fixture-user', password: 'fixture-current-password' } },
      }),
    };
  const state = journal(input);
  const manager = adapter();
  const applied = await manager.apply(server.connection(), input, state.hooks);
  return { server, input, state, manager, applied };
}

function changed(input: WorkloadApplyPlan, state: ReturnType<typeof journal>): WorkloadApplyPlan {
  const next = plan(input.target, randomUUID(), input.configRevision + 1);
  return {
    ...next,
    inventory: [
      ...state.inventory,
      ...next.inventory.filter(
        (resource) =>
          !state.inventory.some((old) => old.kind === resource.kind && old.name === resource.name),
      ),
    ],
  };
}

function currentInventory(input: WorkloadApplyPlan, state: ReturnType<typeof journal>) {
  const names = workloadNames(input.target, input.snapshotId);
  return state.inventory.filter(
    (resource) =>
      resource.kind !== 'Secret' ||
      resource.name === names.runtimeSecret ||
      (input.pullSecret && resource.name === names.pullSecret),
  );
}

async function republished(privateImage = false) {
  const previous = await deployed(privateImage);
  await previous.manager.waitHealthy(
    previous.server.connection(),
    previous.input.target,
    previous.applied.published,
    { inventory: previous.state.inventory },
  );
  const input = changed(previous.input, previous.state);
  const state = journal(input);
  const applied = await previous.manager.apply(
    previous.server.connection(),
    { ...input, inventory: currentInventory(input, state) },
    state.hooks,
  );
  return {
    ...previous,
    previousInput: previous.input,
    previousApplied: previous.applied,
    input,
    state,
    applied,
  };
}

describe('Kubernetes workload mutation and observation through the official SDK', () => {
  it('applies digest configuration with durable UID receipts and verifies the target Pods and metrics', async () => {
    const { server, input, state, manager, applied } = await deployed();
    expect(applied.state).toBe('complete');
    expect(applied.resources).toHaveLength(4);
    expect(applied.resources.every((receipt) => receipt.uid && receipt.resourceVersion)).toBe(true);
    expect(server.writes().map((request) => request.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'POST',
    ]);
    const deployment = server.get('Deployment', input.target) as Deployment;
    expect(deployment.spec.template.spec.containers[0]!.image).toBe(input.configuration.image);
    expect(deployment.spec.template.spec.containers[0]!.readinessProbe).toMatchObject({
      httpGet: { port: 'http', path: '/health' },
    });
    expect(deployment.spec.template.spec.containers[0]!.startupProbe).toMatchObject({
      tcpSocket: { port: 'http' },
    });
    const runtimeSecret = server.get(
      'Secret',
      input.target,
      workloadNames(input.target, input.snapshotId).runtimeSecret!,
    );
    expect(runtimeSecret.immutable).toBe(true);
    expect(Buffer.from(runtimeSecret.data!.MULTILINE!, 'base64').toString('utf8')).toBe(
      'first\nsecond=$kept#literal',
    );
    const observation = await manager.waitHealthy(
      server.connection(),
      input.target,
      applied.published,
      { inventory: state.inventory },
    );
    expect(observation.configurationState).toBe('consistent');
    expect(observation.pods[0]!.matchesDeploymentTemplate).toBe(true);
    expect(observation.pods[0]!.owner).toEqual({
      kind: 'ReplicaSet',
      uid: observation.pods[0]!.replicaSetUid,
    });
    expect(observation.pods[0]!.replicaSetUid).toBeTruthy();
    expect(observation.pods[0]!.containers[0]!.imageId).toBe(input.configuration.image);
    expect(observation.metrics).toMatchObject({
      state: 'available',
      cpuCores: 0.025,
      memoryBytes: 16 * 1024 ** 2,
    });
    expect(observation.serviceDns).toBe(
      `${workloadNames(input.target).service}.${input.target.namespace}.svc`,
    );
    expect(JSON.stringify({ applied, observation })).not.toContain('synthetic-fixture-secret');
  });

  it.each(['list_kind', 'list_version', 'item_kind', 'item_version'] as const)(
    'rejects a mismatched ReplicaSet list type (%s) instead of misclassifying the Pod owner',
    async (mode) => {
      const { server, input, state, manager } = await deployed();
      server.replicaSetListType = mode;
      const writes = server.writes().length;
      await expect(
        manager.observe(server.connection(), input.target, state.inventory),
      ).rejects.toMatchObject({ code: 'KUBERNETES_INVALID_RESPONSE' });
      expect(server.writes()).toHaveLength(writes);
    },
  );

  it('replays the same plan without recreating or replacing completed resources', async () => {
    const { server, input, state, manager, applied } = await deployed();
    const writes = server.writes().length;
    const again = await manager.apply(
      server.connection(),
      { ...input, inventory: state.inventory },
      state.hooks,
    );
    expect(server.writes()).toHaveLength(writes);
    expect(again.published.deploymentUid).toBe(applied.published.deploymentUid);
    expect(again.resources.every((receipt) => receipt.action === 'verified')).toBe(true);
  });

  it('keeps prior snapshot and unused pull Secrets owned across two publications and runtime operations', async () => {
    const { server, input, state, manager, applied, previousInput, previousApplied } =
      await republished(true);
    const previousNames = workloadNames(input.target, previousInput.snapshotId);
    const retainedNames = [previousNames.runtimeSecret!, previousNames.pullSecret];
    const writes = server.writes().length;
    const observation = await manager.waitHealthy(
      server.connection(),
      input.target,
      applied.published,
      {
        inventory: currentInventory(input, state),
        knownInventory: state.inventory,
      },
    );
    expect(applied.published.snapshotId).not.toBe(previousApplied.published.snapshotId);
    expect(applied.published.deploymentUid).toBe(previousApplied.published.deploymentUid);
    expect(applied.published.generation).toBeGreaterThan(previousApplied.published.generation);
    expect(observation.configurationState).toBe('consistent');
    expect(observation.pods.every((pod) => pod.snapshotId === input.snapshotId)).toBe(true);
    for (const name of retainedNames) {
      const recorded = state.inventory.find((resource) => resource.name === name)!;
      expect(observation.resources.find((resource) => resource.name === name)).toMatchObject({
        state: 'verified',
        expectedUid: recorded.uid,
        observedUid: recorded.uid,
      });
      expect(server.get('Secret', input.target, name).metadata.uid).toBe(recorded.uid);
    }
    expect(server.writes()).toHaveLength(writes);
    let mutationRevision = input.mutationRevision;
    for (const action of ['stop', 'resume', 'restart'] as const) {
      const operation = await manager.operate(
        server.connection(),
        {
          target: input.target,
          action,
          taskId: randomUUID(),
          mutationRevision: ++mutationRevision,
          inventory: currentInventory(input, state),
          knownInventory: state.inventory,
          published: applied.published,
        },
        state.hooks,
      );
      if (operation.rollout)
        await expect(
          manager.waitHealthy(server.connection(), input.target, operation.rollout, {
            inventory: currentInventory(input, state),
            knownInventory: state.inventory,
          }),
        ).resolves.toMatchObject({ configurationState: 'consistent' });
    }
    expect(
      server
        .writes()
        .slice(writes)
        .every((request) => request.path.includes('/deployments/')),
    ).toBe(true);
    expect(server.writes().some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('still rejects an untracked same-label Secret when historical Secrets are registered', async () => {
    const { server, input, state, manager, applied, previousInput } = await republished();
    const unknown = structuredClone(
      server.get(
        'Secret',
        input.target,
        workloadNames(input.target, previousInput.snapshotId).runtimeSecret!,
      ),
    );
    unknown.metadata.name = workloadNames(input.target, randomUUID()).runtimeSecret!;
    unknown.metadata.uid = randomUUID();
    server.resources.set(`Secret/${input.target.namespace}/${unknown.metadata.name}`, unknown);
    const writes = server.writes().length;
    const options = { knownInventory: state.inventory };
    const observation = await manager.observe(
      server.connection(),
      input.target,
      currentInventory(input, state),
      options,
    );
    expect(observation.configurationState).toBe('drifted');
    expect(observation.drift).toContainEqual({
      kind: 'Secret',
      name: unknown.metadata.name,
      reason: 'untracked_resource',
    });
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        ...options,
        inventory: currentInventory(input, state),
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_CONFIGURATION_DRIFT' });
    expect(server.writes()).toHaveLength(writes);
  });

  it('allows confirmed missing historical Secrets while a missing current Secret prevents health', async () => {
    const { server, input, state, manager, applied, previousInput } = await republished();
    const previousName = workloadNames(input.target, previousInput.snapshotId).runtimeSecret!;
    const currentName = workloadNames(input.target, input.snapshotId).runtimeSecret!;
    const previousUid = server.get('Secret', input.target, previousName).metadata.uid;
    const currentUid = server.get('Secret', input.target, currentName).metadata.uid;
    server.remove('Secret', input.target, previousName);
    const writes = server.writes().length;
    const options = {
      inventory: currentInventory(input, state),
      knownInventory: state.inventory,
    };
    const healthy = await manager.waitHealthy(
      server.connection(),
      input.target,
      applied.published,
      options,
    );
    expect(healthy.configurationState).toBe('consistent');
    expect(healthy.resources.some((resource) => resource.name === previousName)).toBe(false);
    expect(state.inventory.find((resource) => resource.name === previousName)?.uid).toBe(
      previousUid,
    );
    expect(
      server.requests.some(
        (request) => request.method === 'GET' && request.path.endsWith(`/secrets/${previousName}`),
      ),
    ).toBe(true);
    server.remove('Secret', input.target, currentName);
    const missing = await manager.observe(
      server.connection(),
      input.target,
      options.inventory,
      options,
    );
    expect(missing.configurationState).toBe('missing');
    expect(missing.resources.find((resource) => resource.name === currentName)).toMatchObject({
      state: 'missing',
      reason: 'resource_not_found',
      expectedUid: currentUid,
      observedUid: null,
    });
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, options),
    ).rejects.toMatchObject({
      code: 'WORKLOAD_ROLLOUT_TIMEOUT',
      observation: { configurationState: 'missing' },
    });
    expect(server.writes()).toHaveLength(writes);
  });

  it.each(['uid', 'ownership_label', 'creation_nonce', 'revision'] as const)(
    'protects a historical Secret with changed %s before restart writes',
    async (changedField) => {
      const { server, input, state, manager, applied, previousInput } = await republished();
      const name = workloadNames(input.target, previousInput.snapshotId).runtimeSecret!;
      const secret = server.get('Secret', input.target, name);
      if (changedField === 'uid') secret.metadata.uid = randomUUID();
      else if (changedField === 'ownership_label')
        delete secret.metadata.labels!['ozz.dev/service-id'];
      else if (changedField === 'creation_nonce')
        secret.metadata.annotations!['ozz.dev/creation-nonce'] = randomUUID();
      else secret.metadata.annotations!['ozz.dev/mutation-revision'] = '999';
      const writes = server.writes().length;
      const options = { knownInventory: state.inventory };
      const observation = await manager.observe(
        server.connection(),
        input.target,
        currentInventory(input, state),
        options,
      );
      expect(observation.configurationState).toBe('drifted');
      expect(observation.drift).toContainEqual({
        kind: 'Secret',
        name,
        reason: changedField === 'revision' ? 'remote_revision_ahead' : 'ownership_mismatch',
      });
      await expect(
        manager.operate(
          server.connection(),
          {
            target: input.target,
            action: 'restart',
            taskId: randomUUID(),
            mutationRevision: input.mutationRevision + 1,
            inventory: currentInventory(input, state),
            knownInventory: state.inventory,
            published: applied.published,
          },
          state.hooks,
        ),
      ).rejects.toMatchObject({ code: 'WORKLOAD_CONFIGURATION_DRIFT', sideEffects: 'none' });
      expect(server.writes()).toHaveLength(writes);
    },
  );

  it('bounds the combined required and known inventory before opening a read connection', async () => {
    const { server, input, state, manager } = await deployed();
    const resource = state.inventory.find((value) => value.kind === 'Secret')!;
    const knownInventory = Array.from({ length: 513 }, () => ({
      ...resource,
      name: workloadNames(input.target, randomUUID()).runtimeSecret!,
      creationNonce: randomUUID(),
    }));
    const requests = server.requests.length;
    for (const known of [knownInventory, knownInventory.slice(0, 508)]) {
      await expect(
        manager.observe(server.connection(), input.target, state.inventory, {
          knownInventory: known,
        }),
      ).rejects.toMatchObject({ code: 'WORKLOAD_INPUT_INVALID' });
    }
    expect(server.requests).toHaveLength(requests);
  });

  it('rejects an invalid inherited namespace, missing reservation and oversized secret before network writes', async () => {
    const server = await fixture();
    const input = plan(server.target());
    const state = journal(input);
    await expect(
      adapter().apply(
        server.connection(),
        { ...input, target: { ...input.target, namespace: 'different-project' } },
        state.hooks,
      ),
    ).rejects.toMatchObject({ code: 'WORKLOAD_INPUT_INVALID' });
    await expect(
      adapter().apply(server.connection(), { ...input, inventory: [] }, state.hooks),
    ).rejects.toMatchObject({ code: 'WORKLOAD_INVENTORY_REQUIRED' });
    input.configuration.environment = [{ name: 'LARGE', value: 's'.repeat(49 * 1024) }];
    await expect(adapter().apply(server.connection(), input, state.hooks)).rejects.toMatchObject({
      code: 'WORKLOAD_INPUT_INVALID',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('supports IANA port names starting with digits, container-port aliases and 2048-character HTTP probe paths', async () => {
    const server = await fixture();
    const input = plan(server.target());
    input.configuration.ports = [
      { name: '1http', protocol: 'http', containerPort: 8080, servicePort: 80 },
      { name: '2aaaaaaaaaaaaaa', protocol: 'tcp', containerPort: 8080, servicePort: 81 },
    ];
    input.configuration.readiness!.port = '1http';
    input.configuration.readiness!.path = `/${'a'.repeat(2047)}`;
    input.configuration.startup!.port = '2aaaaaaaaaaaaaa';
    const state = journal(input);
    await adapter().apply(server.connection(), input, state.hooks);
    const service = server.get('Service', input.target);
    expect(service.spec!.ports).toMatchObject([
      { name: '1http', port: 80, targetPort: '1http' },
      { name: '2aaaaaaaaaaaaaa', port: 81, targetPort: '2aaaaaaaaaaaaaa' },
    ]);
    const deployment = server.get('Deployment', input.target) as Deployment;
    expect(deployment.spec.template.spec.containers[0]!.readinessProbe).toMatchObject({
      httpGet: { path: input.configuration.readiness!.path },
    });
  });

  it('rejects malformed IANA port names and control characters in HTTP probe paths before network access', async () => {
    const server = await fixture();
    for (const name of ['123', '-http', 'http-', 'http--api', 'HTTP', 'a'.repeat(16), ['http']]) {
      const input = plan(server.target());
      input.configuration.ports[0]!.name = name as string;
      await expect(
        adapter().apply(server.connection(), input, journal(input).hooks),
      ).rejects.toMatchObject({ code: 'WORKLOAD_INPUT_INVALID' });
    }
    for (const path of [`/${'a'.repeat(2048)}`, '/bad\npath', '/bad\u0001path', '/bad\u007fpath']) {
      const input = plan(server.target());
      input.configuration.readiness!.path = path;
      await expect(
        adapter().apply(server.connection(), input, journal(input).hooks),
      ).rejects.toMatchObject({ code: 'WORKLOAD_INPUT_INVALID' });
    }
    expect(server.requests).toHaveLength(0);
  });

  it('requires a durable creation attempt and never adopts a resource based on matching labels alone', async () => {
    const { server, input, state, manager } = await deployed();
    const writes = server.writes().length;
    const unknown = state.inventory.map((resource) =>
      resource.kind === 'Deployment'
        ? { ...resource, uid: null, creationAttempted: false }
        : resource,
    );
    await expect(
      manager.apply(server.connection(), { ...input, inventory: unknown }, state.hooks),
    ).rejects.toMatchObject({ code: 'WORKLOAD_OWNERSHIP_MISMATCH', sideEffects: 'none' });
    expect(server.writes()).toHaveLength(writes);
  });

  it('recovers a create whose response was lost only after the creation intent was persisted', async () => {
    const server = await fixture();
    const input = plan(server.target());
    const state = journal(input);
    server.loseNextCreate = 'Namespace';
    await expect(adapter().apply(server.connection(), input, state.hooks)).rejects.toMatchObject({
      code: 'KUBERNETES_UNREACHABLE',
      sideEffects: 'may_have_changed',
    });
    expect(state.inventory.find((resource) => resource.kind === 'Namespace')).toMatchObject({
      uid: null,
      creationAttempted: true,
    });
    const applied = await adapter().apply(
      server.connection(),
      { ...input, inventory: state.inventory },
      state.hooks,
    );
    expect(applied.resources.find((receipt) => receipt.kind === 'Namespace')?.action).toBe(
      'verified',
    );
    expect(server.writes().filter((request) => request.path === '/api/v1/namespaces')).toHaveLength(
      1,
    );
  });

  it('uses the current resourceVersion while retaining the recorded UID and allows status-only changes', async () => {
    const { server, input, state, manager } = await deployed();
    const current = server.get('Deployment', input.target);
    server.changeVersion(current);
    const version = current.metadata.resourceVersion;
    const next = changed(input, state);
    const nextState = journal(next);
    await manager.apply(server.connection(), next, nextState.hooks);
    const replacement = server
      .writes()
      .findLast((request) => request.method === 'PUT' && request.path.includes('/deployments/'))!
      .body as Resource;
    expect(replacement.metadata.resourceVersion).toBe(version);
    expect(replacement.metadata.uid).toBe(current.metadata.uid);
  });

  it('refuses replaced UIDs and remote revisions newer than the accepted operation, including explicit repair', async () => {
    const { server, input, state, manager } = await deployed();
    const current = server.get('Deployment', input.target);
    const uid = current.metadata.uid;
    const writes = server.writes().length;
    current.metadata.uid = randomUUID();
    await expect(
      manager.apply(
        server.connection(),
        { ...changed(input, state), allowConfigurationRepair: true },
        journal(changed(input, state)).hooks,
      ),
    ).rejects.toMatchObject({ code: 'WORKLOAD_OWNERSHIP_MISMATCH' });
    current.metadata.uid = uid;
    current.metadata.annotations!['ozz.dev/mutation-revision'] = '20';
    const next = changed(input, state);
    await expect(
      manager.apply(
        server.connection(),
        { ...next, allowConfigurationRepair: true },
        journal(next).hooks,
      ),
    ).rejects.toMatchObject({ code: 'WORKLOAD_REVISION_AHEAD' });
    expect(server.writes()).toHaveLength(writes);
  });

  it('reports drift without writing and repairs only after explicit full-republish confirmation', async () => {
    const { server, input, state, manager } = await deployed();
    const current = server.get('Deployment', input.target) as Deployment;
    current.spec.template.spec.containers[0]!.args = ['external-change'];
    server.changeVersion(current);
    const next = changed(input, state);
    const writes = server.writes().length;
    await expect(
      manager.apply(server.connection(), next, journal(next).hooks),
    ).rejects.toMatchObject({ code: 'WORKLOAD_CONFIGURATION_DRIFT', sideEffects: 'none' });
    expect(server.writes()).toHaveLength(writes);
    const observation = await manager.observe(server.connection(), input.target, state.inventory);
    expect(observation.configurationState).toBe('drifted');
    const nextState = journal(next);
    await manager.apply(
      server.connection(),
      { ...next, allowConfigurationRepair: true },
      nextState.hooks,
    );
    expect(
      (server.get('Deployment', input.target) as Deployment).spec.template.spec.containers[0]!.args,
    ).toBeUndefined();
  });

  it('surfaces version conflicts without forcing a replacement and retains partial receipts', async () => {
    const { server, input, state, manager } = await deployed();
    const next = changed(input, state);
    server.rejectNextWrite = { kind: 'Deployment', status: 409 };
    let failure: unknown;
    try {
      await manager.apply(server.connection(), next, journal(next).hooks);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkloadAdapterError);
    expect(failure).toMatchObject({
      code: 'WORKLOAD_RESOURCE_CONFLICT',
      retryable: true,
      sideEffects: 'may_have_changed',
    });
    expect(
      (failure as WorkloadAdapterError).receipts.some(
        (receipt) => receipt.kind === 'Secret' && receipt.action === 'created',
      ),
    ).toBe(true);
    expect(server.writes().every((request) => !request.query.includes('force'))).toBe(true);
    expect(
      (server.get('Deployment', input.target) as Deployment).spec.template.metadata.labels![
        'ozz.dev/snapshot-id'
      ],
    ).toBe(input.snapshotId);
  });

  it('stops before a remote write when the durable lease callback rejects', async () => {
    const server = await fixture();
    const input = plan(server.target());
    const state = journal(input);
    for (const reason of [new Error('synthetic-fenced-worker'), undefined, null, false, 0]) {
      await expect(
        adapter().apply(server.connection(), input, {
          ...state.hooks,
          beforeWrite: () => Promise.reject(reason),
        }),
      ).rejects.toMatchObject({ code: 'WORKLOAD_CALLBACK_FAILED', sideEffects: 'none' });
    }
    expect(server.writes()).toHaveLength(0);
  });

  it('retains a known UID if receipt persistence fails after Kubernetes changed', async () => {
    const server = await fixture();
    const input = plan(server.target());
    const state = journal(input);
    let failure: WorkloadAdapterError | undefined;
    try {
      await adapter().apply(server.connection(), input, {
        ...state.hooks,
        onReceipt: async () => {
          throw new Error('synthetic-database-unavailable');
        },
      });
    } catch (error) {
      failure = error as WorkloadAdapterError;
    }
    expect(failure).toMatchObject({
      code: 'WORKLOAD_CALLBACK_FAILED',
      sideEffects: 'may_have_changed',
    });
    expect(failure!.receipts[0]!.uid).toBe(server.get('Namespace', input.target).metadata.uid);
    expect(server.writes()).toHaveLength(1);
    expect(JSON.stringify(failure)).not.toContain('synthetic-database-unavailable');
  });

  it('cancels an in-flight create without claiming its remote side effects were rolled back', async () => {
    const server = await fixture();
    const input = plan(server.target());
    const state = journal(input);
    const controller = new AbortController();
    server.delayNextCreateMs = 150;
    await expect(
      adapter().apply(server.connection(), input, {
        ...state.hooks,
        signal: controller.signal,
        beforeWrite: async (intent) => {
          await state.hooks.beforeWrite(intent);
          setTimeout(() => controller.abort(), 30);
        },
      }),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CANCELLED', sideEffects: 'may_have_changed' });
    await delay(180);
    expect(server.get('Namespace', input.target).metadata.uid).toBeTruthy();
    expect(state.receipts).toHaveLength(0);
  });

  it('does not confuse old healthy Pods or an unobserved generation with a completed rollout', async () => {
    const { server, input, state, manager, applied } = await deployed();
    server.podMode = 'old';
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_ROLLOUT_TIMEOUT' });
    server.podMode = 'healthy';
    server.observeGeneration = false;
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_ROLLOUT_TIMEOUT' });
  });

  it('verifies a newly created Pod controller when the ReplicaSet list came from an earlier rollout snapshot', async () => {
    const { server, input, state, manager, applied } = await republished();
    server.replicaSetListLag = 1;
    const writes = server.writes().length;
    const observation = await manager.waitHealthy(
      server.connection(),
      input.target,
      applied.published,
      {
        inventory: currentInventory(input, state),
        knownInventory: state.inventory,
      },
    );
    expect(observation.configurationState).toBe('consistent');
    expect(observation.pods).toHaveLength(input.configuration.replicas);
    expect(observation.pods[0]?.snapshotId).toBe(input.snapshotId);
    expect(observation.pods[0]?.matchesDeploymentTemplate).toBe(true);
    expect(
      server.requests.filter((request) => /\/replicasets\/[^/]+$/u.test(request.path)),
    ).toHaveLength(1);
    expect(server.writes()).toHaveLength(writes);
  });

  it.each(['missing', 'wrong_uid', 'foreign_deployment', 'wrong_label'] as const)(
    'retains ownership protection for a %s controller absent from the ReplicaSet list',
    async (mode) => {
      const { server, input, state, manager } = await deployed();
      server.replicaSetListLag = 1;
      server.replicaSetReadMode = mode;
      const writes = server.writes().length;
      const observation = await manager.observe(server.connection(), input.target, state.inventory);
      expect(observation.configurationState).toBe('drifted');
      expect(observation.pods).toHaveLength(0);
      expect(observation.drift).toEqual([
        expect.objectContaining({ kind: 'Pod', reason: 'unowned_pod_matches_service_selector' }),
      ]);
      expect(server.writes()).toHaveLength(writes);
    },
  );

  it('marks an observation incomplete when an unverified Pod disappears before its named read', async () => {
    const { server, input, state, manager, applied } = await deployed();
    server.podMode = 'spoofed';
    server.disappearingPod = true;
    const observation = await manager.observe(server.connection(), input.target, state.inventory);
    expect(observation.configurationState).toBe('consistent');
    expect(observation.drift).toEqual([]);
    expect(observation.pods).toHaveLength(0);
    expect(observation.podsTruncated).toBe(true);
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
      }),
    ).resolves.toMatchObject({ configurationState: 'consistent', podsTruncated: false });
  });

  it('waits for a complete Pod set even when an incomplete read contains all expected healthy replicas', async () => {
    const { server, input, state, manager, applied } = await deployed();
    server.extraStalePodOnce = true;
    const observations: { readyPods: number; incomplete: boolean }[] = [];
    await manager.waitHealthy(server.connection(), input.target, applied.published, {
      inventory: state.inventory,
      async onObservation(observation) {
        observations.push({
          readyPods: observation.pods.filter((pod) => pod.ready).length,
          incomplete: observation.podsTruncated,
        });
      },
    });
    expect(observations).toEqual([
      { readyPods: input.configuration.replicas, incomplete: true },
      { readyPods: input.configuration.replicas, incomplete: false },
    ]);
  });

  it('detects a Pod image changed outside its controller even while runtime status reports the old image', async () => {
    const { server, input, state, manager, applied } = await deployed();
    server.podMode = 'imageChanged';
    const observation = await manager.observe(server.connection(), input.target, state.inventory);
    expect(observation.configurationState).toBe('drifted');
    expect(observation.drift).toContainEqual({
      kind: 'Pod',
      name: observation.pods[0]!.name,
      reason: 'pod_images_differ_from_controller',
    });
    expect(observation.pods[0]!.containers[0]!.image).not.toBe(applied.published.image);
    expect(observation.pods[0]!.containers[0]!.imageId).toBe(applied.published.image);
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_CONFIGURATION_DRIFT' });
  });

  it('rejects relabelled old Pods and withholds an unverified snapshot from log readers', async () => {
    const { server, input, state, manager, applied } = await deployed();
    server.podMode = 'relabelledOld';
    const observation = await manager.observe(server.connection(), input.target, state.inventory);
    expect(observation.configurationState).toBe('drifted');
    expect(observation.pods[0]).toMatchObject({
      ready: true,
      snapshotId: null,
      rolloutId: applied.published.rolloutId,
      matchesDeploymentTemplate: false,
    });
    expect(observation.pods[0]!.containers[0]!.image).toBe(applied.published.image);
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_CONFIGURATION_DRIFT' });
  });

  it('keeps a failed probe separate from complete application and returns bounded, non-secret events', async () => {
    const { server, input, state, manager, applied } = await deployed();
    server.podMode = 'unhealthy';
    let failure: WorkloadAdapterError | undefined;
    try {
      await manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
      });
    } catch (error) {
      failure = error as WorkloadAdapterError;
    }
    expect(applied.state).toBe('complete');
    expect(failure?.code).toBe('WORKLOAD_ROLLOUT_TIMEOUT');
    expect(failure?.observation?.events[0]?.reason).toBe('Unhealthy');
    expect(JSON.stringify(failure)).not.toContain('synthetic-fixture-secret');
  });

  it('bounds health callbacks and cancellation even when a consumer never settles', async () => {
    const { server, input, state, manager, applied } = await deployed();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
        signal: controller.signal,
        checkpoint: () => new Promise<void>(() => {}),
      }),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CANCELLED' });
    await expect(
      manager.waitHealthy(server.connection(), input.target, applied.published, {
        inventory: state.inventory,
        onObservation: () => new Promise<void>(() => {}),
      }),
    ).rejects.toMatchObject({ code: 'WORKLOAD_ROLLOUT_TIMEOUT' });
  });

  it('stops a drifted workload by changing only replica intent and waits for active Pods to disappear', async () => {
    const { server, input, state, manager } = await deployed();
    const current = server.get('Deployment', input.target) as Deployment;
    current.spec.template.spec.containers[0]!.args = ['external-change'];
    const template = structuredClone(current.spec.template);
    server.stopDelayMs = 160;
    const start = Date.now();
    const stopped = await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'stop',
        taskId: randomUUID(),
        mutationRevision: 2,
        inventory: state.inventory,
      },
      state.hooks,
    );
    expect(stopped.action).toBe('stop');
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    expect((server.get('Deployment', input.target) as Deployment).spec.replicas).toBe(0);
    expect((server.get('Deployment', input.target) as Deployment).spec.template).toEqual(template);
  });

  it('restores the published replicas and template, refreshes current pull auth, and restarts with a new rollout token', async () => {
    const { server, input, state, manager, applied } = await deployed(true);
    await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'stop',
        taskId: randomUUID(),
        mutationRevision: 2,
        inventory: state.inventory,
      },
      state.hooks,
    );
    const currentAuth = {
      dockerConfigJson: JSON.stringify({
        auths: { 'docker.io': { username: 'fixture-user', password: 'fixture-new-password' } },
      }),
    };
    const resumed = await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'resume',
        taskId: randomUUID(),
        mutationRevision: 3,
        inventory: state.inventory,
        published: applied.published,
        pullSecret: currentAuth,
      },
      state.hooks,
    );
    expect(resumed.rollout?.templateFingerprint).toBe(applied.published.templateFingerprint);
    expect((server.get('Deployment', input.target) as Deployment).spec.replicas).toBe(
      applied.published.replicas,
    );
    const secret = server.get('Secret', input.target, workloadNames(input.target).pullSecret);
    expect(Buffer.from(secret.data!['.dockerconfigjson']!, 'base64').toString('utf8')).toBe(
      currentAuth.dockerConfigJson,
    );
    const restartId = randomUUID();
    const restarted = await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'restart',
        taskId: restartId,
        mutationRevision: 4,
        inventory: state.inventory,
        published: applied.published,
        pullSecret: currentAuth,
      },
      state.hooks,
    );
    expect(restarted.rollout?.rolloutId).toBe(restartId);
    expect(restarted.rollout?.templateFingerprint).toBe(applied.published.templateFingerprint);
    await expect(
      manager.waitHealthy(server.connection(), input.target, restarted.rollout!, {
        inventory: state.inventory,
      }),
    ).resolves.toMatchObject({ configurationState: 'consistent' });
  });

  it('refuses resume when a supplied published identity does not match the actual template', async () => {
    const { server, input, state, manager, applied } = await deployed();
    await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'stop',
        taskId: randomUUID(),
        mutationRevision: 2,
        inventory: state.inventory,
      },
      state.hooks,
    );
    const writes = server.writes().length;
    const operation: WorkloadOperation = {
      target: input.target,
      action: 'resume',
      taskId: randomUUID(),
      mutationRevision: 3,
      inventory: state.inventory,
      published: { ...applied.published, snapshotId: randomUUID() },
    };
    await expect(
      manager.operate(server.connection(), operation, state.hooks),
    ).rejects.toMatchObject({ code: 'WORKLOAD_CONFIGURATION_DRIFT', sideEffects: 'none' });
    expect(server.writes()).toHaveLength(writes);
  });

  it('recovers a completed runtime write whose receipt was lost without changing its template or restarting twice', async () => {
    const { server, input, state, manager, applied } = await deployed();
    await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'stop',
        taskId: randomUUID(),
        mutationRevision: 2,
        inventory: state.inventory,
      },
      state.hooks,
    );
    for (const [index, action] of (['resume', 'restart'] as const).entries()) {
      const operation: WorkloadOperation = {
        target: input.target,
        action,
        taskId: randomUUID(),
        mutationRevision: index + 3,
        inventory: state.inventory,
        published: applied.published,
      };
      await expect(
        manager.operate(server.connection(), operation, {
          ...state.hooks,
          onReceipt: async () => {
            throw new Error('synthetic-lost-receipt');
          },
        }),
      ).rejects.toMatchObject({
        code: 'WORKLOAD_CALLBACK_FAILED',
        sideEffects: 'may_have_changed',
      });
      const generation = server.get('Deployment', input.target).metadata.generation;
      const recovered = await manager.operate(server.connection(), operation, state.hooks);
      expect(recovered.rollout?.generation).toBe(generation);
      expect(recovered.rollout?.workloadFingerprint).toBe(applied.published.workloadFingerprint);
      expect(recovered.rollout?.snapshotId).toBe(input.snapshotId);
      await expect(
        manager.waitHealthy(server.connection(), input.target, recovered.rollout!, {
          inventory: state.inventory,
        }),
      ).resolves.toMatchObject({ configurationState: 'consistent' });
    }
  });

  it('deletes only inventoried resources with UID preconditions and waits for 404, preserving the Namespace', async () => {
    const { server, input, state, manager } = await deployed();
    server.deletionDelayMs = 120;
    const namespaceUid = server.get('Namespace', input.target).metadata.uid;
    const start = Date.now();
    const deleted = await manager.operate(
      server.connection(),
      {
        target: input.target,
        action: 'delete',
        taskId: randomUUID(),
        mutationRevision: 2,
        inventory: state.inventory,
      },
      state.hooks,
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(110);
    expect(deleted.resources.filter((receipt) => receipt.action === 'deleted')).toHaveLength(3);
    expect(server.get('Namespace', input.target).metadata.uid).toBe(namespaceUid);
    const removals = server.writes().filter((request) => request.method === 'DELETE');
    expect(removals[0]!.path).toContain('/deployments/');
    expect(
      removals.every((request) =>
        Boolean((request.body as { preconditions?: { uid: string } }).preconditions?.uid),
      ),
    ).toBe(true);
    expect(
      removals.some((request) => /persistentvolume|\/namespaces\/[^/]+$/u.test(request.path)),
    ).toBe(false);
  });

  it('detects a replaced resource before beginning a multi-resource deletion', async () => {
    const { server, input, state, manager } = await deployed();
    server.get('Service', input.target).metadata.uid = randomUUID();
    await expect(
      manager.operate(
        server.connection(),
        {
          target: input.target,
          action: 'delete',
          taskId: randomUUID(),
          mutationRevision: 2,
          inventory: state.inventory,
        },
        state.hooks,
      ),
    ).rejects.toMatchObject({ code: 'WORKLOAD_OWNERSHIP_MISMATCH', sideEffects: 'none' });
    expect(server.writes().some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('reports unavailable/stale metrics as unknown and does not attach values to a reused Pod name', async () => {
    const { server, input, state, manager } = await deployed();
    server.oom = true;
    server.metricsStatus = 403;
    const denied = await manager.observe(server.connection(), input.target, state.inventory);
    expect(denied.metrics).toMatchObject({ state: 'unknown', cpuCores: null, memoryBytes: null });
    expect(denied.pods[0]!.containers[0]).toMatchObject({ oomKilled: true, restartCount: 3 });
    server.metricsStatus = 200;
    server.metricUidMismatch = true;
    const mismatch = await manager.observe(server.connection(), input.target, state.inventory);
    expect(mismatch.metrics.state).toBe('unknown');
    server.metricUidMismatch = false;
    server.metricStale = true;
    expect(
      (await manager.observe(server.connection(), input.target, state.inventory)).metrics.state,
    ).toBe('unknown');
  });

  it('does not mistake changed Secret labels for a confirmed 404 and exposes actual missing resource identity', async () => {
    const { server, input, state, manager } = await deployed();
    const runtimeName = workloadNames(input.target, input.snapshotId).runtimeSecret!;
    const secret = server.get('Secret', input.target, runtimeName);
    delete secret.metadata.labels!['ozz.dev/service-id'];
    const drift = await manager.observe(server.connection(), input.target, state.inventory);
    expect(drift.resources.find((resource) => resource.name === runtimeName)).toMatchObject({
      state: 'drifted',
      reason: 'ownership_mismatch',
      observedUid: secret.metadata.uid,
    });
    const deploymentUid = server.get('Deployment', input.target).metadata.uid;
    server.remove('Deployment', input.target);
    const missing = await manager.observe(server.connection(), input.target, state.inventory);
    expect(missing.resources.find((resource) => resource.kind === 'Deployment')).toMatchObject({
      state: 'missing',
      expectedUid: deploymentUid,
      observedUid: null,
    });
  });

  it('rejects a same-label Pod with a different controller UID and keeps two cluster contexts separate', async () => {
    const first = await deployed();
    first.server.podMode = 'spoofed';
    const observed = await first.manager.observe(
      first.server.connection(),
      first.input.target,
      first.state.inventory,
    );
    expect(observed.pods).toHaveLength(0);
    expect(observed.configurationState).toBe('drifted');
    const second = await fixture();
    const next = plan({
      ...first.input.target,
      clusterId: randomUUID(),
      kubeSystemUid: second.kubeSystemUid,
      caFingerprint: second.connection().caFingerprint,
    });
    const secondState = journal(next);
    await first.manager.apply(second.connection(), next, secondState.hooks);
    expect(second.get('Deployment', next.target).metadata.uid).not.toBe(
      first.applied.published.deploymentUid,
    );
    const writes = first.server.writes().length;
    await expect(
      first.manager.apply(first.server.connection(), next, secondState.hooks),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CA_MISMATCH' });
    expect(first.server.writes()).toHaveLength(writes);
  });
});
