import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KubernetesAdapter,
  KubernetesAdapterError,
  parseKubeconfig,
} from '../../packages/infrastructure/dist/kubernetes.js';

interface Pki {
  ca: string;
  server: string;
  serverKey: string;
  badSanServer: string;
  badSanKey: string;
  client: string;
  clientKey: string;
}

const directory = mkdtempSync(join(tmpdir(), 'ozz-kubernetes-protocol-'));
const fixtures: Fixture[] = [];
let alpha: Pki;
let beta: Pki;

function openssl(args: string[]): void {
  execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
}

function pki(label: string): Pki {
  const file = (name: string) => join(directory, `${label}-${name}`);
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.pem'),
    '-days',
    '2',
    '-subj',
    `/CN=ozz-test-${label}-ca`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  const issue = (name: string, extensions: string) => {
    writeFileSync(file(`${name}.ext`), extensions, { mode: 0o600 });
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file(`${name}.key`),
      '-out',
      file(`${name}.csr`),
      '-subj',
      `/CN=ozz-test-${name}`,
    ]);
    openssl([
      'x509',
      '-req',
      '-in',
      file(`${name}.csr`),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca.key'),
      '-CAcreateserial',
      '-out',
      file(`${name}.pem`),
      '-days',
      '1',
      '-extfile',
      file(`${name}.ext`),
    ]);
    chmodSync(file(`${name}.key`), 0o600);
  };
  issue(
    'server',
    'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n',
  );
  issue(
    'bad-san',
    'basicConstraints=CA:FALSE\nsubjectAltName=DNS:not-this-host.invalid\nextendedKeyUsage=serverAuth\n',
  );
  issue('client', 'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n');
  const read = (name: string) => readFileSync(file(name), 'utf8');
  return {
    ca: read('ca.pem'),
    server: read('server.pem'),
    serverKey: read('server.key'),
    badSanServer: read('bad-san.pem'),
    badSanKey: read('bad-san.key'),
    client: read('client.pem'),
    clientKey: read('client.key'),
  };
}

interface Fixture {
  endpoint: string;
  server: Server;
  sockets: Set<Socket>;
  paths: string[];
  acceptedToken: string;
  versionFault: number | 'slow' | 'large' | 'redirect' | null;
  redirectTo: string;
  metricsStatus: number;
  permissionsStatus: number;
  pagination: 'none' | 'valid' | 'repeat' | 'inconsistent';
  metricUid: string | undefined;
  metricTimestamp: string | undefined;
  cpu: string;
  metricCpu: string;
  capabilitiesStatus: number;
  traefikObservedGeneration: number;
  workloadStatus: number;
  workloadItems: number;
}

async function fixture(
  material: Pki,
  label: string,
  auth: 'token' | 'certificate' = 'token',
  badSan = false,
): Promise<Fixture> {
  const state = {
    endpoint: '',
    paths: [],
    sockets: new Set<Socket>(),
    acceptedToken: `synthetic-token-${label}`,
    versionFault: null,
    redirectTo: '',
    metricsStatus: 200,
    permissionsStatus: 201,
    pagination: 'none',
    metricUid: undefined,
    metricTimestamp: undefined,
    cpu: '2',
    metricCpu: '125000000n',
    capabilitiesStatus: 404,
    traefikObservedGeneration: 1,
    workloadStatus: 404,
    workloadItems: 0,
  } as unknown as Fixture;
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  state.server = createServer(
    {
      key: badSan ? material.badSanKey : material.serverKey,
      cert: badSan ? material.badSanServer : material.server,
      ca: material.ca,
      requestCert: auth === 'certificate',
      rejectUnauthorized: auth === 'certificate',
    },
    (request, response) => {
      const url = new URL(request.url!, state.endpoint);
      state.paths.push(url.pathname);
      if (auth === 'token' && request.headers.authorization !== `Bearer ${state.acceptedToken}`) {
        json(response, { message: 'synthetic-secret-never-forwarded' }, 401);
        return;
      }
      if (url.pathname === '/version') {
        if (state.versionFault === 'slow') return;
        if (state.versionFault === 'redirect') {
          response.writeHead(302, { Location: state.redirectTo });
          response.end();
          return;
        }
        if (typeof state.versionFault === 'number') {
          response.setHeader('Retry-After', '7200');
          json(response, { message: 'synthetic-secret-never-forwarded' }, state.versionFault);
          return;
        }
        json(response, {
          gitVersion: state.versionFault === 'large' ? 'v'.repeat(32 * 1024) : 'v1.35.9+k3s1',
        });
      } else if (url.pathname === '/api/v1/namespaces/kube-system') {
        json(response, {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: { name: 'kube-system', uid: `${label}-cluster-uid` },
        });
      } else if (url.pathname === '/api/v1/nodes') {
        const second = url.searchParams.has('continue');
        const suffix = second && state.pagination !== 'repeat' ? '-2' : '';
        json(response, {
          apiVersion: 'v1',
          kind: 'NodeList',
          metadata: {
            resourceVersion: second && state.pagination === 'inconsistent' ? '43' : '42',
            continue:
              state.pagination === 'repeat' || (state.pagination !== 'none' && !second)
                ? 'next'
                : '',
          },
          items: [
            {
              metadata: {
                uid: `${label}-node-uid${suffix}`,
                name: `same-node${suffix}`,
                resourceVersion: '42',
                creationTimestamp: new Date(Date.now() - 86400_000).toISOString(),
                labels: { 'node-role.kubernetes.io/control-plane': 'true' },
              },
              status: {
                nodeInfo: {
                  architecture: 'arm64',
                  operatingSystem: 'linux',
                  osImage: 'Ubuntu 24.04',
                  kubeletVersion: 'v1.35.9+k3s1',
                },
                capacity: {
                  cpu: state.cpu,
                  memory: '8Gi',
                  'ephemeral-storage': '20Gi',
                  pods: '110',
                },
                allocatable: { cpu: '1900m', memory: '7Gi' },
                conditions: [
                  { type: 'Ready', status: 'True' },
                  { type: 'DiskPressure', status: 'False' },
                ],
                addresses: [{ type: 'InternalIP', address: '10.0.0.2' }],
              },
            },
          ],
        });
      } else if (url.pathname === '/apis/metrics.k8s.io/v1beta1/nodes') {
        json(
          response,
          {
            kind: 'NodeMetricsList',
            metadata: {},
            items: [
              {
                metadata: { name: 'same-node', uid: state.metricUid },
                timestamp: state.metricTimestamp ?? new Date().toISOString(),
                window: '30s',
                usage: { cpu: state.metricCpu, memory: '128Mi' },
              },
            ],
          },
          state.metricsStatus,
        );
      } else if (url.pathname === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews') {
        request.resume();
        json(
          response,
          { kind: 'SelfSubjectAccessReview', status: { allowed: true } },
          state.permissionsStatus,
        );
      } else if (url.pathname === '/apis/networking.k8s.io/v1/ingressclasses') {
        json(
          response,
          {
            kind: 'IngressClassList',
            metadata: {},
            items: [
              {
                metadata: {
                  name: 'traefik',
                  annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
                },
                spec: { controller: 'traefik.io/ingress-controller' },
              },
            ],
          },
          state.capabilitiesStatus,
        );
      } else if (url.pathname === '/apis/storage.k8s.io/v1/storageclasses') {
        json(
          response,
          {
            kind: 'StorageClassList',
            metadata: {},
            items: [
              {
                metadata: {
                  name: 'local-path',
                  annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
                },
                provisioner: 'rancher.io/local-path',
                volumeBindingMode: 'WaitForFirstConsumer',
                reclaimPolicy: 'Delete',
              },
            ],
          },
          state.capabilitiesStatus,
        );
      } else if (url.pathname === '/apis/apps/v1/namespaces/kube-system/deployments/traefik') {
        json(
          response,
          {
            kind: 'Deployment',
            metadata: { name: 'traefik', namespace: 'kube-system', generation: 2 },
            spec: { replicas: 1 },
            status: {
              observedGeneration: state.traefikObservedGeneration,
              readyReplicas: 1,
              availableReplicas: 1,
            },
          },
          state.capabilitiesStatus,
        );
      } else if (
        [
          '/apis/apps/v1/deployments',
          '/apis/apps/v1/statefulsets',
          '/apis/apps/v1/daemonsets',
          '/apis/batch/v1/jobs',
          '/apis/batch/v1/cronjobs',
          '/api/v1/pods',
        ].includes(url.pathname)
      ) {
        json(
          response,
          {
            metadata: { resourceVersion: '42' },
            items: Array.from({ length: state.workloadItems }, (_, index) => ({
              metadata: {
                name: `workload-${index}`,
                namespace: 'test-namespace',
                uid: `workload-${index}-uid`,
                generation: 2,
                labels: { 'app.kubernetes.io/managed-by': 'ozz' },
              },
              spec: {
                replicas: 1,
                schedule: '0 0 * * *',
                suspend: false,
                containers: [
                  {
                    name: 'private',
                    image: 'fixture',
                    env: [{ name: 'SECRET', value: 'synthetic-workload-secret' }],
                  },
                ],
              },
              status: {
                phase: 'Running',
                readyReplicas: 1,
                observedGeneration: 2,
                desiredNumberScheduled: 1,
                numberReady: 1,
                conditions: [
                  { type: 'Ready', status: 'True' },
                  { type: 'Complete', status: 'True' },
                ],
              },
            })),
          },
          state.workloadStatus,
        );
      } else json(response, {}, 404);
    },
  );
  state.server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    state.server.once('error', reject);
    state.server.listen(0, '127.0.0.1', resolve);
  });
  state.endpoint = `https://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  fixtures.push(state);
  return state;
}

function configuration(endpoint: string, material: Pki, token?: string) {
  const b64 = (value: string) => Buffer.from(value).toString('base64');
  return {
    apiVersion: 'v1',
    kind: 'Config',
    preferences: {},
    clusters: [
      {
        name: 'same-cluster',
        cluster: { server: endpoint, 'certificate-authority-data': b64(material.ca) } as Record<
          string,
          unknown
        >,
      },
    ],
    users: [
      {
        name: 'same-user',
        user: (token
          ? { token }
          : {
              'client-certificate-data': b64(material.client),
              'client-key-data': b64(material.clientKey),
            }) as Record<string, unknown>,
      },
    ],
    contexts: [{ name: 'same-context', context: { cluster: 'same-cluster', user: 'same-user' } }],
    'current-context': 'same-context',
  };
}

const connection = (target: Fixture, material: Pki, token = target.acceptedToken) =>
  parseKubeconfig(JSON.stringify(configuration(target.endpoint, material, token)));

beforeAll(() => {
  alpha = pki('alpha');
  beta = pki('beta');
}, 30_000);
afterAll(async () => {
  for (const target of fixtures) {
    for (const socket of target.sockets) socket.destroy();
    await new Promise<void>((resolve) => target.server.close(() => resolve()));
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('Kubernetes credential and real HTTPS protocol boundaries', () => {
  it('accepts embedded certificates or tokens and keeps secrets out of serializable connections', async () => {
    const target = await fixture(alpha, 'cert', 'certificate');
    const raw = JSON.stringify(configuration(target.endpoint, alpha));
    const parsed = parseKubeconfig(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.credential.authentication).toBe('client_certificate');
    expect(parsed.credential.expiresAt).toMatch(/^\d{4}-/u);
    expect(JSON.stringify(parsed)).not.toContain('BEGIN');
    expect(JSON.stringify(parsed)).not.toContain(Buffer.from(alpha.clientKey).toString('base64'));
    const observed = await new KubernetesAdapter().inspect(parsed);
    expect(observed.identity.kubeSystemUid).toBe('cert-cluster-uid');
    expect(observed.secretsEncryption.state).toBe('unknown');
    expect(observed.permissions.clusterWideAdmin).toBe(true);
  });

  it('rejects executable, file, impersonation, proxy and insecure configuration even in unused entries', () => {
    for (const field of [
      'exec',
      'auth-provider',
      'tokenFile',
      'client-key',
      'client-certificate',
      'username',
      'password',
      'as',
      'as-groups',
    ]) {
      const config = configuration('https://127.0.0.1:16443', alpha, 'synthetic-token');
      config.users.push({
        name: 'unused',
        user: { token: 'synthetic-token', [field]: 'synthetic-secret' },
      });
      expect(() => parseKubeconfig(JSON.stringify(config))).toThrow(KubernetesAdapterError);
    }
    for (const field of [
      'certificate-authority',
      'proxy-url',
      'tls-server-name',
      'insecure-skip-tls-verify',
    ]) {
      const config = configuration('https://127.0.0.1:16443', alpha, 'synthetic-token');
      config.clusters[0]!.cluster[field] =
        field === 'insecure-skip-tls-verify' ? true : 'synthetic-secret';
      expect(() => parseKubeconfig(JSON.stringify(config))).toThrow(KubernetesAdapterError);
    }
    for (const endpoint of [
      'http://127.0.0.1',
      'https://user:synthetic-secret@example.test',
      'https://example.test/private',
      'https://example.test?token=synthetic-secret',
    ])
      expect(() =>
        parseKubeconfig(JSON.stringify(configuration(endpoint, alpha, 'synthetic-token'))),
      ).toThrow(KubernetesAdapterError);
  });

  it('rejects malformed YAML, aliases, duplicate keys, extra documents and mismatched keys without echoing input', () => {
    for (const raw of [
      'apiVersion: v1\napiVersion: v2\nsynthetic-secret: x',
      'value: &alias synthetic-secret\nnext: *alias',
      '!!js/function synthetic-secret',
      '---\nvalue: synthetic-secret\n---\nvalue: x',
      ' '.repeat(256 * 1024 + 1),
    ]) {
      let failure: unknown;
      try {
        parseKubeconfig(raw);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KubernetesAdapterError);
      expect(String(failure)).not.toContain('synthetic-secret');
    }
    const config = configuration('https://127.0.0.1:16443', alpha);
    config.users[0]!.user['client-key-data'] = Buffer.from(beta.clientKey).toString('base64');
    expect(() => parseKubeconfig(JSON.stringify(config))).toThrow(KubernetesAdapterError);
  });

  it('rejects expired and not-yet-valid credentials before connecting', async () => {
    const parsed = parseKubeconfig(JSON.stringify(configuration('https://127.0.0.1:1', alpha)));
    await expect(
      new KubernetesAdapter({ now: () => new Date('2100-01-01') }).inspect(parsed),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CREDENTIAL_EXPIRED' });
    await expect(
      new KubernetesAdapter({ now: () => new Date('2000-01-01') }).inspect(parsed),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CREDENTIAL_NOT_YET_VALID' });
  });

  it('treats decoded token times as metadata and lets the API authenticate a token despite local clock skew', async () => {
    const target = await fixture(alpha, 'token-clock');
    target.acceptedToken = [
      Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ nbf: 4102444800, exp: 4133980800 })).toString('base64url'),
      'synthetic-signature',
    ].join('.');
    const parsed = connection(target, alpha);
    expect(parsed.credential.expirationSource).toBe('token_claim');
    expect(parsed.credential.notBefore).toBe('2100-01-01T00:00:00.000Z');
    const observed = await new KubernetesAdapter().inspect(parsed);
    expect(observed.identity.kubeSystemUid).toBe('token-clock-cluster-uid');
  });

  it('isolates two live TLS endpoints with the same user and Node name, and reports actual usage separately', async () => {
    const [a, b] = await Promise.all([fixture(alpha, 'a'), fixture(beta, 'b')]);
    const adapter = new KubernetesAdapter();
    const [first, second] = await Promise.all([
      adapter.inspect(connection(a, alpha)),
      adapter.inspect(connection(b, beta)),
    ]);
    expect(first.nodes[0]!.name).toBe(second.nodes[0]!.name);
    expect(first.nodes[0]!.uid).not.toBe(second.nodes[0]!.uid);
    expect(first.identity.caFingerprint).not.toBe(second.identity.caFingerprint);
    expect(first.nodes[0]!.capacity.cpuCores).toBe(2);
    expect(first.nodes[0]!.allocatable.cpuCores).toBeCloseTo(1.9, 9);
    expect(first.nodes[0]!.metrics.cpuCores).toBe(0.125);
    expect(first.nodes[0]!.metrics.memoryBytes).toBe(128 * 1024 ** 2);
    expect(first.nodes[0]!.capacity.ephemeralStorageBytes).toBe(20 * 1024 ** 3);
    expect(first.nodes[0]!.conditions.diskPressure).toBe('false');
    await delay(75);
    expect(a.sockets.size + b.sockets.size).toBe(0);
  });

  it('requires a matching trust chain and the endpoint SAN, including explicit endpoint replacement', async () => {
    const target = await fixture(alpha, 'tls');
    const wrongCa = parseKubeconfig(
      JSON.stringify(configuration(target.endpoint, beta, target.acceptedToken)),
    );
    await expect(new KubernetesAdapter().inspect(wrongCa)).rejects.toMatchObject({
      code: 'KUBERNETES_TLS_INVALID',
    });
    const badSan = await fixture(alpha, 'bad-san', 'token', true);
    const override = parseKubeconfig(
      JSON.stringify(configuration(target.endpoint, alpha, badSan.acceptedToken)),
      { endpointOverride: badSan.endpoint },
    );
    await expect(new KubernetesAdapter().inspect(override)).rejects.toMatchObject({
      code: 'KUBERNETES_TLS_INVALID',
    });
    expect(badSan.paths).toHaveLength(0);
  });

  it('pins CA and cluster UID and refuses a different target before reading its nodes', async () => {
    const target = await fixture(alpha, 'pinned');
    const parsed = connection(target, alpha);
    const adapter = new KubernetesAdapter();
    await expect(
      adapter.inspect(parsed, {
        expectedIdentity: { kubeSystemUid: 'pinned-cluster-uid', caFingerprint: 'SHA256:wrong' },
      }),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CA_MISMATCH' });
    expect(target.paths).toHaveLength(0);
    await expect(
      adapter.inspect(parsed, {
        expectedIdentity: {
          kubeSystemUid: 'other-cluster-uid',
          caFingerprint: parsed.caFingerprint,
        },
      }),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CLUSTER_IDENTITY_MISMATCH' });
    expect(target.paths).not.toContain('/api/v1/nodes');
  });

  it('uses replacement credentials immediately and never reuses the old token under the same user name', async () => {
    const target = await fixture(alpha, 'rotation');
    const adapter = new KubernetesAdapter();
    const oldConnection = connection(target, alpha);
    const initial = await adapter.inspect(oldConnection);
    target.acceptedToken = 'synthetic-replacement-token';
    await expect(adapter.inspect(oldConnection)).rejects.toMatchObject({
      code: 'KUBERNETES_UNAUTHENTICATED',
    });
    const fresh = await adapter.inspect(connection(target, alpha), {
      expectedIdentity: initial.identity,
    });
    expect(fresh.identity).toEqual(initial.identity);
    expect(JSON.stringify(fresh)).not.toContain(target.acceptedToken);
  });

  it('reports unavailable metrics and unknown permissions without fabricating zero usage', async () => {
    const target = await fixture(alpha, 'missing-metrics');
    target.metricsStatus = 404;
    target.permissionsStatus = 403;
    const observed = await new KubernetesAdapter().inspect(connection(target, alpha));
    expect(observed.metrics).toMatchObject({
      state: 'unavailable',
      errorCode: 'KUBERNETES_API_NOT_FOUND',
    });
    expect(observed.nodes[0]!.metrics).toMatchObject({
      state: 'unknown',
      cpuCores: null,
      memoryBytes: null,
    });
    expect(observed.permissions.clusterWideAdmin).toBeNull();
    expect(observed.permissions.checks.find((check) => check.resource === 'nodes')?.allowed).toBe(
      true,
    );
  });

  it('classifies 429, 410 and permission failures with bounded retry hints and safe errors', async () => {
    const target = await fixture(alpha, 'status');
    const adapter = new KubernetesAdapter();
    for (const [status, code, retryable] of [
      [429, 'KUBERNETES_RATE_LIMITED', true],
      [410, 'KUBERNETES_RESOURCE_VERSION_EXPIRED', true],
      [403, 'KUBERNETES_FORBIDDEN', false],
      [503, 'KUBERNETES_API_UNAVAILABLE', true],
    ] as const) {
      target.versionFault = status;
      let failure: unknown;
      try {
        await adapter.inspect(connection(target, alpha));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code, retryable, httpStatus: status, retryAfterMs: 60_000 });
      expect(String(failure)).not.toContain('synthetic-secret');
      expect(JSON.stringify(failure)).not.toContain('synthetic-secret');
    }
  });

  it('does not follow redirects or send the source credential to another server', async () => {
    const [source, sink] = await Promise.all([fixture(alpha, 'redirect'), fixture(beta, 'sink')]);
    source.versionFault = 'redirect';
    source.redirectTo = `${sink.endpoint}/version`;
    await expect(new KubernetesAdapter().inspect(connection(source, alpha))).rejects.toMatchObject({
      code: 'KUBERNETES_REDIRECT_REJECTED',
    });
    expect(sink.paths).toHaveLength(0);
  });

  it('bounds bodies and releases timed-out and cancelled sockets', async () => {
    const target = await fixture(alpha, 'bounded');
    target.versionFault = 'large';
    await expect(
      new KubernetesAdapter({ maxResponseBytes: 1024 }).inspect(connection(target, alpha)),
    ).rejects.toMatchObject({ code: 'KUBERNETES_RESPONSE_TOO_LARGE' });
    target.versionFault = 'slow';
    await expect(
      new KubernetesAdapter({ requestTimeoutMs: 80 }).inspect(connection(target, alpha)),
    ).rejects.toMatchObject({ code: 'KUBERNETES_TIMEOUT', retryable: true });
    const controller = new AbortController();
    const pending = new KubernetesAdapter().inspect(connection(target, alpha), {
      signal: controller.signal,
    });
    await delay(30);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'KUBERNETES_CANCELLED', retryable: false });
    await delay(75);
    expect(target.sockets.size).toBe(0);
  });

  it('supports a consistent Node list and rejects repeated or inconsistent pagination without partial results', async () => {
    const target = await fixture(alpha, 'pages');
    target.pagination = 'valid';
    const adapter = new KubernetesAdapter();
    const observed = await adapter.inspect(connection(target, alpha));
    expect(observed.nodes.map((node) => node.name)).toEqual(['same-node', 'same-node-2']);
    for (const pagination of ['repeat', 'inconsistent'] as const) {
      target.pagination = pagination;
      await expect(adapter.inspect(connection(target, alpha))).rejects.toMatchObject({
        code: 'KUBERNETES_INVALID_RESPONSE',
      });
    }
    target.pagination = 'valid';
    await expect(
      new KubernetesAdapter({ maxNodes: 1 }).inspect(connection(target, alpha)),
    ).rejects.toMatchObject({ code: 'KUBERNETES_RESPONSE_TOO_LARGE' });
  });

  it('rejects a metric for a replaced Node or an old sample, and preserves genuine zero usage', async () => {
    const target = await fixture(alpha, 'metric-identity');
    const adapter = new KubernetesAdapter();
    target.metricUid = 'a-different-node-uid';
    let observed = await adapter.inspect(connection(target, alpha));
    expect(observed.nodes[0]!.metrics.cpuCores).toBeNull();
    target.metricUid = undefined;
    target.metricTimestamp = new Date(Date.now() - 3600_000).toISOString();
    observed = await adapter.inspect(connection(target, alpha));
    expect(observed.nodes[0]!.metrics.state).toBe('unknown');
    target.metricTimestamp = undefined;
    target.cpu = 'not-a-quantity';
    target.metricCpu = '0';
    observed = await adapter.inspect(connection(target, alpha));
    expect(observed.nodes[0]!.capacity.cpuCores).toBeNull();
    expect(observed.nodes[0]!.metrics.cpuCores).toBe(0);
  });

  it('discovers ingress and storage settings without mistaking an old Traefik generation for readiness', async () => {
    const target = await fixture(alpha, 'capabilities');
    const adapter = new KubernetesAdapter();
    target.capabilitiesStatus = 200;
    let observed = await adapter.inspect(connection(target, alpha));
    expect(observed.capabilities.ingress.classes).toEqual([
      { name: 'traefik', controller: 'traefik.io/ingress-controller', isDefault: true },
    ]);
    expect(observed.capabilities.storage.classes[0]).toMatchObject({
      name: 'local-path',
      isDefault: true,
      provisioner: 'rancher.io/local-path',
      volumeBindingMode: 'WaitForFirstConsumer',
    });
    expect(observed.capabilities.traefik).toMatchObject({ state: 'available', ready: false });
    target.traefikObservedGeneration = 2;
    observed = await adapter.inspect(connection(target, alpha));
    expect(observed.capabilities.traefik.ready).toBe(true);
    target.capabilitiesStatus = 403;
    observed = await adapter.inspect(connection(target, alpha));
    expect(observed.capabilities.storage).toMatchObject({ state: 'forbidden', classes: [] });
    expect(observed.capabilities.ingress).toMatchObject({ state: 'forbidden', classes: [] });
    expect(observed.capabilities.traefik).toMatchObject({ state: 'forbidden', ready: null });
  });

  it('returns bounded workload previews without specifications or secrets, and does not count unreadable collections as zero', async () => {
    const target = await fixture(alpha, 'workloads');
    const adapter = new KubernetesAdapter();
    target.workloadStatus = 200;
    target.workloadItems = 105;
    let observed = await adapter.inspect(connection(target, alpha));
    expect(observed.workloads.state).toBe('available');
    expect(observed.workloads.items).toHaveLength(600);
    expect(
      observed.workloads.collections.every((item) => item.listedCount === 100 && item.truncated),
    ).toBe(true);
    expect(observed.workloads.items.find((item) => item.kind === 'Deployment')).toMatchObject({
      status: 'ready',
      ready: true,
      namespace: 'test-namespace',
      managedBy: 'ozz',
    });
    expect(JSON.stringify(observed.workloads)).not.toContain('synthetic-workload-secret');
    expect(JSON.stringify(observed.workloads)).not.toContain('containers');
    target.workloadStatus = 403;
    observed = await adapter.inspect(connection(target, alpha));
    expect(observed.workloads.state).toBe('unknown');
    expect(observed.workloads.items).toHaveLength(0);
    expect(
      observed.workloads.collections.every(
        (item) => item.listedCount === null && item.state === 'forbidden',
      ),
    ).toBe(true);
  });
});
