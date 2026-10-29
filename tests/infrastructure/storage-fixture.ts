import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { V1Node, V1PersistentVolume, V1StorageClass } from '@kubernetes/client-node' with {
  'resolution-mode': 'import',
};
import type {
  StorageResourceReceipt,
  StorageVolumePlan,
  StorageWriteHooks,
  StorageWriteIntent,
} from '../../packages/infrastructure/dist/storage.js';
import type { WorkloadTarget } from '../../packages/infrastructure/dist/workload.js';
import { WorkloadFixture, plan, type RequestRecord, type Resource } from './workload-fixture.js';

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
function failure(response: ServerResponse, status: number): void {
  json(
    response,
    {
      apiVersion: 'v1',
      kind: 'Status',
      code: status,
      message: 'storage-private-fixture-must-not-escape',
    },
    status,
  );
}
export class StorageFixture extends WorkloadFixture {
  storageClassListKind = 'StorageClassList';
  storageClassListApiVersion = 'storage.k8s.io/v1';
  storageClass: V1StorageClass = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: 'local-path',
      uid: randomUUID(),
      resourceVersion: '1',
      annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
    },
    provisioner: 'rancher.io/local-path',
    reclaimPolicy: 'Delete',
    volumeBindingMode: 'WaitForFirstConsumer',
  };
  readonly provisionerUid = randomUUID();
  readonly nodes: V1Node[] = [this.node('storage-node-a')];
  readonly pvs = new Map<string, V1PersistentVolume>();
  provisionerReady = true;
  permissions = true;
  holdPv = false;
  loseNextDelete = false;
  podListTruncated = false;
  podListStatus = 200;
  pvListTruncated = false;
  onReadPv?: () => void;
  constructor() {
    super();
    this.extraRequest = (request, response) => this.storageRequest(request, response);
  }
  node(name: string): V1Node {
    return {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: {
        name,
        uid: randomUUID(),
        resourceVersion: '1',
        labels: { 'kubernetes.io/hostname': name },
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
  }
  claim(input: StorageVolumePlan): Resource {
    const value = this.resources.get(
      `PersistentVolumeClaim/${input.target.namespace}/${input.claim.name}`,
    );
    if (!value) throw new Error('fixture PVC missing');
    return value;
  }
  bind(input: StorageVolumePlan, node = this.nodes[0]!): V1PersistentVolume {
    const claim = this.claim(input),
      name = `pvc-${claim.metadata.uid}`;
    claim.spec!.volumeName = name;
    claim.status = { phase: 'Bound' };
    this.changeVersion(claim);
    const volume: V1PersistentVolume = {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: {
        name,
        uid: randomUUID(),
        resourceVersion: '1',
        annotations: { 'pv.kubernetes.io/provisioned-by': 'rancher.io/local-path' },
      },
      spec: {
        storageClassName: this.storageClass.metadata!.name,
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem',
        persistentVolumeReclaimPolicy: 'Delete',
        capacity: { storage: String(input.requestedBytes) },
        claimRef: {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          name: input.claim.name,
          namespace: input.target.namespace,
          uid: claim.metadata.uid,
        },
        hostPath: { path: `/var/lib/local-path/${name}`, type: 'DirectoryOrCreate' },
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  { key: 'kubernetes.io/hostname', operator: 'In', values: [node.metadata!.name!] },
                ],
              },
            ],
          },
        },
      },
    };
    this.pvs.set(name, volume);
    return volume;
  }
  addPodMount(
    input: StorageVolumePlan,
    options: { readOnly?: boolean; serviceId?: string; phase?: string } = {},
  ): Resource {
    const name = `consumer-${randomUUID().slice(0, 8)}`;
    const value: Resource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: input.target.namespace,
        uid: randomUUID(),
        resourceVersion: '1',
        labels: options.serviceId ? { 'ozz.dev/service-id': options.serviceId } : {},
      },
      spec: {
        containers: [
          {
            name: 'consumer',
            image: 'fixture',
            volumeMounts: [
              { name: 'data', mountPath: '/data', readOnly: options.readOnly ?? false },
            ],
          },
        ],
        volumes: [
          {
            name: 'data',
            persistentVolumeClaim: {
              claimName: input.claim.name,
              readOnly: options.readOnly ?? false,
            },
          },
        ],
      },
      status: { phase: options.phase ?? 'Running' },
    };
    this.resources.set(`Pod/${input.target.namespace}/${name}`, value);
    return value;
  }
  private storageRequest(request: RequestRecord, response: ServerResponse): boolean {
    if (
      request.path === '/apis/apps/v1/namespaces/kube-system/deployments/local-path-provisioner'
    ) {
      json(response, {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'local-path-provisioner',
          namespace: 'kube-system',
          uid: this.provisionerUid,
          generation: 1,
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              containers: [
                { name: 'local-path-provisioner', image: 'rancher/local-path-provisioner:v0.0.34' },
              ],
            },
          },
        },
        status: { observedGeneration: 1, readyReplicas: this.provisionerReady ? 1 : 0 },
      });
      return true;
    }
    if (request.path === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews') {
      json(response, {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        status: { allowed: this.permissions },
      });
      return true;
    }
    if (request.path === '/apis/storage.k8s.io/v1/storageclasses') {
      json(response, {
        apiVersion: this.storageClassListApiVersion,
        kind: this.storageClassListKind,
        metadata: { resourceVersion: '1' },
        items: [this.storageClass],
      });
      return true;
    }
    if (request.path === '/apis/storage.k8s.io/v1/storageclasses/local-path') {
      json(response, this.storageClass);
      return true;
    }
    if (request.path === '/api/v1/nodes') {
      json(response, {
        apiVersion: 'v1',
        kind: 'NodeList',
        metadata: { resourceVersion: '1' },
        items: this.nodes,
      });
      return true;
    }
    if (request.path === '/api/v1/persistentvolumes') {
      json(response, {
        apiVersion: 'v1',
        kind: 'PersistentVolumeList',
        metadata: {
          resourceVersion: '1',
          ...(this.pvListTruncated ? { continue: 'remaining' } : {}),
        },
        items: [...this.pvs.values()],
      });
      return true;
    }
    const pv = /^\/api\/v1\/persistentvolumes\/([^/]+)$/u.exec(request.path);
    if (pv) {
      this.onReadPv?.();
      const actual = this.pvs.get(pv[1]!);
      if (actual) json(response, actual);
      else failure(response, 404);
      return true;
    }
    if (/^\/api\/v1\/namespaces\/[^/]+\/pods$/u.test(request.path)) {
      if (this.podListStatus !== 200) {
        failure(response, this.podListStatus);
        return true;
      }
      if (this.podListTruncated) {
        json(response, {
          apiVersion: 'v1',
          kind: 'PodList',
          metadata: { resourceVersion: '1', continue: 'more' },
          items: [],
        });
        return true;
      }
      return false;
    }
    const match = /^\/api\/v1\/namespaces\/([^/]+)\/persistentvolumeclaims(?:\/([^/]+))?$/u.exec(
      request.path,
    );
    if (!match) return false;
    const body = request.body as Resource | null;
    const name = match[2] ?? body?.metadata?.name;
    if (!name) {
      failure(response, 422);
      return true;
    }
    const key = `PersistentVolumeClaim/${match[1]}/${name}`;
    const existing = this.resources.get(key);
    if (request.method === 'GET') {
      if (existing) json(response, existing);
      else failure(response, 404);
      return true;
    }
    if (request.method === 'POST') {
      if (existing) {
        failure(response, 409);
        return true;
      }
      const actual = structuredClone(body!);
      actual.metadata.uid = randomUUID();
      this.changeVersion(actual);
      actual.status = { phase: 'Pending' };
      this.resources.set(key, actual);
      if (this.loseNextCreate === 'PersistentVolumeClaim') {
        this.loseNextCreate = null;
        response.destroy();
      } else json(response, actual, 201);
      return true;
    }
    if (request.method === 'DELETE') {
      if (!existing) {
        failure(response, 404);
        return true;
      }
      const preconditions = (
        request.body as { preconditions?: { uid: string; resourceVersion: string } }
      ).preconditions;
      if (
        preconditions?.uid !== existing.metadata.uid ||
        preconditions.resourceVersion !== existing.metadata.resourceVersion
      ) {
        failure(response, 409);
        return true;
      }
      existing.metadata.deletionTimestamp = new Date().toISOString();
      this.changeVersion(existing);
      if (!this.holdDeletion) {
        this.resources.delete(key);
        if (!this.holdPv && typeof existing.spec?.volumeName === 'string')
          this.pvs.delete(existing.spec.volumeName);
      }
      if (this.loseNextDelete) {
        this.loseNextDelete = false;
        response.destroy();
      } else json(response, { apiVersion: 'v1', kind: 'Status', status: 'Success' });
      return true;
    }
    failure(response, 405);
    return true;
  }
}

export function storagePlan(
  server: StorageFixture,
  target: WorkloadTarget = server.target(),
): StorageVolumePlan {
  const volumeId = randomUUID();
  return {
    target: {
      installationId: target.installationId,
      clusterId: target.clusterId,
      kubeSystemUid: target.kubeSystemUid,
      caFingerprint: target.caFingerprint,
      projectId: target.projectId,
      environmentId: target.environmentId,
      namespace: target.namespace,
      volumeId,
    },
    mutationRevision: 1,
    requestedBytes: 1024 ** 3,
    storageClassName: 'local-path',
    storageClassUid: null,
    namespace: plan(target).inventory.find((row) => row.kind === 'Namespace')!,
    claim: {
      name: `ozz-v-${volumeId.replaceAll('-', '')}`,
      namespace: target.namespace,
      creationNonce: randomUUID(),
      creationAttempted: false,
      uid: null,
      resourceVersion: null,
      mutationRevision: 1,
      ledgerVersion: 0,
      specFingerprint: null,
    },
    knownBinding: null,
  };
}
export function storageJournal(input: StorageVolumePlan): {
  plan: StorageVolumePlan;
  receipts: StorageResourceReceipt[];
  intents: StorageWriteIntent[];
  hooks: StorageWriteHooks;
} {
  const state = {
    plan: structuredClone(input),
    receipts: [] as StorageResourceReceipt[],
    intents: [] as StorageWriteIntent[],
    hooks: {} as StorageWriteHooks,
  };
  state.hooks = {
    checkpoint: async () => {},
    beforeWrite: async (intent) => {
      state.intents.push(intent);
      if (intent.action === 'create') state.plan.claim.creationAttempted = true;
      state.plan.storageClassUid = intent.storageClassUid;
      state.plan.knownBinding = intent.binding;
    },
    onReceipt: async (receipt) => {
      state.receipts.push(receipt);
      state.plan.claim = {
        ...state.plan.claim,
        uid: receipt.uid,
        resourceVersion: receipt.resourceVersion,
        specFingerprint: receipt.specFingerprint,
        creationAttempted: true,
      };
      state.plan.storageClassUid = receipt.storageClassUid;
      state.plan.knownBinding = receipt.binding;
    },
    namespace: {
      beforeWrite: async () => {
        state.plan.namespace.creationAttempted = true;
      },
      onReceipt: async (receipt) => {
        state.plan.namespace = {
          ...state.plan.namespace,
          uid: receipt.uid,
          resourceVersion: receipt.resourceVersion,
          creationAttempted: true,
        };
      },
    },
  };
  return state;
}
