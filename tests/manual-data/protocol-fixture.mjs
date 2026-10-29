import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseKubeconfig } from '../../packages/infrastructure/dist/kubernetes/config.js';
import {
  templateFingerprint,
  workloadFingerprint,
} from '../../packages/infrastructure/dist/workload/names.js';
import { ENGINES } from '../../scripts/manual-data-artifact.mjs';
import { sha256, writeNew } from '../../scripts/manual-data-core.mjs';
import { dataIdentity, tar, temporary } from './archive-fixture.mjs';

const { WebSocketServer } = createRequire(
  new URL('../../packages/infrastructure/package.json', import.meta.url),
)('ws');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};
const error = (response) =>
  json(response, { message: 'fixture-sensitive-value-must-not-escape' }, 403);
const owner = (kind, name, uid) => ({ apiVersion: 'apps/v1', kind, name, uid, controller: true });
export class ManualFixture {
  constructor(kind, mode) {
    this.kind = kind;
    this.mode = mode;
    this.identity = dataIdentity();
    this.serviceId = randomUUID();
    this.projectId = randomUUID();
    this.snapshotId = randomUUID();
    this.controllerUid = randomUUID();
    this.namespaceUid = randomUUID();
    this.secretUid = randomUUID();
    this.pvUid = randomUUID();
    this.storageClassUid = randomUUID();
    this.nodeUid = randomUUID();
    this.podUid = randomUUID();
    this.replicaSetUid = randomUUID();
    this.maintenanceId = randomUUID();
    this.namespace = `ozz-e-${this.identity.environmentId.replaceAll('-', '')}`;
    this.pvcName = `ozz-v-${this.identity.volumeId.replaceAll('-', '')}`;
    this.name = `ozz-s-${this.serviceId.replaceAll('-', '')}`;
    this.secretName = `ozz-r-${this.snapshotId.replaceAll('-', '')}`;
    this.probes =
      kind === 'postgresql'
        ? { tables: [{ schema: 'public', table: 'markers' }] }
        : kind === 'redis'
          ? { database: 0, keys: ['marker', 'expiring'] }
          : {};
    this.labels = {
      'app.kubernetes.io/managed-by': 'ozz',
      'ozz.dev/installation-id': this.identity.installationId,
      'ozz.dev/cluster-id': this.identity.clusterId,
      'ozz.dev/project-id': this.projectId,
      'ozz.dev/environment-id': this.identity.environmentId,
    };
    this.serviceLabels = {
      ...this.labels,
      'ozz.dev/service-id': this.serviceId,
      'ozz.dev/snapshot-id': this.snapshotId,
    };
    this.node = {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: {
        name: 'ozz-node',
        uid: this.nodeUid,
        resourceVersion: '1',
        labels: { 'kubernetes.io/hostname': 'ozz-node' },
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
    this.affinity = {
      required: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: 'kubernetes.io/hostname', operator: 'In', values: ['ozz-node'] },
            ],
          },
        ],
      },
    };
    this.pv = {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: {
        name: `pvc-${this.identity.pvcUid}`,
        uid: this.pvUid,
        annotations: { 'pv.kubernetes.io/provisioned-by': 'rancher.io/local-path' },
      },
      spec: {
        claimRef: { name: this.pvcName, namespace: this.namespace, uid: this.identity.pvcUid },
        storageClassName: 'local-path',
        persistentVolumeReclaimPolicy: 'Delete',
        nodeAffinity: this.affinity,
      },
    };
    this.pvc = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: this.pvcName,
        namespace: this.namespace,
        uid: this.identity.pvcUid,
        labels: { ...this.labels, 'ozz.dev/volume-id': this.identity.volumeId },
      },
      spec: {
        volumeName: this.pv.metadata.name,
        storageClassName: 'local-path',
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem',
      },
      status: { phase: 'Bound' },
    };
    this.class = {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'local-path', uid: this.storageClassUid },
      provisioner: 'rancher.io/local-path',
    };
    const image =
      kind === 'files'
        ? 'docker.io/library/nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236'
        : ENGINES[kind].image;
    const volumes = [
      { name: this.pvcName, persistentVolumeClaim: { claimName: this.pvcName, readOnly: false } },
      ...(kind === 'redis'
        ? [
            {
              name: 'ozz-database',
              secret: {
                secretName: this.secretName,
                defaultMode: 292,
                items: [
                  { key: 'redis-config', path: 'redis.conf', mode: 292 },
                  { key: 'redis-acl', path: 'users.acl', mode: 292 },
                ],
              },
            },
          ]
        : []),
    ];
    this.controller = {
      apiVersion: 'apps/v1',
      kind: kind === 'files' ? 'Deployment' : 'StatefulSet',
      metadata: {
        name: this.name,
        namespace: this.namespace,
        uid: this.controllerUid,
        labels: this.serviceLabels,
      },
      spec: {
        replicas: this.running() ? 1 : 0,
        template: {
          metadata: { labels: this.serviceLabels },
          spec: {
            volumes,
            containers: [
              {
                name: 'app',
                image,
                envFrom: [{ secretRef: { name: this.secretName } }],
                volumeMounts: [
                  {
                    name: this.pvcName,
                    mountPath: kind === 'postgresql' ? '/var/lib/postgresql/data' : '/data',
                  },
                ],
              },
            ],
          },
        },
      },
    };
    this.templateFingerprint = templateFingerprint(this.controller);
    this.workloadFingerprint = workloadFingerprint(this.controller);
    this.image = image;
    this.requests = [];
    this.commands = [];
    this.helpers = new Map();
    this.uploaded = null;
    this.aof = true;
    this.restoreMode = false;
    this.expiredSession = false;
    this.truncatedPods = false;
    this.extraPods = [];
    this.attachments = [];
    this.nextExec = null;
    this.onCommand = null;
    this.onCreate = null;
    this.failOperation = null;
    this.replacedSecret = false;
    this.mutateProduct = null;
    this.expiry = Date.now() + 60_000;
    this.username = 'demo';
    this.databaseName = 'example';
    this.createdAt = new Date(Date.now() - 3600000).toISOString();
    this.tarBytes = tar();
    this.pgBytes = Buffer.from('PGDMPsynthetic-protocol-only');
    this.rdbBytes = Buffer.from('REDIS0012synthetic-protocol-only');
  }
  running() {
    return this.mode === 'online' || this.mode === 'formal';
  }
  pod() {
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: `${this.name}-0`,
        namespace: this.namespace,
        uid: this.podUid,
        labels: this.serviceLabels,
        ownerReferences: [
          this.kind === 'files'
            ? owner('ReplicaSet', `${this.name}-rs`, this.replicaSetUid)
            : owner('StatefulSet', this.name, this.controllerUid),
        ],
      },
      spec: {
        containers: [{ name: 'app', image: this.image }],
        volumes: [{ name: this.pvcName, persistentVolumeClaim: { claimName: this.pvcName } }],
        nodeName: 'ozz-node',
      },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'app',
            containerID: `containerd://${this.podUid}`,
            restartCount: 0,
            ready: true,
            state: { running: { startedAt: new Date().toISOString() } },
          },
        ],
      },
    };
  }
  views() {
    const now = new Date().toISOString(),
      published = {
        deploymentId: this.snapshotId,
        configRevision: 1,
        image: { deployReference: this.image },
      };
    const observedController = {
      kind: this.controller.kind,
      uid: this.controllerUid,
      snapshotId: this.snapshotId,
      configRevision: 1,
      replicas: this.running() ? 1 : 0,
      readyReplicas: this.running() ? 1 : 0,
      deleting: false,
      templateFingerprint: this.templateFingerprint,
      workloadFingerprint: this.workloadFingerprint,
    };
    const resources = [
      { kind: this.controller.kind, name: this.name, expectedUid: this.controllerUid },
      { kind: 'Namespace', name: this.namespace, expectedUid: this.namespaceUid },
      { kind: 'Secret', name: this.secretName, expectedUid: this.secretUid },
    ].map((r) => ({ ...r, observedUid: r.expectedUid, state: 'verified' }));
    const service = {
      id: this.serviceId,
      projectId: this.projectId,
      environmentId: this.identity.environmentId,
      clusterId: this.identity.clusterId,
      published,
      activeTask: null,
      hasUnpublishedChanges: false,
      observationStale: false,
      configurationState: 'consistent',
      desiredState: this.running() ? 'running' : 'stopped',
      runtimeState: this.running() ? 'running' : 'stopped',
      databaseInstanceId: this.kind === 'files' ? null : randomUUID(),
      observation: {
        observedAt: now,
        configurationState: 'consistent',
        controller: observedController,
        podsTruncated: false,
        resources,
        pods: this.running()
          ? [
              {
                name: `${this.name}-0`,
                uid: this.podUid,
                phase: 'Running',
                ready: true,
                deletionTimestamp: null,
                matchesControllerTemplate: true,
              },
            ]
          : [],
      },
      createdAt: this.createdAt,
    };
    const volume = {
      id: this.identity.volumeId,
      manualDataIdentity: this.identity,
      environment: { id: this.identity.environmentId },
      cluster: { id: this.identity.clusterId },
      project: { id: this.projectId },
      namespace: this.namespace,
      pvc: { name: this.pvcName, uid: this.identity.pvcUid, phase: 'Bound', deleting: false },
      desiredState: 'active',
      destroyedAt: null,
      activeTask: null,
      observation: { state: 'ready', stale: false, observedAt: now },
      locality: 'verified',
      pv: {
        name: this.pv.metadata.name,
        uid: this.pvUid,
        reclaimPolicy: 'Delete',
        nodeAffinity: globalThis.structuredClone(this.affinity),
      },
      storageClassName: 'local-path',
      storageClassUid: this.storageClassUid,
      nodes: [{ name: 'ozz-node', uid: this.nodeUid, ready: true }],
      mounts: {
        published: [
          {
            volumeId: this.identity.volumeId,
            serviceId: this.serviceId,
            lastPublishedDeploymentId: this.snapshotId,
            mountPath: '/data',
          },
        ],
        truncated: false,
      },
      maintenance: this.running()
        ? null
        : {
            id: this.maintenanceId,
            purpose: this.mode,
            state: 'active',
            revision: 1,
            overdue: false,
            releasedAt: null,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
      retainedDatabase: this.kind === 'files' ? null : { engine: this.kind },
      createdAt: this.createdAt,
    };
    const database = {
      engine: this.kind,
      exactVersion: ENGINES[this.kind].version,
      service: { id: this.serviceId },
      dataVolume: {
        id: this.identity.volumeId,
        pvcUid: this.identity.pvcUid,
        namespace: this.namespace,
        pvcName: this.pvcName,
      },
      projectId: this.projectId,
      environmentId: this.identity.environmentId,
      clusterId: this.identity.clusterId,
      consumersTruncated: false,
      consumers: [],
      protection: { active: true },
      initialization: { pvcUid: this.identity.pvcUid, state: 'verified' },
      databaseReady: this.running(),
      observationStale: false,
      connection: {
        username: this.kind === 'redis' ? 'default' : this.username,
        database: this.databaseName,
        redisDatabase: 0,
      },
    };
    this.mutateProduct?.({ service, volume, database });
    return { service, volume, database };
  }
  async start(test) {
    this.directory = await temporary(test);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'key.pem',
        '-out',
        'cert.pem',
        '-days',
        '2',
        '-subj',
        '/CN=ozz-manual-synthetic-ca',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { cwd: this.directory, stdio: 'ignore' },
    );
    const cert = await readFile(join(this.directory, 'cert.pem')),
      key = await readFile(join(this.directory, 'key.pem'));
    this.kubeServer = httpsServer({ cert, key }, (request, response) => {
      void this.kubeRequest(request, response).catch(() => error(response));
    });
    this.apiServer = httpServer((request, response) => {
      void this.apiRequest(request, response).catch(() => error(response));
    });
    this.ws = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) =>
        protocols.has('v5.channel.k8s.io') ? 'v5.channel.k8s.io' : false,
    });
    this.kubeServer.on('upgrade', (request, socket, head) =>
      this.ws.handleUpgrade(request, socket, head, (client) => this.exec(request, client)),
    );
    await Promise.all([listen(this.kubeServer), listen(this.apiServer)]);
    this.kubeOrigin = `https://127.0.0.1:${this.kubeServer.address().port}`;
    this.apiOrigin = `http://127.0.0.1:${this.apiServer.address().port}`;
    const kubeconfig = {
      apiVersion: 'v1',
      kind: 'Config',
      'current-context': 'operator',
      clusters: [
        {
          name: 'fixed',
          cluster: {
            server: this.kubeOrigin,
            'certificate-authority-data': cert.toString('base64'),
          },
        },
      ],
      users: [{ name: 'operator', user: { token: 'synthetic-private-token' } }],
      contexts: [{ name: 'operator', context: { cluster: 'fixed', user: 'operator' } }],
    };
    this.connection = parseKubeconfig(JSON.stringify(kubeconfig));
    await writeNew(join(this.directory, 'cluster.json'), kubeconfig);
    await writeNew(join(this.directory, 'session.json'), {
      cookie: 'ozz_session=synthetic-session-cookie-0123456789',
    });
    this.contextFile = join(this.directory, 'context.json');
    await writeNew(this.contextFile, {
      apiOrigin: this.apiOrigin,
      appOrigin: this.apiOrigin,
      sessionFile: 'session.json',
      kubeconfigFile: 'cluster.json',
      serviceId: this.serviceId,
      engine: this.kind,
      expectedIdentity: this.identity,
      probes: this.probes,
    });
    test.after(async () => {
      for (const client of this.ws.clients) client.terminate();
      this.ws.close();
      this.kubeServer.closeAllConnections();
      this.apiServer.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => this.kubeServer.close(resolve)),
        new Promise((resolve) => this.apiServer.close(resolve)),
      ]);
    });
    return this;
  }
  async body(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  }
  async apiRequest(request, response) {
    const path = new URL(request.url, this.apiOrigin).pathname;
    const body = await this.body(request);
    this.requests.push({
      kind: 'api',
      method: request.method,
      path,
      body,
      origin: request.headers.origin,
      csrf: request.headers['x-csrf-token'],
    });
    if (
      this.expiredSession ||
      request.headers.cookie !== 'ozz_session=synthetic-session-cookie-0123456789'
    ) {
      error(response);
      return;
    }
    if (path === '/api/auth/me') {
      json(response, {
        data: {
          user: { id: randomUUID() },
          restoreMode: this.restoreMode,
          csrfToken: 'synthetic-csrf',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      return;
    }
    const views = this.views();
    let data;
    if (path === `/api/volumes/${this.identity.volumeId}`) data = views.volume;
    else if (path === `/api/services/${this.serviceId}`) data = views.service;
    else if (path === `/api/services/${this.serviceId}/database`) data = views.database;
    else if (path === `/api/clusters/${this.identity.clusterId}`)
      data = {
        id: this.identity.clusterId,
        apiEndpoint: this.kubeOrigin,
        identity: {
          kubeSystemUid: this.identity.kubeSystemUid,
          caFingerprint: this.connection.caFingerprint,
        },
      };
    else if (
      path === `/api/volumes/${this.identity.volumeId}/manual-data-records` &&
      request.method === 'POST'
    ) {
      if (
        request.headers.origin !== this.apiOrigin ||
        request.headers['x-csrf-token'] !== 'synthetic-csrf'
      ) {
        error(response);
        return;
      }
      data = { ...body, id: randomUUID(), verificationSource: 'operator_reported' };
    } else {
      json(response, { message: 'missing' }, 404);
      return;
    }
    json(response, { data });
  }
  async kubeRequest(request, response) {
    const url = new URL(request.url, this.kubeOrigin),
      path = url.pathname,
      body = await this.body(request);
    this.requests.push({
      kind: 'kube',
      method: request.method,
      path,
      query: url.search,
      body,
      accept: request.headers.accept,
    });
    if (request.headers.authorization !== 'Bearer synthetic-private-token') {
      error(response);
      return;
    }
    if (this.failPath === path) {
      error(response);
      return;
    }
    let value;
    if (path === '/api/v1/namespaces/kube-system')
      value = {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: 'kube-system', uid: this.identity.kubeSystemUid },
      };
    else if (path === `/api/v1/namespaces/${this.namespace}`)
      value = {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: this.namespace, uid: this.namespaceUid, labels: this.labels },
      };
    else if (path === `/api/v1/namespaces/${this.namespace}/persistentvolumeclaims/${this.pvcName}`)
      value = this.pvc;
    else if (path === `/api/v1/persistentvolumes/${this.pv.metadata.name}`) value = this.pv;
    else if (path === '/apis/storage.k8s.io/v1/storageclasses/local-path') value = this.class;
    else if (path === '/api/v1/nodes')
      value = { apiVersion: 'v1', kind: 'NodeList', items: [this.node], metadata: {} };
    else if (path === '/apis/storage.k8s.io/v1/volumeattachments')
      value = {
        apiVersion: 'storage.k8s.io/v1',
        kind: 'VolumeAttachmentList',
        items: this.attachments,
        metadata: {},
      };
    else if (
      path ===
      `/apis/apps/v1/namespaces/${this.namespace}/${this.controller.kind === 'StatefulSet' ? 'statefulsets' : 'deployments'}/${this.name}`
    ) {
      this.controller.spec.replicas = this.running() ? 1 : 0;
      value = this.controller;
    } else if (path === `/apis/apps/v1/namespaces/${this.namespace}/replicasets/${this.name}-rs`)
      value = {
        kind: 'ReplicaSet',
        metadata: {
          name: `${this.name}-rs`,
          namespace: this.namespace,
          uid: this.replicaSetUid,
          labels: this.serviceLabels,
          ownerReferences: [owner('Deployment', this.name, this.controllerUid)],
        },
      };
    else if (path === `/api/v1/namespaces/${this.namespace}/secrets/${this.secretName}`) {
      if (!request.headers.accept?.includes('as=PartialObjectMetadata')) {
        error(response);
        return;
      }
      value = {
        apiVersion: 'meta.k8s.io/v1',
        kind: 'PartialObjectMetadata',
        metadata: {
          name: this.secretName,
          namespace: this.namespace,
          uid: this.replacedSecret ? randomUUID() : this.secretUid,
          labels: this.serviceLabels,
        },
      };
    } else if (path === `/api/v1/namespaces/${this.namespace}/pods` && request.method === 'POST') {
      await this.onCreate?.(body);
      const pod = globalThis.structuredClone(body);
      pod.metadata.uid = randomUUID();
      pod.metadata.resourceVersion = '1';
      pod.spec.nodeName = 'ozz-node';
      pod.status = {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }],
      };
      this.helpers.set(pod.metadata.name, pod);
      if (this.loseCreate) {
        response.destroy();
        return;
      }
      json(response, pod, 201);
      return;
    } else if (path === `/api/v1/namespaces/${this.namespace}/pods`)
      value = {
        apiVersion: 'v1',
        kind: 'PodList',
        metadata: this.truncatedPods ? { continue: 'remaining' } : {},
        items: [
          ...(this.running() ? [this.pod()] : []),
          ...this.helpers.values(),
          ...this.extraPods,
        ],
      };
    else if (path.startsWith(`/api/v1/namespaces/${this.namespace}/pods/`)) {
      const name = path.split('/').at(-1),
        pod = this.helpers.get(name);
      if (!pod) {
        json(response, { message: 'missing' }, 404);
        return;
      }
      if (request.method === 'DELETE') {
        if (
          body.preconditions?.uid !== pod.metadata.uid ||
          body.preconditions.resourceVersion !== pod.metadata.resourceVersion
        ) {
          error(response);
          return;
        }
        this.helpers.delete(name);
        json(response, { kind: 'Status', status: 'Success' });
        return;
      }
      value = pod;
    } else {
      json(response, { message: 'missing' }, 404);
      return;
    }
    if (this.omitListTypeMeta && value.kind?.endsWith('List'))
      value = {
        ...value,
        items: value.items.map((item) => {
          const copy = { ...item };
          delete copy.kind;
          delete copy.apiVersion;
          return copy;
        }),
      };
    if (this.badListItemType && value.kind === 'PodList' && value.items.length)
      value = {
        ...value,
        items: [{ ...value.items[0], kind: 'ConfigMap' }, ...value.items.slice(1)],
      };
    json(response, value);
  }
  pgProof() {
    return {
      version: '17.11 (synthetic)',
      versionNumber: '170011',
      username: this.username,
      database: this.databaseName,
      transactionStartedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      tableCount: 1,
      schemaSha256: 'a'.repeat(64),
      tables: [
        {
          schema: 'public',
          table: 'markers',
          rowCount: 2,
          rowsSha256: this.badPgData ? 'e'.repeat(64) : 'b'.repeat(64),
          columnsSha256: 'c'.repeat(64),
          constraintsSha256: 'd'.repeat(64),
        },
      ],
    };
  }
  redisProof() {
    return {
      observedAtMs: Date.now(),
      keys: [
        {
          key: 'marker',
          type: 'string',
          valueHex: this.badRedisData ? 'feed' : 'cafe',
          expiresAtMs: -1,
        },
        ...(this.expiry > Date.now()
          ? [{ key: 'expiring', type: 'string', valueHex: 'beef', expiresAtMs: this.expiry }]
          : [{ key: 'expiring', type: 'none', valueHex: false, expiresAtMs: -2 }]),
      ],
    };
  }
  exec(request, socket) {
    const url = new URL(request.url, this.kubeOrigin),
      command = url.searchParams.getAll('command'),
      code = command.at(-1);
    let operation = 'unknown';
    const output = (value) => {
      const bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      if (bytes.length) socket.send(Buffer.concat([Buffer.from([1]), bytes]));
      socket.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"status":"Success"}')]));
    };
    const failure = () =>
      socket.send(
        Buffer.concat([
          Buffer.from([3]),
          Buffer.from('{"status":"Failure","message":"fixture-sensitive-value-must-not-escape"}'),
        ]),
      );
    if (this.nextExec) {
      const handler = this.nextExec;
      this.nextExec = null;
      handler(socket, { url, command, output, failure });
      return;
    }
    let value = '';
    if (code.includes('pg_export_snapshot()')) {
      operation = 'pg-backup';
      value = this.pgBytes;
    } else if (code.includes("sed -n '2p'")) {
      operation = 'pg-backup-metadata';
      value = { snapshot: '00000003-00000002-1', observation: this.pgProof() };
    } else if (code.includes('pg_restore --single-transaction')) operation = 'pg-import';
    else if (code.includes('pg_ctl') && code.includes('-w start')) {
      operation = 'pg-start';
      value = {
        version: '17.11 (synthetic)',
        username: this.username,
        database: this.databaseName,
        objects: this.nonempty ? 1 : 0,
        functions: 0,
      };
    } else if (code.includes('pg_ctl') && code.includes('-w stop')) operation = 'pg-stop';
    else if (code.includes('OZZ_PROBE_SQL')) {
      operation = 'pg-probe';
      value = this.pgProof();
    } else if (code.includes('sha256sum')) {
      operation = 'validate-upload';
      const expected = /\[ "\$\(sha256sum[^\n]+\)" = ([a-f0-9]{64}) \]/.exec(code)?.[1];
      if (!this.uploaded || sha256(this.uploaded) !== expected) {
        failure();
        return;
      }
      value = { integrity: 'passed', engineValidator: 'passed' };
    } else if (code.includes('cat > /tmp/ozz-manual-')) operation = 'upload';
    else if (code.includes('redis -n ') && code.includes(' EVAL ')) {
      operation = 'redis-probe';
      value = this.redisProof();
    } else if (code.includes("printf '__SERVER__")) {
      operation = 'redis-status';
      value = `__SERVER__\nredis_version:7.4.11\n__PERSISTENCE__\nloading:0\naof_enabled:${this.aof ? 1 : 0}\naof_last_write_status:ok\naof_last_bgrewrite_status:ok\naof_rewrite_in_progress:0\naof_rewrite_scheduled:0\n__APPENDONLY__\nappendonly\n${this.aof ? 'yes' : 'no'}\n__APPENDFSYNC__\nappendfsync\neverysec\n`;
    } else if (code.includes('redis --rdb')) {
      operation = 'redis-backup';
      value = this.rdbBytes;
    } else if (code.includes('allDatabasesEmpty')) {
      operation = 'redis-start-empty';
      value = { allDatabasesEmpty: !this.nonempty };
    } else if (code.includes('rdbLoadedWithAofDisabled')) {
      operation = 'redis-load-rdb';
      this.aof = false;
      value = { rdbLoadedWithAofDisabled: true };
    } else if (code.includes('redis CONFIG SET appendonly yes')) {
      operation = 'redis-enable-aof';
      this.aof = true;
      value = { aofEnabled: true, appendfsync: 'everysec', rewrite: 'ok', lastWrite: 'ok' };
    } else if (code.includes('redis SHUTDOWN NOSAVE')) operation = 'redis-stop';
    else if (code.includes('mv -T --')) operation = 'redis-preserve-empty';
    else if (code.includes('tar --version')) {
      operation = 'files-version';
      value = 'tar (GNU tar) 1.34\n';
    } else if (code.includes('tar --format=ustar')) {
      operation = 'files-archive';
      value = this.tarBytes;
    } else if (code.includes('tar --extract')) operation = 'files-import';
    this.commands.push({ operation, command, pod: url.pathname.split('/').at(-2) });
    this.onCommand?.(operation);
    if (this.failOperation === operation || operation === 'unknown') {
      failure();
      return;
    }
    if (operation === 'upload') {
      const chunks = [];
      socket.on('message', (bytes) => {
        if (bytes[0] === 0) chunks.push(bytes.subarray(1));
        else if (bytes[0] === 255 && bytes[1] === 0) {
          this.uploaded = Buffer.concat(chunks);
          output('');
        } else failure();
      });
    } else output(value);
  }
}
