import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { parseKubeconfig } from '../../packages/infrastructure/dist/kubernetes.js';
import {
  workloadNames,
  type ManagedWorkloadResource,
  type WorkloadApplyPlan,
  type WorkloadResourceReceipt,
  type WorkloadTarget,
  type WorkloadWriteHooks,
} from '../../packages/infrastructure/dist/workload.js';

export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string | null;
  deletionTimestamp?: string;
  ownerReferences?: {
    kind: string;
    apiVersion: string;
    name: string;
    uid: string;
    controller: boolean;
  }[];
}

export interface Resource {
  kind: string;
  apiVersion: string;
  metadata: Metadata;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
  immutable?: boolean;
  type?: string;
}

export interface Deployment extends Resource {
  spec: Record<string, unknown> & {
    replicas: number;
    template: {
      metadata: Metadata;
      spec: Record<string, unknown> & {
        containers: {
          name: string;
          image: string;
          resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
          [key: string]: unknown;
        }[];
      };
    };
  };
}

export interface RequestRecord {
  method: string;
  path: string;
  query: string;
  body: Resource | Record<string, unknown> | null;
}

interface Pki {
  directory: string;
  ca: string;
  cert: string;
  key: string;
}

function createPki(): Pki {
  const directory = mkdtempSync(join(tmpdir(), 'ozz-workload-tls-'));
  const run = (args: string[]) =>
    execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=ozz-workload-fixture-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    '/CN=ozz-workload-fixture',
  ]);
  writeFileSync(
    join(directory, 'server.ext'),
    'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
    { mode: 0o600 },
  );
  run([
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'server.pem',
    '-days',
    '1',
    '-extfile',
    'server.ext',
  ]);
  chmodSync(join(directory, 'server.key'), 0o600);
  return {
    directory,
    ca: readFileSync(join(directory, 'ca.pem'), 'utf8'),
    cert: readFileSync(join(directory, 'server.pem'), 'utf8'),
    key: readFileSync(join(directory, 'server.key'), 'utf8'),
  };
}

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
      message: 'synthetic-fixture-secret-must-not-escape',
    },
    status,
  );
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function key(kind: string, namespace: string | null, name: string): string {
  return `${kind}/${namespace ?? ''}/${name}`;
}

function labelsMatch(metadata: Metadata, selector: string | null): boolean {
  return (
    !selector ||
    selector.split(',').every((entry) => {
      const [name, value] = entry.split('=');
      return metadata.labels?.[name!] === value;
    })
  );
}

export class WorkloadFixture {
  private readonly pki = createPki();
  readonly kubeSystemUid = randomUUID();
  readonly token = `synthetic-fixture-token-${randomUUID()}`;
  readonly resources = new Map<string, Resource>();
  readonly requests: RequestRecord[] = [];
  readonly sockets = new Set<Duplex>();
  private readonly replicas = new Map<string, { uid: string; name: string }>();
  private readonly pods = new Map<string, { uid: string; createdAt: string }>();
  private readonly delayedPods = new Map<string, { until: number; count: number }>();
  private lastPods: Resource[] = [];
  private resourceVersion = 1;
  endpoint = '';
  server!: Server;
  metricsStatus = 200;
  eventsStatus = 200;
  metricUidMismatch = false;
  metricStale = false;
  podMode: 'healthy' | 'old' | 'unhealthy' | 'spoofed' | 'imageChanged' | 'relabelledOld' =
    'healthy';
  observeGeneration = true;
  oom = false;
  stopDelayMs = 0;
  deletionDelayMs = 0;
  holdDeletion = false;
  loseNextCreate: string | null = null;
  delayNextCreateMs = 0;
  rejectNextWrite: { kind: string; status: number } | null = null;
  raceNextReplace = false;
  normalizeQuantities = true;
  replicaSetListLag = 0;
  replicaSetListType: 'valid' | 'list_kind' | 'list_version' | 'item_kind' | 'item_version' =
    'valid';
  replicaSetReadMode: 'normal' | 'missing' | 'wrong_uid' | 'foreign_deployment' | 'wrong_label' =
    'normal';
  disappearingPod = false;
  extraStalePodOnce = false;
  extraRequest?: (request: RequestRecord, response: ServerResponse) => boolean | Promise<boolean>;
  controllerRevisionReadMode: 'normal' | 'missing' | 'foreign_owner' = 'normal';
  rotatePodUids(): void {
    this.pods.clear();
  }

  async start(): Promise<void> {
    this.server = createServer({ key: this.pki.key, cert: this.pki.cert }, (request, response) => {
      void this.handle(request, response).catch(() => failure(response, 500));
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.pki.directory, { recursive: true, force: true });
  }

  connection() {
    return parseKubeconfig(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Config',
        preferences: {},
        clusters: [
          {
            name: 'fixture',
            cluster: {
              server: this.endpoint,
              'certificate-authority-data': Buffer.from(this.pki.ca).toString('base64'),
            },
          },
        ],
        users: [{ name: 'fixture', user: { token: this.token } }],
        contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
        'current-context': 'fixture',
      }),
    );
  }

  target(): WorkloadTarget {
    const target = {
      installationId: randomUUID(),
      clusterId: randomUUID(),
      kubeSystemUid: this.kubeSystemUid,
      caFingerprint: this.connection().caFingerprint,
      projectId: randomUUID(),
      environmentId: randomUUID(),
      serviceId: randomUUID(),
      namespace: '',
    };
    target.namespace = workloadNames(target).namespace;
    return target;
  }

  get(kind: string, target: WorkloadTarget, name?: string): Resource {
    const resource = this.resources.get(
      key(
        kind,
        kind === 'Namespace' ? null : target.namespace,
        name ?? (kind === 'Namespace' ? target.namespace : workloadNames(target).deployment),
      ),
    );
    if (!resource) throw new Error('Test resource missing');
    return resource;
  }

  remove(kind: string, target: WorkloadTarget, name?: string): void {
    this.resources.delete(
      key(
        kind,
        kind === 'Namespace' ? null : target.namespace,
        name ?? workloadNames(target).deployment,
      ),
    );
  }

  changeVersion(resource: Resource): void {
    resource.metadata.resourceVersion = String(++this.resourceVersion);
  }

  writes() {
    return this.requests.filter((request) =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method),
    );
  }

  private ready(deployment: Deployment): void {
    const replicas = deployment.spec.replicas;
    const delayed = this.delayedPods.get(deployment.metadata.uid!);
    const current = delayed && Date.now() < delayed.until ? delayed.count : replicas;
    const ready = this.podMode === 'unhealthy' ? 0 : current;
    deployment.status = {
      observedGeneration: this.observeGeneration
        ? deployment.metadata.generation
        : Math.max(0, deployment.metadata.generation! - 1),
      replicas: current,
      updatedReplicas: current,
      readyReplicas: ready,
      availableReplicas: ready,
      conditions: [{ type: 'Progressing', status: 'True' }],
    };
  }

  private allPods(namespace: string): {
    pods: Resource[];
    replicaSets: Resource[];
    revisions: Resource[];
  } {
    const pods: Resource[] = [];
    const replicaSets: Resource[] = [];
    const revisions: Resource[] = [];
    for (const resource of this.resources.values()) {
      if (
        !['Deployment', 'StatefulSet'].includes(resource.kind) ||
        resource.metadata.namespace !== namespace
      )
        continue;
      const deployment = resource as Deployment;
      const stateful = resource.kind === 'StatefulSet';
      this.ready(deployment);
      const template = structuredClone(deployment.spec.template);
      if (this.podMode === 'old' || this.podMode === 'relabelledOld') {
        template.metadata.labels!['ozz.dev/snapshot-id'] = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        template.metadata.labels!['ozz.dev/config-revision'] = '1';
        template.metadata.annotations!['ozz.dev/rollout-id'] =
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        template.spec.containers[0]!.args = ['old-published-configuration'];
      }
      const templateKey = `${deployment.metadata.uid}/${JSON.stringify(template)}`;
      let set = this.replicas.get(templateKey);
      if (!set) {
        set = {
          uid: randomUUID(),
          name: `${deployment.metadata.name}-test${this.replicas.size + 1}`,
        };
        this.replicas.set(templateKey, set);
      }
      if (stateful) {
        deployment.status!.currentRevision = set.name;
        deployment.status!.updateRevision = set.name;
        revisions.push({
          apiVersion: 'apps/v1',
          kind: 'ControllerRevision',
          metadata: {
            name: set.name,
            namespace,
            uid: set.uid,
            labels: template.metadata.labels,
            ownerReferences: [
              {
                kind: 'StatefulSet',
                apiVersion: 'apps/v1',
                name: deployment.metadata.name,
                uid: deployment.metadata.uid!,
                controller: true,
              },
            ],
          },
          data: {
            spec: { template: { ...structuredClone(template), $patch: 'replace' } },
          } as unknown as Record<string, string>,
        });
      } else {
        template.metadata.labels!['pod-template-hash'] = set.uid.replaceAll('-', '').slice(0, 10);
        replicaSets.push({
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          metadata: {
            name: set.name,
            namespace,
            uid: set.uid,
            labels: template.metadata.labels,
            ownerReferences: [
              {
                kind: 'Deployment',
                apiVersion: 'apps/v1',
                name: deployment.metadata.name,
                uid: deployment.metadata.uid!,
                controller: true,
              },
            ],
          },
          spec: {
            replicas: deployment.spec.replicas,
            selector: { matchLabels: template.metadata.labels },
            template: structuredClone(template),
          },
        });
      }
      if (this.podMode === 'relabelledOld') {
        for (const key of ['ozz.dev/snapshot-id', 'ozz.dev/config-revision'])
          template.metadata.labels![key] = deployment.spec.template.metadata.labels![key]!;
        template.metadata.annotations!['ozz.dev/rollout-id'] =
          deployment.spec.template.metadata.annotations!['ozz.dev/rollout-id']!;
      }
      const replicas = Number(deployment.status!.replicas);
      for (let index = 0; index < replicas; index += 1) {
        const name = stateful ? `${deployment.metadata.name}-${index}` : `${set.name}-${index}`;
        const podKey = stateful ? `${templateKey}/${name}` : name;
        let identity = this.pods.get(podKey);
        if (!identity) {
          identity = { uid: randomUUID(), createdAt: new Date(Date.now() - 10_000).toISOString() };
          this.pods.set(podKey, identity);
        }
        const ready = this.podMode !== 'unhealthy';
        const podSpec = structuredClone(template.spec);
        if (this.podMode === 'imageChanged')
          podSpec.containers[0]!.image = `docker.io/library/busybox@sha256:${'c'.repeat(64)}`;
        pods.push({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            ...template.metadata,
            ...(stateful
              ? {
                  labels: {
                    ...template.metadata.labels,
                    'controller-revision-hash': set.name,
                    'statefulset.kubernetes.io/pod-name': name,
                  },
                }
              : {}),
            name,
            namespace,
            uid: identity.uid,
            creationTimestamp: identity.createdAt,
            ownerReferences: [
              {
                kind: stateful ? 'StatefulSet' : 'ReplicaSet',
                apiVersion: 'apps/v1',
                name: stateful ? deployment.metadata.name : set.name,
                uid:
                  this.podMode === 'spoofed'
                    ? randomUUID()
                    : stateful
                      ? deployment.metadata.uid!
                      : set.uid,
                controller: true,
              },
            ],
          },
          spec: { ...podSpec, nodeName: 'fixture-node' },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
            containerStatuses: template.spec.containers.map((container) => ({
              name: container.name,
              image: container.image,
              imageID: container.image,
              ready,
              restartCount: this.oom ? 3 : 0,
              state: { running: { startedAt: identity.createdAt } },
              ...(this.oom
                ? { lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }
                : {}),
            })),
          },
        });
      }
    }
    pods.push(
      ...[...this.resources.values()].filter(
        (resource) => resource.kind === 'Pod' && resource.metadata.namespace === namespace,
      ),
    );
    this.lastPods = pods;
    return { pods, replicaSets, revisions };
  }

  private route(
    path: string,
  ): { kind: string; namespace: string | null; name: string | null } | null {
    if (path === '/api/v1/namespaces') return { kind: 'Namespace', namespace: null, name: null };
    const namespace = /^\/api\/v1\/namespaces\/([^/]+)$/u.exec(path);
    if (namespace) return { kind: 'Namespace', namespace: null, name: namespace[1]! };
    const namespaced =
      /^\/(?:api\/v1|apis\/apps\/v1)\/namespaces\/([^/]+)\/(deployments|statefulsets|services|secrets)(?:\/([^/]+))?$/u.exec(
        path,
      );
    if (!namespaced) return null;
    return {
      namespace: namespaced[1]!,
      kind: (
        {
          deployments: 'Deployment',
          statefulsets: 'StatefulSet',
          services: 'Service',
          secrets: 'Secret',
        } as Record<string, string>
      )[namespaced[2]!]!,
      name: namespaced[3] ?? null,
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url!, this.endpoint);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Resource | Record<string, unknown>) : null;
    this.requests.push({ method: request.method!, path: url.pathname, query: url.search, body });
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      failure(response, 401);
      return;
    }
    if (
      await this.extraRequest?.(
        { method: request.method!, path: url.pathname, query: url.search, body },
        response,
      )
    )
      return;
    if (url.pathname === '/api/v1/namespaces/kube-system') {
      json(response, {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'kube-system', uid: this.kubeSystemUid, resourceVersion: '1' },
      });
      return;
    }
    const metrics = /^\/apis\/metrics.k8s.io\/v1beta1\/namespaces\/([^/]+)\/pods$/u.exec(
      url.pathname,
    );
    if (metrics) {
      if (this.metricsStatus !== 200) {
        failure(response, this.metricsStatus);
        return;
      }
      json(response, {
        apiVersion: 'metrics.k8s.io/v1beta1',
        kind: 'PodMetricsList',
        metadata: { resourceVersion: 'metrics' },
        items: this.lastPods.map((pod) => ({
          metadata: {
            name: pod.metadata.name,
            namespace: metrics[1],
            uid: this.metricUidMismatch ? randomUUID() : pod.metadata.uid,
          },
          timestamp: new Date(Date.now() - (this.metricStale ? 300_000 : 1_000)).toISOString(),
          window: '15s',
          containers: (pod.spec?.containers as { name: string }[]).map((container) => ({
            name: container.name,
            usage: { cpu: '25000000n', memory: '16Mi' },
          })),
        })),
      });
      return;
    }
    const events = /^\/api\/v1\/namespaces\/([^/]+)\/events$/u.exec(url.pathname);
    if (events) {
      if (this.eventsStatus !== 200) {
        failure(response, this.eventsStatus);
        return;
      }
      const pod = this.lastPods[0];
      json(response, {
        apiVersion: 'v1',
        kind: 'EventList',
        metadata: { resourceVersion: 'events' },
        items: pod
          ? [
              {
                apiVersion: 'v1',
                kind: 'Event',
                metadata: { name: 'fixture-event', namespace: events[1], uid: randomUUID() },
                reason: this.podMode === 'unhealthy' ? 'Unhealthy' : 'Started',
                type: this.podMode === 'unhealthy' ? 'Warning' : 'Normal',
                message: 'synthetic-fixture-secret-must-not-escape',
                count: 1,
                involvedObject: {
                  kind: 'Pod',
                  name: pod.metadata.name,
                  namespace: events[1],
                  uid: pod.metadata.uid,
                },
                firstTimestamp: new Date().toISOString(),
                lastTimestamp: new Date().toISOString(),
              },
            ]
          : [],
      });
      return;
    }
    const workloads =
      /^\/(?:api\/v1|apis\/apps\/v1)\/namespaces\/([^/]+)\/(pods|replicasets|controllerrevisions)(?:\/([^/]+))?$/u.exec(
        url.pathname,
      );
    if (workloads) {
      const source = this.allPods(workloads[1]!);
      const resources =
        workloads[2] === 'pods'
          ? source.pods
          : workloads[2] === 'replicasets'
            ? source.replicaSets
            : source.revisions;
      if (workloads[3]) {
        const resource = resources.find((value) => value.metadata.name === workloads[3]);
        if (
          !resource ||
          (workloads[2] === 'replicasets' && this.replicaSetReadMode === 'missing') ||
          (workloads[2] === 'controllerrevisions' && this.controllerRevisionReadMode === 'missing')
        ) {
          failure(response, 404);
          return;
        }
        if (
          workloads[2] === 'controllerrevisions' &&
          this.controllerRevisionReadMode === 'foreign_owner'
        )
          resource.metadata.ownerReferences![0]!.uid = randomUUID();
        if (workloads[2] === 'replicasets') {
          if (this.replicaSetReadMode === 'wrong_uid') resource.metadata.uid = randomUUID();
          if (this.replicaSetReadMode === 'foreign_deployment')
            resource.metadata.ownerReferences![0]!.uid = randomUUID();
          if (this.replicaSetReadMode === 'wrong_label')
            delete resource.metadata.labels!['ozz.dev/service-id'];
        } else if (this.disappearingPod) {
          this.disappearingPod = false;
          this.podMode = 'healthy';
          this.pods.delete(resource.metadata.name);
          failure(response, 404);
          return;
        }
        json(response, resource);
        return;
      }
      let items = resources.filter((resource) =>
        labelsMatch(resource.metadata, url.searchParams.get('labelSelector')),
      );
      if (workloads[2] === 'replicasets' && this.replicaSetListLag > 0) {
        this.replicaSetListLag -= 1;
        items = [];
      }
      if (workloads[2] === 'pods' && this.extraStalePodOnce && items[0]) {
        this.extraStalePodOnce = false;
        const stale = structuredClone(items[0]);
        stale.metadata.name += '-removed';
        stale.metadata.uid = randomUUID();
        stale.metadata.ownerReferences![0]!.name += '-removed';
        stale.metadata.ownerReferences![0]!.uid = randomUUID();
        items.push(stale);
      }
      const result = {
        apiVersion: workloads[2] === 'pods' ? 'v1' : 'apps/v1',
        kind:
          workloads[2] === 'pods'
            ? 'PodList'
            : workloads[2] === 'replicasets'
              ? 'ReplicaSetList'
              : 'ControllerRevisionList',
        metadata: { resourceVersion: String(this.resourceVersion) },
        items: items.map((item) => {
          const value: Omit<Resource, 'apiVersion' | 'kind'> & {
            apiVersion?: string;
            kind?: string;
          } = structuredClone(item);
          delete value.apiVersion;
          delete value.kind;
          return value;
        }),
      };
      if (workloads[2] === 'replicasets') {
        if (this.replicaSetListType === 'list_kind') result.kind = 'StatefulSetList';
        if (this.replicaSetListType === 'list_version') result.apiVersion = 'wrong/v1';
        if (result.items[0]) {
          if (this.replicaSetListType === 'item_kind') result.items[0].kind = 'StatefulSet';
          if (this.replicaSetListType === 'item_version') result.items[0].apiVersion = 'wrong/v1';
        }
      }
      json(response, result);
      return;
    }
    const route = this.route(url.pathname);
    if (!route) {
      failure(response, 404);
      return;
    }
    if (request.method === 'GET' && route.name === null && route.kind === 'Secret') {
      const items = [...this.resources.values()].filter(
        (resource) =>
          resource.kind === 'Secret' &&
          resource.metadata.namespace === route.namespace &&
          labelsMatch(resource.metadata, url.searchParams.get('labelSelector')),
      );
      const partial = request.headers.accept?.includes('PartialObjectMetadataList');
      json(response, {
        apiVersion: partial ? 'meta.k8s.io/v1' : 'v1',
        kind: partial ? 'PartialObjectMetadataList' : 'SecretList',
        metadata: { resourceVersion: String(this.resourceVersion) },
        items: partial
          ? items.map((item) => ({
              apiVersion: 'meta.k8s.io/v1',
              kind: 'PartialObjectMetadata',
              metadata: item.metadata,
            }))
          : items,
      });
      return;
    }
    const resourceName = route.name ?? (body as Resource | null)?.metadata?.name;
    if (!resourceName) {
      failure(response, 422);
      return;
    }
    const resourceKey = key(route.kind, route.namespace, resourceName);
    const existing = this.resources.get(resourceKey);
    if (request.method === 'GET') {
      if (!existing) {
        failure(response, 404);
        return;
      }
      if (existing.kind === 'Deployment' || existing.kind === 'StatefulSet') {
        this.ready(existing as Deployment);
        if (existing.kind === 'StatefulSet') this.allPods(existing.metadata.namespace!);
      }
      json(response, existing);
      return;
    }
    if (this.rejectNextWrite?.kind === route.kind) {
      const status = this.rejectNextWrite.status;
      this.rejectNextWrite = null;
      failure(response, status);
      return;
    }
    if (request.method === 'DELETE') {
      if (!existing) {
        failure(response, 404);
        return;
      }
      const preconditions = fields(fields(body).preconditions);
      if (
        preconditions.uid !== existing.metadata.uid ||
        preconditions.resourceVersion !== existing.metadata.resourceVersion
      ) {
        failure(response, 409);
        return;
      }
      existing.metadata.deletionTimestamp = new Date().toISOString();
      this.changeVersion(existing);
      if (!this.holdDeletion) {
        if (this.deletionDelayMs && ['Deployment', 'StatefulSet'].includes(existing.kind))
          setTimeout(() => this.resources.delete(resourceKey), this.deletionDelayMs);
        else this.resources.delete(resourceKey);
      }
      json(response, { apiVersion: 'v1', kind: 'Status', status: 'Success' });
      return;
    }
    if (request.method !== 'POST' && request.method !== 'PUT') {
      failure(response, 405);
      return;
    }
    const next = structuredClone(body) as Resource;
    if (next.kind !== route.kind || (next.metadata.namespace ?? null) !== route.namespace) {
      failure(response, 422);
      return;
    }
    if (request.method === 'POST' && existing) {
      failure(response, 409);
      return;
    }
    if (request.method === 'PUT') {
      if (!existing) {
        failure(response, 404);
        return;
      }
      if (this.raceNextReplace) {
        this.raceNextReplace = false;
        this.changeVersion(existing);
      }
      if (
        next.metadata.uid !== existing.metadata.uid ||
        next.metadata.resourceVersion !== existing.metadata.resourceVersion
      ) {
        failure(response, 409);
        return;
      }
      if (existing.immutable && JSON.stringify(existing.data) !== JSON.stringify(next.data)) {
        failure(response, 422);
        return;
      }
    }
    next.metadata.uid = existing?.metadata.uid ?? randomUUID();
    next.metadata.creationTimestamp =
      existing?.metadata.creationTimestamp ?? new Date(Date.now() - 10_000).toISOString();
    this.changeVersion(next);
    if (next.kind === 'Deployment' || next.kind === 'StatefulSet') {
      const deployment = next as Deployment;
      deployment.spec.template.metadata.creationTimestamp = null;
      if (deployment.spec.minReadySeconds === 0) delete deployment.spec.minReadySeconds;
      deployment.spec.template.spec.serviceAccount =
        deployment.spec.template.spec.serviceAccountName;
      for (const raw of (deployment.spec.template.spec.volumes ?? []) as Record<
        string,
        unknown
      >[]) {
        const claim = fields(raw.persistentVolumeClaim);
        if (claim.readOnly === false) delete claim.readOnly;
      }
      for (const container of deployment.spec.template.spec.containers) {
        for (const mount of (container.volumeMounts ?? []) as Record<string, unknown>[])
          if (mount.readOnly === false) delete mount.readOnly;
        for (const name of ['readinessProbe', 'startupProbe']) {
          const probe = fields(container[name]);
          if (probe.initialDelaySeconds === 0) delete probe.initialDelaySeconds;
        }
      }
      if (this.normalizeQuantities) {
        for (const container of deployment.spec.template.spec.containers) {
          for (const amount of [container.resources?.requests, container.resources?.limits]) {
            if (amount?.cpu === '1000m') amount.cpu = '1';
            if (amount?.memory === '1024Mi') amount.memory = '1Gi';
          }
        }
      }
      next.metadata.generation = existing
        ? (existing.metadata.generation ?? 1) +
          (JSON.stringify(existing.spec) === JSON.stringify(next.spec) ? 0 : 1)
        : 1;
      const previous = existing as Deployment | undefined;
      if (
        previous &&
        previous.spec.replicas > 0 &&
        deployment.spec.replicas === 0 &&
        this.stopDelayMs
      )
        this.delayedPods.set(next.metadata.uid!, {
          count: previous.spec.replicas,
          until: Date.now() + this.stopDelayMs,
        });
      this.ready(deployment);
    }
    if (next.kind === 'Service') {
      next.spec ??= {};
      next.spec.clusterIP ??= `10.43.0.${this.resourceVersion}`;
      next.spec.clusterIPs ??= [next.spec.clusterIP];
      next.spec.ipFamilies ??= ['IPv4'];
    }
    if (this.delayNextCreateMs && request.method === 'POST') {
      const pause = this.delayNextCreateMs;
      this.delayNextCreateMs = 0;
      await delay(pause);
    }
    this.resources.set(resourceKey, next);
    if (this.loseNextCreate === next.kind && request.method === 'POST') {
      this.loseNextCreate = null;
      response.destroy();
      return;
    }
    json(response, next, request.method === 'POST' ? 201 : 200);
  }
}

export function plan(
  target: WorkloadTarget,
  snapshotId = randomUUID(),
  revision = 1,
): WorkloadApplyPlan {
  const names = workloadNames(target, snapshotId);
  const inventory: ManagedWorkloadResource[] = [
    ['Namespace', names.namespace],
    ['Secret', names.runtimeSecret!],
    ['Secret', names.pullSecret],
    ['Service', names.service],
    ['Deployment', names.deployment],
  ].map(([kind, name]) => ({
    kind: kind as ManagedWorkloadResource['kind'],
    name: name!,
    namespace: kind === 'Namespace' ? null : target.namespace,
    creationNonce: randomUUID(),
    creationAttempted: false,
    uid: null,
    resourceVersion: null,
    mutationRevision: 0,
    specFingerprint: null,
  }));
  return {
    target,
    snapshotId,
    configRevision: revision,
    mutationRevision: revision,
    taskId: snapshotId,
    inventory,
    pullSecret: null,
    configuration: {
      image: `docker.io/library/nginx@sha256:${'a'.repeat(64)}`,
      replicas: 1,
      command: [],
      args: [],
      ports: [{ name: 'http', protocol: 'http', containerPort: 8080, servicePort: 80 }],
      resources: {
        requests: { cpuMillis: 100, memoryMiB: 64 },
        limits: { cpuMillis: 1000, memoryMiB: 1024 },
      },
      environment: [
        { name: 'GREETING', value: 'synthetic-fixture-secret-must-not-escape' },
        { name: 'MULTILINE', value: 'first\nsecond=$kept#literal' },
      ],
      readiness: {
        type: 'http',
        port: 'http',
        path: '/health',
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
        failureThreshold: 20,
      },
    },
  };
}

export function journal(input: WorkloadApplyPlan): {
  inventory: ManagedWorkloadResource[];
  receipts: WorkloadResourceReceipt[];
  hooks: WorkloadWriteHooks;
} {
  const inventory = input.inventory.map((resource) => ({ ...resource }));
  const receipts: WorkloadResourceReceipt[] = [];
  return {
    inventory,
    receipts,
    hooks: {
      async beforeWrite(intent) {
        const resource = inventory.find(
          (resource) =>
            resource.kind === intent.kind &&
            resource.name === intent.name &&
            resource.namespace === intent.namespace,
        )!;
        if (intent.action === 'create') resource.creationAttempted = true;
      },
      async onReceipt(receipt) {
        receipts.push(receipt);
        const index = inventory.findIndex(
          (resource) =>
            resource.kind === receipt.kind &&
            resource.name === receipt.name &&
            resource.namespace === receipt.namespace,
        );
        if (receipt.action === 'deleted') inventory.splice(index, 1);
        else
          inventory[index] = {
            ...inventory[index]!,
            creationAttempted: true,
            uid: receipt.uid,
            resourceVersion: receipt.resourceVersion,
            mutationRevision: receipt.mutationRevision,
            specFingerprint: receipt.specFingerprint,
          };
      },
    },
  };
}
