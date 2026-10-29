import { setTimeout as delay } from 'node:timers/promises';
import type { V1StatefulSet } from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import { connectionMaterial, verifyCredentialTime } from '../kubernetes/config.js';
import type { ParsedKubernetesConnection } from '../kubernetes/contracts.js';
import {
  createInspectionClient,
  transportLimits,
  type InspectionClient,
  type TransportLimits,
} from '../kubernetes/transport.js';
import {
  WorkloadAdapterError,
  type KubernetesWorkloadAdapterOptions,
  type KubernetesWorkloadManager,
  type ManagedWorkloadResource,
  type WorkloadApplyPlan,
  type WorkloadApplyReceipt,
  type WorkloadObservation,
  type WorkloadOperation,
  type WorkloadOperationReceipt,
  type WorkloadReadOptions,
  type WorkloadRolloutTarget,
  type WorkloadTarget,
  type WorkloadWaitOptions,
  type WorkloadWriteHooks,
  type DatabaseVerification,
  type PublishedWorkload,
  type WorkloadDatabaseConfiguration,
} from './contracts.js';
import { verifyDatabaseWorkload } from './database.js';
import { manifests, pullSecretManifest, requiredInventory } from './manifests.js';
import { keys, workloadNames, publishedController, type Controller } from './names.js';
import { controllerSnapshot, observeWorkload } from './observation.js';
import {
  ResourceWriter,
  actualRevision,
  assertNotAhead,
  assertOwnership,
  invokeHook,
  readResource,
  safeWorkloadError,
} from './resources.js';
import {
  boundedInteger,
  requireText,
  validateController,
  validateOperation,
  validatePlan,
  validatePublished,
  validateReadInventory,
  validateTarget,
} from './validation.js';

interface Limits {
  transport: TransportLimits;
  operationTimeoutMs: number;
  rolloutTimeoutMs: number;
  pollIntervalMs: number;
  maxPods: number;
  maxEvents: number;
}

function bounds(options: KubernetesWorkloadAdapterOptions): Limits {
  const value = (number: number | undefined, fallback: number, min: number, max: number) => {
    const result = number ?? fallback;
    if (!boundedInteger(result, min, max)) throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
    return result;
  };
  return {
    transport: transportLimits(options),
    operationTimeoutMs: value(options.operationTimeoutMs, 120_000, 50, 900_000),
    rolloutTimeoutMs: value(options.rolloutTimeoutMs, 300_000, 50, 900_000),
    pollIntervalMs: value(options.pollIntervalMs, 2_000, 10, 10_000),
    maxPods: value(options.maxPods, 100, 1, 500),
    maxEvents: value(options.maxEvents, 100, 1, 500),
  };
}

function rollout(deployment: Controller, replicas: number): WorkloadRolloutTarget {
  const observation = controllerSnapshot(deployment);
  if (
    !observation.snapshotId ||
    !observation.configRevision ||
    !observation.image ||
    !observation.rolloutId
  )
    throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
  return {
    snapshotId: observation.snapshotId,
    configRevision: observation.configRevision,
    image: observation.image,
    replicas,
    controller: { kind: observation.kind, uid: observation.uid },
    templateFingerprint: observation.templateFingerprint,
    workloadFingerprint: observation.workloadFingerprint,
    usesPullSecret: Boolean(deployment.spec?.template.spec?.imagePullSecrets?.length),
    generation: observation.generation,
    rolloutId: observation.rolloutId,
  };
}

function healthy(observation: WorkloadObservation, expected: WorkloadRolloutTarget): boolean {
  const deployment = observation.controller;
  if (
    observation.configurationState !== 'consistent' ||
    !deployment ||
    deployment.deleting ||
    observation.podsTruncated ||
    deployment.uid !== publishedController(expected).uid ||
    deployment.kind !== publishedController(expected).kind ||
    deployment.generation !== expected.generation ||
    deployment.observedGeneration === null ||
    deployment.observedGeneration < expected.generation ||
    deployment.snapshotId !== expected.snapshotId ||
    deployment.configRevision !== expected.configRevision ||
    deployment.image !== expected.image ||
    deployment.templateFingerprint !== expected.templateFingerprint ||
    deployment.workloadFingerprint !== expected.workloadFingerprint ||
    deployment.rolloutId !== expected.rolloutId ||
    deployment.replicas !== expected.replicas ||
    deployment.currentReplicas !== expected.replicas ||
    deployment.updatedReplicas !== expected.replicas ||
    deployment.readyReplicas !== expected.replicas ||
    deployment.availableReplicas !== expected.replicas
  )
    return false;
  const active = observation.pods.filter(
    (pod) => pod.phase !== 'Succeeded' && pod.phase !== 'Failed',
  );
  return (
    active.length === expected.replicas &&
    active.every(
      (pod) =>
        !pod.deletionTimestamp &&
        pod.ready === true &&
        pod.phase === 'Running' &&
        pod.snapshotId === expected.snapshotId &&
        pod.configRevision === expected.configRevision &&
        pod.rolloutId === expected.rolloutId &&
        (pod.matchesControllerTemplate ?? pod.matchesDeploymentTemplate) &&
        pod.containers.some(
          (container) => container.name === 'app' && container.image === expected.image,
        ) &&
        pod.containers.length > 0 &&
        pod.containers.every(
          (container) =>
            container.ready === true && container.state === 'running' && Boolean(container.imageId),
        ),
    )
  );
}

/** One module owns Kubernetes mutation, resource receipts and bounded runtime reads. */
export class KubernetesWorkloadAdapter implements KubernetesWorkloadManager {
  private readonly limits: Limits;
  private readonly now: () => Date;

  constructor(options: KubernetesWorkloadAdapterOptions = {}) {
    this.limits = bounds(options);
    this.now = options.now ?? (() => new Date());
  }

  private async client<T>(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    options: WorkloadReadOptions,
    work: (client: InspectionClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort('inspection_timeout'),
      this.limits.operationTimeoutMs,
    );
    timer.unref();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let client: InspectionClient | undefined;
    try {
      validateTarget(target);
      connectionMaterial(connection);
      verifyCredentialTime(connection, this.now());
      if (signal.aborted) throw new WorkloadAdapterError('KUBERNETES_CANCELLED');
      if (connection.caFingerprint !== target.caFingerprint)
        throw new WorkloadAdapterError('KUBERNETES_CA_MISMATCH');
      client = await createInspectionClient(connection, this.limits.transport, signal);
      const system = await client.core.readNamespace({ name: 'kube-system' });
      if (
        system.metadata?.name !== 'kube-system' ||
        requireText(system.metadata?.uid, 128) !== target.kubeSystemUid
      )
        throw new WorkloadAdapterError('KUBERNETES_CLUSTER_IDENTITY_MISMATCH');
      return await work(client, signal);
    } catch (error) {
      const safe = safeWorkloadError(error);
      if (controller.signal.aborted && !options.signal?.aborted)
        throw new WorkloadAdapterError(
          'WORKLOAD_OPERATION_TIMEOUT',
          true,
          safe.sideEffects,
          safe.receipts,
          safe.observation,
        );
      throw safe;
    } finally {
      clearTimeout(timer);
      controller.abort('operation_finished');
      client?.close();
    }
  }

  async apply(
    connection: ParsedKubernetesConnection,
    plan: WorkloadApplyPlan,
    hooks: WorkloadWriteHooks,
  ): Promise<WorkloadApplyReceipt> {
    validatePlan(plan, hooks);
    const desired = manifests(plan);
    return this.client(connection, plan.target, hooks, async (client, signal) => {
      const writer = new ResourceWriter(
        client,
        plan.target,
        plan.inventory,
        plan.mutationRevision,
        hooks,
        signal,
        this.now,
      );
      try {
        // Validate all existing ownership and drift before introducing partial writes.
        for (const resource of desired)
          await writer.preflight(resource, plan.allowConfigurationRepair);
        const names = workloadNames(plan.target);
        const requestedKind = plan.configuration.controller?.kind ?? 'Deployment';
        const otherKind = requestedKind === 'Deployment' ? 'StatefulSet' : 'Deployment';
        const other = await readResource(client, {
          kind: otherKind,
          name: names.deployment,
          namespace: plan.target.namespace,
        });
        if (other) throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
        const previous = (await readResource(client, {
          kind: requestedKind,
          name: names.deployment,
          namespace: plan.target.namespace,
        })) as Controller | null;
        const cycleOnDelete =
          requestedKind === 'StatefulSet' &&
          plan.configuration.controller?.strategy === 'OnDelete' &&
          (previous?.spec?.replicas ?? 0) > 0 &&
          previous?.spec?.template.metadata?.annotations?.[keys.rollout] !== plan.taskId;
        const unusedService =
          plan.configuration.ports.length === 0
            ? plan.inventory.find(
                (resource) => resource.kind === 'Service' && resource.name === names.service,
              )
            : undefined;
        if (unusedService) {
          const actual = await readResource(client, unusedService);
          if (actual) {
            assertOwnership(plan.target, unusedService, actual);
            assertNotAhead(actual, plan.mutationRevision);
          }
        }
        let deployment: Controller | undefined;
        for (const resource of desired) {
          const applied = await writer.ensure(resource, plan.allowConfigurationRepair);
          if (resource.kind === 'Deployment' || resource.kind === 'StatefulSet')
            deployment = applied as Controller;
        }
        if (unusedService) await this.remove(writer, unusedService, signal);
        if (!deployment) throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
        if (cycleOnDelete)
          deployment = await this.cycleOnDelete(
            writer,
            deployment,
            plan.configuration.replicas,
            signal,
          );
        return {
          state: 'complete',
          mutationRevision: plan.mutationRevision,
          resources: [...writer.receipts],
          published: rollout(deployment, plan.configuration.replicas),
          serviceDns: plan.configuration.ports.length
            ? `${names.service}.${plan.target.namespace}.svc`
            : null,
          appliedAt: this.now().toISOString(),
        };
      } catch (error) {
        throw writer.error(error);
      }
    });
  }

  async observe(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    inventory: readonly ManagedWorkloadResource[],
    options: WorkloadReadOptions = {},
  ): Promise<WorkloadObservation> {
    validateTarget(target);
    validateReadInventory(target, inventory, options.knownInventory);
    return this.client(connection, target, options, (client) =>
      observeWorkload(client, target, inventory, this.limits, this.now(), options.knownInventory),
    );
  }

  async verifyDatabase(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    inventory: readonly ManagedWorkloadResource[],
    published: PublishedWorkload,
    database: WorkloadDatabaseConfiguration,
    options: { signal?: AbortSignal } = {},
  ): Promise<DatabaseVerification> {
    validateTarget(target);
    validateReadInventory(target, inventory);
    validatePublished(published);
    if (
      !database ||
      !['postgresql', 'redis'].includes(database.engine) ||
      !boundedInteger(database.expectedMajor, 1, 99) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(database.username) ||
      (database.engine === 'postgresql'
        ? !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(database.databaseName ?? '')
        : database.databaseName !== null)
    )
      throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
    return this.client(connection, target, options, (client, signal) =>
      verifyDatabaseWorkload(
        client,
        connection,
        target,
        inventory,
        published,
        database,
        this.limits,
        signal,
        this.now,
      ),
    );
  }

  async waitHealthy(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    expected: WorkloadRolloutTarget,
    options: WorkloadWaitOptions,
  ): Promise<WorkloadObservation> {
    validateTarget(target);
    validateReadInventory(target, options.inventory, options.knownInventory);
    validatePublished(expected);
    if (
      !boundedInteger(expected.generation, 1, Number.MAX_SAFE_INTEGER) ||
      !requireText(expected.rolloutId, 128)
    )
      throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
    const timeout = AbortSignal.timeout(this.limits.rolloutTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let last: WorkloadObservation | null = null;
    try {
      while (!signal.aborted) {
        if (options.checkpoint) await invokeHook(options.checkpoint, signal);
        last = await this.observe(connection, target, options.inventory, {
          signal,
          knownInventory: options.knownInventory,
        });
        if (options.onObservation) await invokeHook(() => options.onObservation!(last!), signal);
        if (healthy(last, expected)) return last;
        if (last.configurationState === 'drifted')
          throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT', false, 'none', [], last);
        if (last.controller?.progressDeadlineExceeded)
          throw new WorkloadAdapterError('WORKLOAD_ROLLOUT_FAILED', false, 'none', [], last);
        if (last.controller && last.controller.generation > expected.generation)
          throw new WorkloadAdapterError('WORKLOAD_REVISION_AHEAD', false, 'none', [], last);
        await delay(this.limits.pollIntervalMs, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw safeWorkloadError(error);
    }
    if (options.signal?.aborted)
      throw new WorkloadAdapterError('KUBERNETES_CANCELLED', false, 'none', [], last);
    throw new WorkloadAdapterError('WORKLOAD_ROLLOUT_TIMEOUT', false, 'none', [], last);
  }

  private async remove(
    writer: ResourceWriter,
    resource: ManagedWorkloadResource,
    signal: AbortSignal,
  ): Promise<void> {
    const previous = await writer.beginDelete(resource);
    if (previous) {
      while (true) {
        if (signal.aborted) throw new WorkloadAdapterError('KUBERNETES_CANCELLED');
        const current = await readResource(writer.client, resource);
        if (!current) break;
        // A name reused while deletion is pending is a new object, never another delete target.
        if (current.metadata?.uid !== previous.metadata?.uid)
          throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
        await delay(this.limits.pollIntervalMs, undefined, { signal });
      }
    }
    await writer.deleted(resource, previous);
  }

  private async waitStopped(
    writer: ResourceWriter,
    controller: Controller,
    signal: AbortSignal,
    knownInventory?: readonly ManagedWorkloadResource[],
  ): Promise<void> {
    while (true) {
      if (signal.aborted) throw new WorkloadAdapterError('KUBERNETES_CANCELLED');
      const observation = await observeWorkload(
        writer.client,
        writer.target,
        [...writer.inventory.values()],
        this.limits,
        this.now(),
        knownInventory,
      );
      const actual = observation.controller;
      if (
        observation.drift.some((item) => item.kind === 'Pod') ||
        (actual && actual.uid !== controller.metadata!.uid)
      )
        throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
      if (
        actual &&
        actual.replicas === 0 &&
        actual.currentReplicas === 0 &&
        actual.observedGeneration !== null &&
        actual.observedGeneration >= controller.metadata!.generation! &&
        !observation.podsTruncated &&
        !observation.pods.some((pod) => pod.phase !== 'Succeeded' && pod.phase !== 'Failed')
      )
        return;
      await delay(this.limits.pollIntervalMs, undefined, { signal });
    }
  }

  private async cycleOnDelete(
    writer: ResourceWriter,
    controller: Controller,
    replicas: number,
    signal: AbortSignal,
    knownInventory?: readonly ManagedWorkloadResource[],
  ): Promise<Controller> {
    const stopped = structuredClone(controller);
    stopped.spec!.replicas = 0;
    const zero = await writer.replaceController(stopped, controller);
    await this.waitStopped(writer, zero, signal, knownInventory);
    const current = (await writer.inspect(
      writer.get('StatefulSet', controller.metadata!.name!),
      true,
    )) as Controller | null;
    if (!current) throw new WorkloadAdapterError('WORKLOAD_RESOURCE_MISSING');
    const resumed = structuredClone(current);
    resumed.spec!.replicas = replicas;
    return writer.replaceController(resumed, current);
  }

  async operate(
    connection: ParsedKubernetesConnection,
    operation: WorkloadOperation,
    hooks: WorkloadWriteHooks,
  ): Promise<WorkloadOperationReceipt> {
    validateOperation(operation, hooks);
    return this.client(connection, operation.target, hooks, async (client, signal) => {
      const writer = new ResourceWriter(
        client,
        operation.target,
        operation.inventory,
        operation.mutationRevision,
        hooks,
        signal,
        this.now,
      );
      try {
        const names = workloadNames(operation.target);
        const namespace = requiredInventory(
          operation.inventory,
          'Namespace',
          names.namespace,
          null,
        );
        const namespaceActual = await readResource(client, namespace);
        if (namespaceActual) assertOwnership(operation.target, namespace, namespaceActual);
        else if (operation.action !== 'delete')
          throw new WorkloadAdapterError('WORKLOAD_RESOURCE_MISSING');
        if (operation.action === 'delete') {
          const owned = operation.inventory.filter((resource) => resource.kind !== 'Namespace');
          // Do not begin deleting anything if another known name has been replaced or advanced.
          for (const resource of owned) {
            const actual = await readResource(client, resource);
            if (actual) {
              assertOwnership(operation.target, resource, actual);
              assertNotAhead(actual, operation.mutationRevision);
            }
          }
          const rank = { Deployment: 0, StatefulSet: 0, Service: 1, Secret: 2, Namespace: 3 };
          for (const resource of [...owned].sort((a, b) => rank[a.kind] - rank[b.kind]))
            await this.remove(writer, resource, signal);
          return {
            action: 'delete',
            mutationRevision: operation.mutationRevision,
            resources: [...writer.receipts],
            rollout: null,
            completedAt: this.now().toISOString(),
          };
        }
        const kind = operation.published
          ? publishedController(operation.published).kind
          : operation.inventory.some((row) => row.kind === 'StatefulSet')
            ? 'StatefulSet'
            : 'Deployment';
        const ownership = writer.get(kind, names.deployment);
        const current = await writer.inspect(ownership, true);
        if (!current) throw new WorkloadAdapterError('WORKLOAD_RESOURCE_MISSING');
        const deployment = current as Controller;
        validateController(deployment);
        const recoveringOnDeleteStop =
          kind === 'StatefulSet' &&
          (deployment as V1StatefulSet).spec?.updateStrategy?.type === 'OnDelete' &&
          deployment.spec?.replicas === 0 &&
          actualRevision(deployment) === operation.mutationRevision &&
          deployment.spec.template.metadata?.annotations?.[keys.rollout] === operation.taskId;
        if (operation.action !== 'stop') {
          const published = operation.published!;
          const actual = controllerSnapshot(deployment);
          if (
            actual.uid !== publishedController(published).uid ||
            actual.kind !== publishedController(published).kind ||
            actual.snapshotId !== published.snapshotId ||
            actual.configRevision !== published.configRevision ||
            actual.image !== published.image ||
            actual.templateFingerprint !== published.templateFingerprint ||
            actual.workloadFingerprint !== published.workloadFingerprint ||
            (actual.replicas !== 0 && actual.replicas !== published.replicas) ||
            (operation.action === 'restart' && actual.replicas === 0 && !recoveringOnDeleteStop)
          )
            throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
          const observation = await observeWorkload(
            client,
            operation.target,
            operation.inventory,
            this.limits,
            this.now(),
            operation.knownInventory,
          );
          const recoveringRuntimeWrite =
            observation.configurationState === 'drifted' &&
            observation.drift.every(
              (item) =>
                (item.kind === kind &&
                  item.name === names.deployment &&
                  ['configuration_changed', 'remote_revision_ahead'].includes(item.reason)) ||
                (published.usesPullSecret &&
                  item.kind === 'Secret' &&
                  item.name === names.pullSecret &&
                  item.reason === 'remote_revision_ahead'),
            );
          if (observation.configurationState !== 'consistent' && !recoveringRuntimeWrite)
            throw new WorkloadAdapterError(
              'WORKLOAD_CONFIGURATION_DRIFT',
              false,
              'none',
              [],
              observation,
            );
          if (published.usesPullSecret) {
            const desired = pullSecretManifest(
              operation.target,
              operation.inventory,
              operation.pullSecret!,
              operation.mutationRevision,
              operation.taskId,
            );
            if (Buffer.byteLength(JSON.stringify(desired)) > 63 * 1024)
              throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
            await writer.ensure(desired);
          }
        }
        const next = structuredClone(deployment);
        next.metadata!.annotations = {
          ...next.metadata!.annotations,
          [keys.mutation]: String(operation.mutationRevision),
          [keys.task]: operation.taskId,
        };
        if (operation.action === 'stop') next.spec!.replicas = 0;
        else if (operation.action === 'resume') next.spec!.replicas = operation.published!.replicas;
        else {
          next.spec!.template.metadata ??= {};
          next.spec!.template.metadata.annotations = {
            ...next.spec!.template.metadata.annotations,
            [keys.rollout]: operation.taskId,
          };
          if (recoveringOnDeleteStop) next.spec!.replicas = operation.published!.replicas;
        }
        let applied = await writer.replaceController(next, deployment);
        if (
          operation.action === 'restart' &&
          kind === 'StatefulSet' &&
          (deployment as V1StatefulSet).spec?.updateStrategy?.type === 'OnDelete' &&
          !recoveringOnDeleteStop &&
          deployment.spec?.template.metadata?.annotations?.[keys.rollout] !== operation.taskId
        )
          applied = await this.cycleOnDelete(
            writer,
            applied,
            operation.published!.replicas,
            signal,
            operation.knownInventory,
          );
        if (operation.action === 'stop') {
          while (true) {
            if (signal.aborted) throw new WorkloadAdapterError('KUBERNETES_CANCELLED');
            const observation = await observeWorkload(
              client,
              operation.target,
              [...writer.inventory.values()],
              this.limits,
              this.now(),
              operation.knownInventory,
            );
            const actual = observation.controller;
            if (observation.drift.some((item) => item.kind === 'Pod'))
              throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
            if (actual && actual.uid !== applied.metadata!.uid)
              throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
            if (
              actual &&
              actual.replicas === 0 &&
              actual.currentReplicas === 0 &&
              actual.observedGeneration !== null &&
              actual.observedGeneration >= applied.metadata!.generation! &&
              !observation.podsTruncated &&
              !observation.pods.some((pod) => pod.phase !== 'Succeeded' && pod.phase !== 'Failed')
            )
              break;
            await delay(this.limits.pollIntervalMs, undefined, { signal });
          }
        }
        return {
          action: operation.action,
          mutationRevision: operation.mutationRevision,
          resources: [...writer.receipts],
          rollout:
            operation.action === 'stop' ? null : rollout(applied, operation.published!.replicas),
          completedAt: this.now().toISOString(),
        };
      } catch (error) {
        throw writer.error(error);
      }
    });
  }
}
