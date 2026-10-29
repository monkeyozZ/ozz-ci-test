import type {
  V1Deployment,
  V1ObjectMeta,
  V1Probe,
  V1Secret,
  V1Service,
  V1StatefulSet,
} from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import {
  WorkloadAdapterError,
  type ManagedWorkloadResource,
  type WorkloadApplyPlan,
  type WorkloadProbe,
  type WorkloadPullSecret,
  type WorkloadTarget,
} from './contracts.js';
import { keys, ownershipLabels, selector, workloadNames, type Resource } from './names.js';
import { resourceKey } from './validation.js';

export function requiredInventory(
  inventory: readonly ManagedWorkloadResource[],
  kind: ManagedWorkloadResource['kind'],
  name: string,
  namespace: string | null,
): ManagedWorkloadResource {
  const found = inventory.find(
    (value) => resourceKey(value) === resourceKey({ kind, name, namespace }),
  );
  if (!found) throw new WorkloadAdapterError('WORKLOAD_INVENTORY_REQUIRED');
  return found;
}

export function metadata(
  target: WorkloadTarget,
  inventory: ManagedWorkloadResource,
  mutationRevision: number,
  taskId: string,
): V1ObjectMeta {
  return {
    name: inventory.name,
    ...(inventory.namespace ? { namespace: inventory.namespace } : {}),
    labels: ownershipLabels(target, inventory.kind === 'Namespace'),
    annotations: {
      [keys.nonce]: inventory.creationNonce,
      ...(inventory.kind === 'Namespace'
        ? {}
        : {
            [keys.mutation]: String(mutationRevision),
            [keys.task]: taskId,
          }),
    },
  };
}

function probe(value: WorkloadProbe): V1Probe {
  return {
    ...(value.type === 'http'
      ? { httpGet: { path: value.path!, port: value.port, scheme: 'HTTP' } }
      : { tcpSocket: { port: value.port } }),
    initialDelaySeconds: value.initialDelaySeconds,
    periodSeconds: value.periodSeconds,
    timeoutSeconds: value.timeoutSeconds,
    failureThreshold: value.failureThreshold,
    successThreshold: 1,
  };
}

export function pullSecretManifest(
  target: WorkloadTarget,
  inventory: readonly ManagedWorkloadResource[],
  secret: WorkloadPullSecret,
  mutationRevision: number,
  taskId: string,
): V1Secret {
  const name = workloadNames(target).pullSecret;
  const ownership = requiredInventory(inventory, 'Secret', name, target.namespace);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      ...metadata(target, ownership, mutationRevision, taskId),
      labels: { ...ownershipLabels(target), [keys.role]: 'pull' },
    },
    type: 'kubernetes.io/dockerconfigjson',
    immutable: false,
    data: { '.dockerconfigjson': Buffer.from(secret.dockerConfigJson).toString('base64') },
  };
}

/** All manifests are built and bounded before the first remote write. */
export function manifests(plan: WorkloadApplyPlan): Resource[] {
  const { target, configuration, inventory, mutationRevision, taskId, snapshotId, configRevision } =
    plan;
  const names = workloadNames(target, snapshotId);
  const controller = configuration.controller ?? { kind: 'Deployment', strategy: 'RollingUpdate' };
  const volumes = configuration.volumes ?? [];
  const files = configuration.secretFiles ?? [];
  const ownership = (kind: ManagedWorkloadResource['kind'], name: string) =>
    requiredInventory(inventory, kind, name, kind === 'Namespace' ? null : target.namespace);
  const base = (kind: ManagedWorkloadResource['kind'], name: string) =>
    metadata(target, ownership(kind, name), mutationRevision, taskId);
  const objects: Resource[] = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: base('Namespace', names.namespace),
    },
  ];
  objects.push({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      ...base('Secret', names.runtimeSecret!),
      labels: { ...ownershipLabels(target), [keys.role]: 'runtime', [keys.snapshot]: snapshotId },
    },
    immutable: true,
    type: 'Opaque',
    data: Object.fromEntries([
      ...configuration.environment.map((variable) => [
        variable.name,
        Buffer.from(variable.value).toString('base64'),
      ]),
      ...files.map((file) => [file.key, Buffer.from(file.value).toString('base64')]),
    ]),
  });
  if (plan.pullSecret)
    objects.push(pullSecretManifest(target, inventory, plan.pullSecret, mutationRevision, taskId));
  if (configuration.ports.length) {
    const service: V1Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: base('Service', names.service),
      spec: {
        type: 'ClusterIP',
        selector: selector(target),
        sessionAffinity: 'None',
        internalTrafficPolicy: 'Cluster',
        ipFamilyPolicy: 'SingleStack',
        ports: configuration.ports.map((port) => ({
          name: port.name,
          port: port.servicePort,
          targetPort: port.name,
          protocol: 'TCP',
          ...(port.protocol === 'http' ? { appProtocol: 'http' } : {}),
        })),
      },
    };
    objects.push(service);
  }
  if (controller.kind === 'StatefulSet')
    objects.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: base('Service', names.headlessService),
      spec: {
        type: 'ClusterIP',
        clusterIP: 'None',
        selector: selector(target),
        sessionAffinity: 'None',
        internalTrafficPolicy: 'Cluster',
        ipFamilyPolicy: 'SingleStack',
        publishNotReadyAddresses: true,
        ports: configuration.ports.map((port) => ({
          name: port.name,
          port: port.servicePort,
          targetPort: port.name,
          protocol: 'TCP',
        })),
      },
    });
  const deployment: V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: base(controller.kind, names.deployment),
    spec: {
      replicas: configuration.replicas,
      revisionHistoryLimit: 2,
      progressDeadlineSeconds: 300,
      minReadySeconds: 0,
      selector: { matchLabels: selector(target) },
      strategy:
        controller.kind === 'Deployment' && controller.strategy === 'Recreate'
          ? { type: 'Recreate' }
          : { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: {
        metadata: {
          labels: {
            ...ownershipLabels(target),
            [keys.snapshot]: snapshotId,
            [keys.configuration]: String(configRevision),
          },
          annotations: {
            [keys.rollout]: taskId,
            ...(volumes.length
              ? {
                  [keys.claims]: JSON.stringify(
                    Object.fromEntries(
                      volumes.map((volume) => [volume.claimName, volume.claimUid]),
                    ),
                  ),
                }
              : {}),
          },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          serviceAccountName: 'default',
          restartPolicy: 'Always',
          terminationGracePeriodSeconds: 30,
          dnsPolicy: 'ClusterFirst',
          schedulerName: 'default-scheduler',
          securityContext: configuration.database
            ? {
                runAsUser: 999,
                runAsGroup: 999,
                fsGroup: 999,
                fsGroupChangePolicy: 'OnRootMismatch',
              }
            : {},
          nodeSelector: { 'kubernetes.io/os': 'linux' },
          ...(plan.pullSecret ? { imagePullSecrets: [{ name: names.pullSecret }] } : {}),
          ...(volumes.length || files.length
            ? {
                volumes: [
                  ...volumes.map((volume) => ({
                    name: volume.claimName,
                    persistentVolumeClaim: {
                      claimName: volume.claimName,
                      readOnly: volume.readOnly,
                    },
                  })),
                  ...(files.length
                    ? [
                        {
                          name: 'ozz-database',
                          secret: {
                            secretName: names.runtimeSecret!,
                            optional: false,
                            defaultMode: 292,
                            items: files.map((file) => ({
                              key: file.key,
                              path: file.path.slice('/run/ozz/database/'.length),
                              mode: file.mode ?? 292,
                            })),
                          },
                        },
                      ]
                    : []),
                ],
              }
            : {}),
          containers: [
            {
              name: 'app',
              image: configuration.image,
              imagePullPolicy: 'IfNotPresent',
              terminationMessagePath: '/dev/termination-log',
              terminationMessagePolicy: 'File',
              ...(configuration.command.length ? { command: [...configuration.command] } : {}),
              ...(configuration.args.length ? { args: [...configuration.args] } : {}),
              ...(configuration.ports.length
                ? {
                    ports: configuration.ports.map((port) => ({
                      name: port.name,
                      containerPort: port.containerPort,
                      protocol: 'TCP',
                    })),
                  }
                : {}),
              ...(files.length
                ? {
                    env: configuration.environment.map((variable) => ({
                      name: variable.name,
                      valueFrom: {
                        secretKeyRef: {
                          name: names.runtimeSecret!,
                          key: variable.name,
                          optional: false,
                        },
                      },
                    })),
                  }
                : { envFrom: [{ secretRef: { name: names.runtimeSecret!, optional: false } }] }),
              ...(volumes.length || files.length
                ? {
                    volumeMounts: [
                      ...volumes.map((volume) => ({
                        name: volume.claimName,
                        mountPath: volume.path,
                        readOnly: volume.readOnly,
                      })),
                      ...(files.length
                        ? [{ name: 'ozz-database', mountPath: '/run/ozz/database', readOnly: true }]
                        : []),
                    ],
                  }
                : {}),
              resources: {
                requests: {
                  cpu: `${configuration.resources.requests.cpuMillis}m`,
                  memory: `${configuration.resources.requests.memoryMiB}Mi`,
                },
                limits: {
                  cpu: `${configuration.resources.limits.cpuMillis}m`,
                  memory: `${configuration.resources.limits.memoryMiB}Mi`,
                },
              },
              ...(configuration.readiness
                ? { readinessProbe: probe(configuration.readiness) }
                : {}),
              ...(configuration.startup ? { startupProbe: probe(configuration.startup) } : {}),
            },
          ],
        },
      },
    },
  };
  if (controller.kind === 'StatefulSet') {
    const statefulSet: V1StatefulSet = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: base('StatefulSet', names.statefulSet),
      spec: {
        replicas: configuration.replicas,
        serviceName: names.headlessService,
        podManagementPolicy: 'OrderedReady',
        revisionHistoryLimit: 2,
        minReadySeconds: 0,
        persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
        selector: deployment.spec!.selector,
        template: deployment.spec!.template,
        updateStrategy:
          controller.strategy === 'OnDelete'
            ? { type: 'OnDelete' }
            : { type: 'RollingUpdate', rollingUpdate: { partition: 0 } },
      },
    };
    objects.push(statefulSet);
  } else objects.push(deployment);
  for (const resource of objects) {
    if (Buffer.byteLength(JSON.stringify(resource)) > 63 * 1024)
      throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
  }
  return objects;
}
