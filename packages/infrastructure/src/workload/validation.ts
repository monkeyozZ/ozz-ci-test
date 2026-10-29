import type { V1Deployment, V1Service } from '@kubernetes/client-node' with {
  'resolution-mode': 'import',
};
import {
  WorkloadAdapterError,
  type ManagedWorkloadResource,
  type PublishedWorkload,
  type WorkloadApplyPlan,
  type WorkloadConfiguration,
  type WorkloadOperation,
  type WorkloadProbe,
  type WorkloadPullSecret,
  type WorkloadTarget,
  type WorkloadWriteHooks,
} from './contracts.js';
import { workloadNames, type Controller } from './names.js';
import { hasControlCharacters } from '../kubernetes/text.js';

export function invalid(): never {
  throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
}

export function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

export function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function text(value: unknown, max = 253): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlCharacters(value)
    ? value
    : null;
}

export function requireText(value: unknown, max = 253): string {
  const valid = text(value, max);
  if (!valid) throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
  return valid;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

export function imageReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    /^[a-z0-9.[\]:-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(value) &&
    !value.includes('..') &&
    !value.includes('//')
  );
}

export function validateTarget(target: WorkloadTarget): void {
  if (
    !target ||
    ![
      target.installationId,
      target.clusterId,
      target.projectId,
      target.environmentId,
      target.serviceId,
    ].every(uuid) ||
    !text(target.kubeSystemUid, 128) ||
    !/^SHA256:[a-f0-9]{64}$/u.test(target.caFingerprint) ||
    target.namespace !== workloadNames(target).namespace
  )
    invalid();
}

export function resourceKey(
  resource: Pick<ManagedWorkloadResource, 'kind' | 'name' | 'namespace'>,
): string {
  return `${resource.kind}/${resource.namespace ?? ''}/${resource.name}`;
}

export function validateInventory(
  target: WorkloadTarget,
  inventory: readonly ManagedWorkloadResource[],
): void {
  if (!Array.isArray(inventory) || inventory.length > 512) invalid();
  const names = workloadNames(target);
  const seen = new Set<string>();
  for (const resource of inventory) {
    if (
      !resource ||
      !['Namespace', 'Deployment', 'StatefulSet', 'Service', 'Secret'].includes(resource.kind) ||
      !uuid(resource.creationNonce) ||
      typeof resource.creationAttempted !== 'boolean' ||
      !boundedInteger(resource.mutationRevision, 0, Number.MAX_SAFE_INTEGER) ||
      (resource.uid !== null && !text(resource.uid, 128)) ||
      (resource.resourceVersion !== null && !text(resource.resourceVersion, 128)) ||
      (resource.specFingerprint !== null && !/^[a-f0-9]{64}$/u.test(resource.specFingerprint))
    )
      invalid();
    if (resource.kind === 'Namespace') {
      if (
        resource.namespace !== null ||
        resource.name !== names.namespace ||
        resource.mutationRevision !== 0
      )
        invalid();
    } else {
      if (resource.namespace !== target.namespace) invalid();
      if (resource.kind === 'Secret') {
        if (resource.name !== names.pullSecret && !/^ozz-r-[a-f0-9]{32}$/u.test(resource.name))
          invalid();
      } else if (
        resource.name !== names.service &&
        !(resource.kind === 'Service' && resource.name === names.headlessService)
      )
        invalid();
    }
    const key = resourceKey(resource);
    if (seen.has(key)) invalid();
    seen.add(key);
  }
}

export function validateReadInventory(
  target: WorkloadTarget,
  inventory: readonly ManagedWorkloadResource[],
  knownInventory?: readonly ManagedWorkloadResource[],
): void {
  validateInventory(target, inventory);
  if (knownInventory === undefined) return;
  validateInventory(target, knownInventory);
  const keys = new Set([...inventory, ...knownInventory].map(resourceKey));
  if (keys.size > 512) invalid();
}

function probe(value: WorkloadProbe | null, configuration: WorkloadConfiguration): void {
  if (value === null) return;
  if (
    !value ||
    !['http', 'tcp'].includes(value.type) ||
    !configuration.ports.some((port) => port.name === value.port) ||
    !boundedInteger(value.initialDelaySeconds, 0, 600) ||
    !boundedInteger(value.periodSeconds, 1, 120) ||
    !boundedInteger(value.timeoutSeconds, 1, 60) ||
    !boundedInteger(value.failureThreshold, 1, 120)
  )
    invalid();
  if (value.type === 'http') {
    if (!text(value.path, 2048) || !value.path?.startsWith('/')) invalid();
  } else if (value.path !== undefined) invalid();
}

export function validateConfiguration(configuration: WorkloadConfiguration): void {
  if (
    !configuration ||
    !imageReference(configuration.image) ||
    !boundedInteger(configuration.replicas, 1, 100) ||
    !Array.isArray(configuration.command) ||
    !Array.isArray(configuration.args) ||
    configuration.command.length > 64 ||
    configuration.args.length > 128 ||
    [...configuration.command, ...configuration.args].some(
      (value) =>
        typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 8192,
    ) ||
    !Array.isArray(configuration.ports) ||
    configuration.ports.length > 32 ||
    !Array.isArray(configuration.environment) ||
    configuration.environment.length > 256 ||
    Buffer.byteLength(JSON.stringify(configuration)) > 64 * 1024
  )
    invalid();
  const portNames = new Set<string>();
  const servicePorts = new Set<number>();
  for (const port of configuration.ports) {
    if (
      !port ||
      typeof port.name !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?$/u.test(port.name) ||
      !/[a-z]/u.test(port.name) ||
      port.name.includes('--') ||
      !['http', 'tcp'].includes(port.protocol) ||
      !boundedInteger(port.containerPort, 1, 65535) ||
      !boundedInteger(port.servicePort, 1, 65535) ||
      portNames.has(port.name) ||
      servicePorts.has(port.servicePort)
    )
      invalid();
    portNames.add(port.name);
    servicePorts.add(port.servicePort);
  }
  const environmentNames = new Set<string>();
  for (const variable of configuration.environment) {
    if (
      !variable ||
      typeof variable.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(variable.name) ||
      typeof variable.value !== 'string' ||
      variable.value.includes('\0') ||
      environmentNames.has(variable.name)
    )
      invalid();
    environmentNames.add(variable.name);
  }
  for (const resource of ['requests', 'limits'] as const) {
    const values = configuration.resources?.[resource];
    if (
      !values ||
      !boundedInteger(values.cpuMillis, 1, 128_000) ||
      !boundedInteger(values.memoryMiB, 1, 1_048_576)
    )
      invalid();
  }
  if (
    configuration.resources.requests.cpuMillis > configuration.resources.limits.cpuMillis ||
    configuration.resources.requests.memoryMiB > configuration.resources.limits.memoryMiB
  )
    invalid();
  probe(configuration.readiness, configuration);
  probe(configuration.startup, configuration);
  const controller = configuration.controller ?? { kind: 'Deployment', strategy: 'RollingUpdate' };
  if (
    !controller ||
    (controller.kind !== 'Deployment' && controller.kind !== 'StatefulSet') ||
    (controller.kind === 'Deployment'
      ? !['RollingUpdate', 'Recreate'].includes(controller.strategy)
      : !['RollingUpdate', 'OnDelete'].includes(controller.strategy))
  )
    invalid();
  if (controller.kind === 'StatefulSet' && configuration.replicas !== 1) invalid();
  const volumes = configuration.volumes ?? [];
  if (!Array.isArray(volumes) || volumes.length > 16) invalid();
  const volumeIds = new Set<string>(),
    paths = new Set<string>();
  for (const volume of volumes) {
    if (
      !volume ||
      !uuid(volume.volumeId) ||
      volume.claimName !== `ozz-v-${volume.volumeId.replaceAll('-', '')}` ||
      !text(volume.claimUid, 128) ||
      !text(volume.path, 512) ||
      !volume.path.startsWith('/') ||
      volume.path === '/' ||
      volume.path.includes('//') ||
      volume.path.split('/').some((part: string) => part === '.' || part === '..') ||
      ['/proc', '/sys', '/dev', '/run/ozz', '/run/secrets', '/var/run/secrets', '/etc/ozz'].some(
        (root) => volume.path === root || volume.path.startsWith(`${root}/`),
      ) ||
      typeof volume.readOnly !== 'boolean' ||
      volumeIds.has(volume.volumeId) ||
      paths.has(volume.path)
    )
      invalid();
    for (const path of paths)
      if (path.startsWith(`${volume.path}/`) || volume.path.startsWith(`${path}/`)) invalid();
    volumeIds.add(volume.volumeId);
    paths.add(volume.path);
  }
  if (
    volumes.some((volume) => !volume.readOnly) &&
    (configuration.replicas !== 1 ||
      (controller.kind === 'Deployment' && controller.strategy !== 'Recreate'))
  )
    invalid();
  const secretFiles = configuration.secretFiles ?? [];
  if (
    !Array.isArray(secretFiles) ||
    secretFiles.length > 8 ||
    (secretFiles.length && !configuration.database)
  )
    invalid();
  const fileKeys = new Set<string>(),
    filePaths = new Set<string>();
  for (const file of secretFiles) {
    if (
      !file ||
      !/^[A-Za-z0-9._-]{1,128}$/u.test(file.key) ||
      environmentNames.has(file.key) ||
      fileKeys.has(file.key) ||
      !/^\/run\/ozz\/database\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/u.test(file.path) ||
      filePaths.has(file.path) ||
      typeof file.value !== 'string' ||
      file.value.includes('\0') ||
      Buffer.byteLength(file.value) > 32 * 1024 ||
      (file.mode !== undefined && ![256, 288, 292].includes(file.mode))
    )
      invalid();
    fileKeys.add(file.key);
    filePaths.add(file.path);
  }
  if (configuration.database) {
    const database = configuration.database;
    if (
      controller.kind !== 'StatefulSet' ||
      configuration.replicas !== 1 ||
      volumes.length !== 1 ||
      volumes[0]!.readOnly ||
      !['postgresql', 'redis'].includes(database.engine) ||
      !boundedInteger(database.expectedMajor, 1, 99) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(database.username) ||
      (database.engine === 'postgresql'
        ? !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(database.databaseName ?? '')
        : database.databaseName !== null)
    )
      invalid();
  }
}

export function validatePullSecret(secret: WorkloadPullSecret | null | undefined): void {
  if (secret === null || secret === undefined) return;
  try {
    if (
      typeof secret.dockerConfigJson !== 'string' ||
      Buffer.byteLength(secret.dockerConfigJson) > 32 * 1024
    )
      invalid();
    const config = record(JSON.parse(secret.dockerConfigJson));
    if (Object.keys(config).some((key) => key !== 'auths')) invalid();
    const auths = record(config.auths);
    if (Object.keys(auths).length !== 1) invalid();
    for (const [server, raw] of Object.entries(auths)) {
      if (!/^[a-z0-9.[\]:-]+$/u.test(server)) invalid();
      const auth = record(raw);
      if (
        Object.keys(auth).some(
          (key) => !['auth', 'username', 'password', 'identitytoken'].includes(key),
        )
      )
        invalid();
      if (Object.values(auth).some((value) => typeof value !== 'string' || value.includes('\0')))
        invalid();
      if (!auth.auth && !auth.identitytoken && !(auth.username && auth.password)) invalid();
    }
  } catch {
    invalid();
  }
}

export function validateHooks(hooks: WorkloadWriteHooks): void {
  if (!hooks || typeof hooks.beforeWrite !== 'function' || typeof hooks.onReceipt !== 'function')
    invalid();
}

export function validatePlan(plan: WorkloadApplyPlan, hooks: WorkloadWriteHooks): void {
  validateTarget(plan?.target);
  validateInventory(plan.target, plan.inventory);
  validateHooks(hooks);
  if (
    !uuid(plan.snapshotId) ||
    !uuid(plan.taskId) ||
    !boundedInteger(plan.configRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(plan.mutationRevision, 1, Number.MAX_SAFE_INTEGER)
  )
    invalid();
  validateConfiguration(plan.configuration);
  validatePullSecret(plan.pullSecret);
  if (
    plan.allowConfigurationRepair !== undefined &&
    typeof plan.allowConfigurationRepair !== 'boolean'
  )
    invalid();
}

export function validatePublished(published: PublishedWorkload): void {
  if (
    !published ||
    !uuid(published.snapshotId) ||
    !imageReference(published.image) ||
    !boundedInteger(published.configRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(published.replicas, 1, 100) ||
    (published.controller
      ? !['Deployment', 'StatefulSet'].includes(published.controller.kind) ||
        !text(published.controller.uid, 128) ||
        published.deploymentUid !== undefined
      : !text(published.deploymentUid, 128)) ||
    !/^[a-f0-9]{64}$/u.test(published.templateFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(published.workloadFingerprint) ||
    typeof published.usesPullSecret !== 'boolean'
  )
    invalid();
}

export function validateOperation(operation: WorkloadOperation, hooks: WorkloadWriteHooks): void {
  validateTarget(operation?.target);
  validateReadInventory(operation.target, operation.inventory, operation.knownInventory);
  validateHooks(hooks);
  if (
    !['stop', 'resume', 'restart', 'delete'].includes(operation.action) ||
    !uuid(operation.taskId) ||
    !boundedInteger(operation.mutationRevision, 1, Number.MAX_SAFE_INTEGER)
  )
    invalid();
  if (operation.action === 'resume' || operation.action === 'restart') {
    if (!operation.published) throw new WorkloadAdapterError('WORKLOAD_PUBLISHED_REQUIRED');
    validatePublished(operation.published);
    if (operation.published.usesPullSecret && !operation.pullSecret) invalid();
  }
  validatePullSecret(operation.pullSecret);
}

export function validateDeployment(value: V1Deployment): void {
  if (
    value.kind !== 'Deployment' ||
    value.apiVersion !== 'apps/v1' ||
    !boundedInteger(value.metadata?.generation, 1, Number.MAX_SAFE_INTEGER) ||
    !value.spec?.template?.spec ||
    !Array.isArray(value.spec.template.spec.containers)
  )
    throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
}

export function validateController(value: Controller): void {
  if (
    !['Deployment', 'StatefulSet'].includes(value.kind ?? '') ||
    value.apiVersion !== 'apps/v1' ||
    !boundedInteger(value.metadata?.generation, 1, Number.MAX_SAFE_INTEGER) ||
    !value.spec?.template?.spec ||
    !Array.isArray(value.spec.template.spec.containers)
  )
    throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
}

export function validateService(value: V1Service): void {
  if (value.kind !== 'Service' || value.apiVersion !== 'v1' || value.spec?.type !== 'ClusterIP')
    throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
}
