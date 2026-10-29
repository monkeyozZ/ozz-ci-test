import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKubeconfig } from '../../packages/infrastructure/dist/kubernetes.js';
import type {
  ManagedNetworkResource,
  NetworkDomainPlan,
  NetworkResourceDescriptor,
  NetworkResourceReceipt,
  NetworkWriteHooks,
  NetworkWriteIntent,
} from '../../packages/infrastructure/dist/networking.js';

export interface Resource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    generation?: number;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}
export const key = (row: Pick<NetworkResourceDescriptor, 'kind' | 'namespace' | 'name'>) =>
  `${row.kind}/${row.namespace}/${row.name}`;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
function failure(response: ServerResponse, code: number) {
  json(
    response,
    { kind: 'Status', apiVersion: 'v1', code, message: 'fixture-private-response-marker' },
    code,
  );
}

const plurals: Record<string, string> = {
  namespaces: 'Namespace',
  secrets: 'Secret',
  services: 'Service',
  serviceaccounts: 'ServiceAccount',
  deployments: 'Deployment',
  ingresses: 'Ingress',
  ingressclasses: 'IngressClass',
  certificates: 'Certificate',
  issuers: 'Issuer',
  middlewares: 'Middleware',
  customresourcedefinitions: 'CustomResourceDefinition',
  clusterroles: 'ClusterRole',
  clusterrolebindings: 'ClusterRoleBinding',
  roles: 'Role',
  rolebindings: 'RoleBinding',
  mutatingwebhookconfigurations: 'MutatingWebhookConfiguration',
  validatingwebhookconfigurations: 'ValidatingWebhookConfiguration',
};
export class NetworkingFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'ozz-networking-'));
  readonly kubeSystemUid = randomUUID();
  readonly token = `networking-fixture-${randomUUID()}`;
  readonly resources = new Map<string, Resource>();
  readonly requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  readonly sockets = new Set<Socket>();
  readonly ca: string;
  private readonly cert: string;
  private readonly privateKey: string;
  private readonly leaf: string;
  private version = 1;
  endpoint = '';
  server!: Server;
  autoCertificate = true;
  readyBackend = true;
  endpointOwnerOverride: string | null = null;
  lostCreateKind: string | null = null;
  rejectedWrite: { kind: string; status: number } | null = null;
  beforeWrite?: (resource: Resource, method: string) => void;
  permissionAllowed = true;
  unreadyDeploymentReads = 0;
  constructor(certManager = true) {
    const openssl = (args: string[]) =>
      execFileSync('openssl', args, { cwd: this.directory, stdio: 'ignore' });
    openssl([
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
      '/CN=networking-fixture-ca',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'tls.key',
      '-out',
      'tls.csr',
      '-subj',
      '/CN=networking-fixture',
    ]);
    writeFileSync(
      join(this.directory, 'server.ext'),
      'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:network.example.test\nextendedKeyUsage=serverAuth\n',
      { mode: 0o600 },
    );
    openssl([
      'x509',
      '-req',
      '-in',
      'tls.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'tls.pem',
      '-days',
      '1',
      '-extfile',
      'server.ext',
    ]);
    this.ca = readFileSync(join(this.directory, 'ca.pem'), 'utf8');
    this.cert = readFileSync(join(this.directory, 'tls.pem'), 'utf8');
    this.leaf = this.cert;
    this.privateKey = readFileSync(join(this.directory, 'tls.key'), 'utf8');
    this.seed({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'kube-system', uid: this.kubeSystemUid },
    });
    this.seed({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'IngressClass',
      metadata: { name: 'traefik' },
      spec: { controller: 'traefik.io/ingress-controller' },
    });
    this.seed({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'middlewares.traefik.io' },
      spec: { versions: [{ name: 'v1alpha1', served: true }] },
    });
    if (certManager) {
      for (const name of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook'])
        this.seed({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name, namespace: 'cert-manager' },
          spec: {
            replicas: 1,
            template: {
              spec: {
                containers: [
                  {
                    name,
                    image: `quay.io/jetstack/${name === 'cert-manager' ? 'cert-manager-controller' : name}:v1.21.3`,
                  },
                ],
              },
            },
          },
        });
      for (const name of [
        'certificates.cert-manager.io',
        'issuers.cert-manager.io',
        'challenges.acme.cert-manager.io',
        'orders.acme.cert-manager.io',
        'certificaterequests.cert-manager.io',
        'clusterissuers.cert-manager.io',
      ])
        this.seed({
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name },
          spec: { versions: [{ name: 'v1', served: true }] },
        });
    }
  }
  async start() {
    this.server = createServer({ key: this.privateKey, cert: this.cert }, (request, response) => {
      void this.handle(request, response).catch(() => failure(response, 500));
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.directory, { recursive: true, force: true });
  }
  connection() {
    return parseKubeconfig(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Config',
        clusters: [
          {
            name: 'test',
            cluster: {
              server: this.endpoint,
              'certificate-authority-data': Buffer.from(this.ca).toString('base64'),
            },
          },
        ],
        users: [{ name: 'test', user: { token: this.token } }],
        contexts: [{ name: 'test', context: { cluster: 'test', user: 'test' } }],
        'current-context': 'test',
      }),
    );
  }
  plan(): NetworkDomainPlan {
    const environmentId = randomUUID();
    const serviceId = randomUUID();
    const target: NetworkDomainPlan['target'] = {
      installationId: randomUUID(),
      clusterId: randomUUID(),
      kubeSystemUid: this.kubeSystemUid,
      caFingerprint: this.connection().caFingerprint,
      projectId: randomUUID(),
      environmentId,
      serviceId,
      namespace: `ozz-e-${environmentId.replaceAll('-', '')}`,
      serviceName: `ozz-s-${serviceId.replaceAll('-', '')}`,
      serviceUid: randomUUID(),
      domainId: randomUUID(),
      hostname: 'network.example.test',
      portId: randomUUID(),
      portName: 'http',
    };
    this.seed({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: target.serviceName,
        namespace: target.namespace,
        uid: target.serviceUid,
        labels: {
          'app.kubernetes.io/managed-by': 'ozz',
          'ozz.dev/installation-id': target.installationId,
          'ozz.dev/cluster-id': target.clusterId,
          'ozz.dev/project-id': target.projectId,
          'ozz.dev/environment-id': environmentId,
          'ozz.dev/service-id': serviceId,
        },
      },
      spec: { ports: [{ name: 'http', protocol: 'TCP', port: 80, targetPort: 8080 }] },
    });
    return {
      target,
      revision: 1,
      platformRevision: 1,
      taskId: randomUUID(),
      acmeEmail: 'fixture@example.test',
      certificateEnvironment: 'staging',
      reconcileMissing: false,
      inventory: [],
    };
  }
  seed(resource: Resource): Resource {
    resource.metadata.uid ??= randomUUID();
    resource.metadata.resourceVersion = String(++this.version);
    resource.metadata.generation ??= 1;
    if (resource.kind === 'Deployment')
      resource.status = {
        observedGeneration: resource.metadata.generation,
        readyReplicas: 1,
        availableReplicas: 1,
      };
    if (resource.kind === 'CustomResourceDefinition')
      resource.status = { conditions: [{ type: 'Established', status: 'True' }] };
    if (resource.kind === 'Ingress')
      resource.status = { loadBalancer: { ingress: [{ ip: '192.0.2.1' }] } };
    this.resources.set(
      `${resource.kind}/${resource.metadata.namespace ?? ''}/${resource.metadata.name}`,
      resource,
    );
    return resource;
  }
  writes() {
    return this.requests.filter(
      (request) =>
        ['POST', 'PUT', 'DELETE'].includes(request.method) &&
        !request.path.includes('selfsubjectaccessreviews'),
    );
  }
  private reconcileCertificate(resource: Resource) {
    if (resource.kind !== 'Certificate' || !this.autoCertificate) return;
    const secretTemplate = object(resource.spec?.secretTemplate);
    const secretName = String(resource.spec?.secretName);
    const old = this.resources.get(`Secret/${resource.metadata.namespace}/${secretName}`);
    this.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace: resource.metadata.namespace,
        uid: old?.metadata.uid,
        labels: structuredClone(object(secretTemplate.labels)) as Record<string, string>,
        annotations: {
          ...(structuredClone(object(secretTemplate.annotations)) as Record<string, string>),
          'cert-manager.io/certificate-name': resource.metadata.name,
          'cert-manager.io/issuer-name': String(object(resource.spec?.issuerRef).name),
          'cert-manager.io/issuer-kind': 'Issuer',
          'cert-manager.io/issuer-group': 'cert-manager.io',
        },
      },
      type: 'kubernetes.io/tls',
      data: {
        'tls.crt': Buffer.from(this.leaf).toString('base64'),
        'tls.key': Buffer.from(this.privateKey).toString('base64'),
      },
    });
    const leaf = new X509Certificate(this.leaf);
    resource.status = {
      notBefore: leaf.validFromDate.toISOString(),
      notAfter: leaf.validToDate.toISOString(),
      renewalTime: new Date(Date.parse(leaf.validTo) - 3600000).toISOString(),
      conditions: [
        { type: 'Ready', status: 'True', observedGeneration: resource.metadata.generation },
      ],
    };
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const url = new URL(request.url!, this.endpoint);
    const method = request.method!;
    this.requests.push({ method, path: url.pathname, body });
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      failure(response, 401);
      return;
    }
    if (url.pathname === '/version') {
      json(response, { major: '1', minor: '35', gitVersion: 'v1.35.9+k3s1' });
      return;
    }
    if (url.pathname.endsWith('/selfsubjectaccessreviews')) {
      json(response, { ...body, status: { allowed: this.permissionAllowed } });
      return;
    }
    const api = /^\/api\/v1\/(.+)$/u.exec(url.pathname);
    const custom = /^\/apis\/([^/]+)\/([^/]+)\/(.+)$/u.exec(url.pathname);
    if (!api && !custom) {
      failure(response, 404);
      return;
    }
    const tail = (api?.[1] ?? custom![3]!).split('/');
    const namespaced = tail[0] === 'namespaces' && tail.length >= 3;
    const namespace = namespaced ? tail[1]! : '';
    const plural = tail[namespaced ? 2 : 0]!;
    const name = tail[namespaced ? 3 : 1];
    if (plural === 'endpointslices') {
      const serviceName = (url.searchParams.get('labelSelector') ?? '').split('=')[1];
      const service = this.resources.get(`Service/${namespace}/${serviceName}`);
      json(response, {
        apiVersion: 'discovery.k8s.io/v1',
        kind: 'EndpointSliceList',
        metadata: {},
        items: service
          ? [
              {
                metadata: {
                  namespace,
                  name: 'fixture-endpoints',
                  labels: { 'kubernetes.io/service-name': serviceName },
                  ownerReferences: [
                    {
                      apiVersion: 'v1',
                      kind: 'Service',
                      name: serviceName,
                      uid: this.endpointOwnerOverride ?? service.metadata.uid,
                    },
                  ],
                },
                ports: [{ name: 'http', protocol: 'TCP', port: 8080 }],
                endpoints: [{ addresses: ['192.0.2.5'], conditions: { ready: this.readyBackend } }],
              },
            ]
          : [],
      });
      return;
    }
    const diagnostics: Record<string, string> = {
      certificaterequests: 'CertificateRequest',
      orders: 'Order',
      challenges: 'Challenge',
    };
    if (diagnostics[plural]) {
      json(response, {
        apiVersion: `${custom![1]}/v1`,
        kind: `${diagnostics[plural]}List`,
        metadata: {},
        items: [...this.resources.values()].filter(
          (resource) =>
            resource.kind === diagnostics[plural] && resource.metadata.namespace === namespace,
        ),
      });
      return;
    }
    const kind = plurals[plural];
    const identity = `${kind}/${namespace}/${name ?? object(body?.metadata).name}`;
    const current = this.resources.get(identity);
    if (method === 'GET') {
      if (current && kind === 'Deployment' && this.unreadyDeploymentReads > 0) {
        this.unreadyDeploymentReads--;
        json(response, {
          ...current,
          status: {
            observedGeneration: current.metadata.generation,
            readyReplicas: 0,
            availableReplicas: 0,
          },
        });
      } else if (current) json(response, current);
      else failure(response, 404);
      return;
    }
    if (this.rejectedWrite?.kind === kind) {
      const status = this.rejectedWrite.status;
      this.rejectedWrite = null;
      failure(response, status);
      return;
    }
    if (method === 'DELETE') {
      if (!current) {
        failure(response, 404);
        return;
      }
      const preconditions = object(body?.preconditions);
      if (
        preconditions.uid !== current.metadata.uid ||
        preconditions.resourceVersion !== current.metadata.resourceVersion
      ) {
        failure(response, 409);
        return;
      }
      this.resources.delete(identity);
      json(response, { apiVersion: 'v1', kind: 'Status', status: 'Success' });
      return;
    }
    if (
      (method === 'POST' && current) ||
      (method === 'PUT' &&
        (!current ||
          object(body?.metadata).uid !== current.metadata.uid ||
          object(body?.metadata).resourceVersion !== current.metadata.resourceVersion))
    ) {
      failure(response, 409);
      return;
    }
    const resource = body as unknown as Resource;
    this.beforeWrite?.(resource, method);
    if (method === 'PUT') resource.metadata.generation = (current?.metadata.generation ?? 0) + 1;
    this.seed(resource);
    this.reconcileCertificate(resource);
    if (this.lostCreateKind === kind) {
      this.lostCreateKind = null;
      response.destroy();
      return;
    }
    json(response, resource, method === 'POST' ? 201 : 200);
  }
}

export function journal() {
  const rows = new Map<string, ManagedNetworkResource>();
  const deleted = new Set<string>();
  const intents: NetworkWriteIntent[] = [];
  const receipts: NetworkResourceReceipt[] = [];
  const state = {
    failReceiptKind: null as string | null,
    failDeleteReceipt: false,
    failCheckpoint: false,
  };
  const hooks: NetworkWriteHooks = {
    async checkpoint() {
      if (state.failCheckpoint) throw new Error('fixture-hook-secret');
    },
    async reserve(row) {
      let current = rows.get(key(row));
      if (!current || deleted.has(key(row))) {
        current = {
          ...row,
          ledgerVersion: (current?.ledgerVersion ?? 0) + 1,
          creationNonce: randomUUID(),
          creationAttempted: false,
          uid: null,
          resourceVersion: null,
          revision: 0,
          specFingerprint: null,
        };
        rows.set(key(row), current);
        deleted.delete(key(row));
      }
      return structuredClone(current);
    },
    async beforeWrite(intent) {
      const row = rows.get(key(intent));
      if (
        !row ||
        row.uid !== intent.expectedUid ||
        row.creationNonce !== intent.creationNonce ||
        intent.revision < row.revision ||
        (intent.action !== 'create' && !intent.expectedResourceVersion)
      )
        throw new Error('Invalid write fence');
      row.creationAttempted ||= intent.action === 'create';
      row.ledgerVersion++;
      intents.push(structuredClone(intent));
    },
    async onReceipt(receipt) {
      if (
        state.failReceiptKind === receipt.kind ||
        (state.failDeleteReceipt && receipt.action === 'deleted')
      ) {
        state.failReceiptKind = null;
        state.failDeleteReceipt = false;
        throw new Error('fixture-receipt-secret');
      }
      const row = rows.get(key(receipt));
      if (
        !row ||
        row.creationNonce !== receipt.creationNonce ||
        (row.uid && row.uid !== receipt.uid) ||
        (!row.creationAttempted && receipt.action !== 'deleted')
      )
        throw new Error('Invalid receipt');
      Object.assign(row, {
        uid: receipt.uid,
        resourceVersion: receipt.resourceVersion,
        revision: receipt.revision,
        specFingerprint: receipt.specFingerprint,
        ledgerVersion: row.ledgerVersion + 1,
      });
      if (receipt.action === 'deleted') deleted.add(key(receipt));
      receipts.push(structuredClone(receipt));
    },
  };
  return {
    hooks,
    state,
    rows,
    intents,
    receipts,
    get inventory() {
      return [...rows].filter(([id]) => !deleted.has(id)).map(([, row]) => structuredClone(row));
    },
  };
}
