import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KubernetesNetworkingAdapter,
  networkingNames,
} from '../../packages/infrastructure/dist/networking.js';
import {
  createInspectionClient,
  transportLimits,
} from '../../packages/infrastructure/dist/kubernetes/transport.js';
import { domainResources } from '../../packages/infrastructure/dist/networking/manifests.js';
import { NetworkingFixture, journal, key } from './networking-fixture.js';

const fixtures: NetworkingFixture[] = [];
async function setup(certManager = true) {
  const server = new NetworkingFixture(certManager);
  fixtures.push(server);
  await server.start();
  const plan = server.plan();
  const state = journal();
  const manager = new KubernetesNetworkingAdapter({
    requestTimeoutMs: 3000,
    operationTimeoutMs: 15000,
    installTimeoutMs: 15000,
    pollIntervalMs: 10,
    localAcme: {
      stagingUrl: 'https://127.0.0.1:14000/dir',
      productionUrl: 'https://127.0.0.1:14100/dir',
      caBundle: server.ca,
      solverNameservers: ['127.0.0.1:1053'],
    },
  });
  return { server, plan, state, manager };
}
async function applied() {
  const value = await setup();
  const receipt = await value.manager.apply(
    value.server.connection(),
    value.plan,
    value.state.hooks,
  );
  return { ...value, receipt };
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
});

describe('Kubernetes networking protocol and durable ownership', () => {
  it('creates named HTTP/HTTPS resources and reserves controller TLS creation before Certificate admission', async () => {
    const { server, plan, state, manager } = await setup();
    const rows = domainResources(plan);
    server.beforeWrite = (resource) => {
      if (resource.kind === 'Certificate')
        expect(
          state.intents.some(
            (intent) =>
              intent.kind === 'Secret' &&
              intent.name === rows.tls.name &&
              intent.action === 'create',
          ),
        ).toBe(true);
    };
    const result = await manager.apply(server.connection(), plan, state.hooks);
    expect(result.route).toMatchObject({ state: 'ready', readyEndpoints: 1 });
    expect(result.certificate).toMatchObject({ state: 'staging_ready', authority: 'local_test' });
    expect(result.resources).toHaveLength(7);
    expect(
      result.resources.every(
        (resource) =>
          resource.uid &&
          resource.resourceVersion &&
          /^[a-f0-9]{64}$/u.test(resource.specFingerprint!),
      ),
    ).toBe(true);
    expect(state.inventory.every((resource) => resource.creationAttempted)).toBe(true);
    const certificate = server.resources.get(key(rows.certificate))!;
    expect(certificate.spec).toMatchObject({
      renewBeforePercentage: 33,
      privateKey: { rotationPolicy: 'Always' },
      dnsNames: [plan.target.hostname],
    });
    const issuer = server.resources.get(key(rows.issuer))!;
    expect(issuer.spec).toMatchObject({
      acme: {
        disableAccountKeyGeneration: true,
        privateKeySecretRef: { name: rows.account.name },
        server: 'https://127.0.0.1:14000/dir',
        caBundle: Buffer.from(server.ca).toString('base64'),
      },
    });
    for (const name of [rows.tls, rows.account]) {
      const secret = server.resources.get(key(name))!;
      expect(secret.metadata.labels?.['ozz.dev/service-id']).toBeUndefined();
      expect(secret.metadata.annotations?.['networking.ozz.dev/creation-nonce']).toBeTruthy();
    }
    expect(server.resources.get(key(rows.http))!.metadata.annotations).toMatchObject({
      'traefik.ingress.kubernetes.io/router.entrypoints': 'web',
      'traefik.ingress.kubernetes.io/router.priority': '1',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE KEY|fixture-private-response-marker|tls\.key/u,
    );
  });

  it('retries without writes and never rotates the existing account key', async () => {
    const { server, plan, state, manager } = await applied();
    const writes = server.writes().length;
    const account = server.resources.get(key(domainResources(plan).account))!;
    const data = account.data;
    const result = await manager.apply(
      server.connection(),
      { ...plan, inventory: state.inventory },
      state.hooks,
    );
    expect(server.writes()).toHaveLength(writes);
    expect(result.certificate.state).toBe('staging_ready');
    expect(account.data).toEqual(data);
  });

  it('recovers a create whose HTTP response was lost using the original nonce and key', async () => {
    const { server, plan, state, manager } = await setup();
    server.lostCreateKind = 'Secret';
    await expect(manager.apply(server.connection(), plan, state.hooks)).rejects.toMatchObject({
      code: 'KUBERNETES_UNREACHABLE',
    });
    const accountRow = state.inventory.find((row) => row.role === 'acme_account')!;
    expect(accountRow).toMatchObject({ uid: null, creationAttempted: true });
    const original = structuredClone(server.resources.get(key(accountRow))!);
    await manager.apply(server.connection(), { ...plan, inventory: state.inventory }, state.hooks);
    expect(server.resources.get(key(accountRow))).toEqual(original);
    expect(server.writes().filter((request) => request.body?.kind === 'Secret')).toHaveLength(1);
  });

  it('recovers a create whose durable receipt was interrupted', async () => {
    const { server, plan, state, manager } = await setup();
    state.state.failReceiptKind = 'Secret';
    await expect(manager.apply(server.connection(), plan, state.hooks)).rejects.toMatchObject({
      code: 'NETWORK_CALLBACK_FAILED',
    });
    const account = state.inventory.find((row) => row.role === 'acme_account')!;
    expect(account.uid).toBeNull();
    await manager.apply(server.connection(), { ...plan, inventory: state.inventory }, state.hooks);
    expect(state.inventory.find((row) => row.role === 'acme_account')?.uid).toBeTruthy();
    expect(server.writes().filter((request) => request.body?.kind === 'Secret')).toHaveLength(1);
  });

  it.each(['missing_parent', 'wrong_issuer'] as const)(
    'refuses an unrecorded TLS Secret with %s proof',
    async (mutation) => {
      const { server, plan, state, manager } = await setup();
      const rows = domainResources(plan);
      server.beforeWrite = (resource) => {
        if (resource.kind === 'Certificate') state.state.failReceiptKind = 'Secret';
      };
      await expect(manager.apply(server.connection(), plan, state.hooks)).rejects.toMatchObject({
        code: 'NETWORK_CALLBACK_FAILED',
      });
      const tlsRow = state.inventory.find((row) => row.role === 'tls')!;
      expect(tlsRow.uid).toBeNull();
      if (mutation === 'missing_parent') server.resources.delete(key(rows.certificate));
      else
        server.resources.get(key(rows.tls))!.metadata.annotations!['cert-manager.io/issuer-name'] =
          'unrelated-issuer';
      const count = server.writes().length;
      const observed = await manager.observe(server.connection(), {
        ...plan,
        inventory: state.inventory,
      });
      expect(observed.certificate).toMatchObject({
        state: 'unknown',
        code: 'NETWORK_TLS_PARENT_UNVERIFIED',
      });
      expect(observed.verifiedResources?.some((row) => row.role === 'tls')).toBe(false);
      await expect(
        manager.remove(
          server.connection(),
          { ...plan, revision: 2, inventory: state.inventory },
          state.hooks,
        ),
      ).rejects.toMatchObject({ code: 'NETWORK_TLS_PARENT_UNVERIFIED' });
      expect(server.writes()).toHaveLength(count);
    },
  );

  it('rejects a TLS Secret with a mismatching private key without exposing key material', async () => {
    const { server, plan, state, manager } = await applied();
    const rows = domainResources(plan);
    const tls = server.resources.get(key(rows.tls))!;
    tls.data = {
      ...(tls.data as object),
      'tls.key': (server.resources.get(key(rows.account))!.data as Record<string, string>)[
        'tls.key'
      ],
    };
    const observation = await manager.observe(server.connection(), {
      ...plan,
      inventory: state.inventory,
    });
    expect(observation.certificate).toMatchObject({
      state: 'pending',
      code: 'CERTIFICATE_SECRET_INVALID',
    });
    expect(JSON.stringify(observation)).not.toMatch(/PRIVATE KEY|tls\.key/u);
  });

  it('does not claim production trust for a self-signed chain even with a current Ready status', async () => {
    const { server, plan, state } = await setup();
    const manager = new KubernetesNetworkingAdapter({
      requestTimeoutMs: 3000,
      operationTimeoutMs: 15000,
    });
    const result = await manager.apply(
      server.connection(),
      { ...plan, certificateEnvironment: 'production' },
      state.hooks,
    );
    expect(result.certificate).toMatchObject({
      state: 'pending',
      authority: 'unknown',
      code: 'CERTIFICATE_PUBLIC_TRUST_UNVERIFIED',
    });
  });

  it('follows only the current Certificate owner chain to diagnose failed ACME Orders', async () => {
    const { server, plan, state, manager } = await applied();
    const rows = domainResources(plan);
    const certificate = server.resources.get(key(rows.certificate))!;
    certificate.status!.conditions = [
      {
        type: 'Ready',
        status: 'False',
        observedGeneration: certificate.metadata.generation,
        reason: 'Pending',
      },
    ];
    const request = server.seed({
      apiVersion: 'cert-manager.io/v1',
      kind: 'CertificateRequest',
      metadata: {
        name: `${certificate.metadata.name}-1`,
        namespace: plan.target.namespace,
        annotations: { 'cert-manager.io/certificate-revision': '1' },
        ownerReferences: [
          {
            apiVersion: 'cert-manager.io/v1',
            kind: 'Certificate',
            name: certificate.metadata.name,
            uid: certificate.metadata.uid,
            controller: true,
          },
        ],
      },
      spec: { issuerRef: certificate.spec!.issuerRef },
    });
    server.seed({
      apiVersion: 'acme.cert-manager.io/v1',
      kind: 'Order',
      metadata: {
        name: 'fixture-order',
        namespace: plan.target.namespace,
        ownerReferences: [
          {
            apiVersion: 'cert-manager.io/v1',
            kind: 'CertificateRequest',
            name: request.metadata.name,
            uid: request.metadata.uid,
            controller: true,
          },
        ],
      },
      status: { state: 'invalid', reason: 'fixture-private-response-marker' },
    });
    const observation = await manager.observe(server.connection(), {
      ...plan,
      inventory: state.inventory,
    });
    expect(observation.certificate.code).toBe('ACME_ORDER_FAILED');
    expect(JSON.stringify(observation)).not.toContain('fixture-private-response-marker');
    request.metadata.ownerReferences = [
      {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        name: certificate.metadata.name,
        uid: randomUUID(),
        controller: true,
      },
    ];
    const foreign = await manager.observe(server.connection(), {
      ...plan,
      inventory: state.inventory,
    });
    expect(foreign.certificate.code).toBeNull();
  });

  it('accepts private IPv6 ACME fixtures while retaining strict HTTPS and private resolver bounds', async () => {
    const { server } = await setup();
    expect(
      () =>
        new KubernetesNetworkingAdapter({
          localAcme: {
            stagingUrl: 'https://[::1]:14000/dir',
            productionUrl: 'https://[fd00::1]:14100/dir',
            caBundle: server.ca,
            solverNameservers: ['[::1]:1053', 'fd00::1'],
          },
        }),
    ).not.toThrow();
    expect(
      () =>
        new KubernetesNetworkingAdapter({
          localAcme: {
            stagingUrl: 'https://[::1]:14000/dir',
            productionUrl: 'https://[fd00::1]:14100/dir',
            caBundle: server.ca,
            solverNameservers: ['8.8.8.8:53'],
          },
        }),
    ).toThrow();
  });

  it('preflights all owned names and rejects a foreign resource before any Kubernetes writes', async () => {
    const { server, plan, state, manager } = await setup();
    const rows = domainResources(plan);
    server.seed({
      apiVersion: rows.http.apiVersion,
      kind: rows.http.kind,
      metadata: {
        name: rows.http.name,
        namespace: rows.http.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'ozz' },
      },
    });
    await expect(manager.apply(server.connection(), plan, state.hooks)).rejects.toMatchObject({
      code: 'NETWORK_RESOURCE_OWNERSHIP_MISMATCH',
    });
    expect(server.writes()).toHaveLength(0);
  });

  it('does not adopt a same-name replacement, including on explicit reconcile', async () => {
    const { server, plan, state, manager } = await applied();
    const http = server.resources.get(key(domainResources(plan).http))!;
    http.metadata.uid = randomUUID();
    const writes = server.writes().length;
    await expect(
      manager.apply(
        server.connection(),
        { ...plan, revision: 2, reconcileMissing: true, inventory: state.inventory },
        state.hooks,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_RESOURCE_OWNERSHIP_MISMATCH' });
    expect(server.writes()).toHaveLength(writes);
  });

  it('records proven absence and uses a fresh nonce only on explicit reconcile', async () => {
    const { server, plan, state, manager } = await applied();
    const rows = domainResources(plan);
    const old = state.inventory.find((row) => row.role === 'http')!;
    server.resources.delete(key(rows.http));
    const writes = server.writes().length;
    await expect(
      manager.apply(server.connection(), { ...plan, inventory: state.inventory }, state.hooks),
    ).rejects.toMatchObject({ code: 'NETWORK_RESOURCE_MISSING' });
    expect(server.writes()).toHaveLength(writes);
    const result = await manager.apply(
      server.connection(),
      { ...plan, revision: 2, reconcileMissing: true, inventory: state.inventory },
      state.hooks,
    );
    const next = state.inventory.find((row) => row.role === 'http')!;
    expect(next.creationNonce).not.toBe(old.creationNonce);
    expect(next.uid).not.toBe(old.uid);
    expect(
      result.resources.some((receipt) => receipt.action === 'deleted' && receipt.uid === old.uid),
    ).toBe(true);
  });

  it('keeps sync read-only and reports spec drift without changing the ledger', async () => {
    const { server, plan, state, manager } = await applied();
    const rows = domainResources(plan);
    const ingress = server.resources.get(key(rows.http))!;
    ingress.spec!.rules = [];
    const writes = server.writes().length;
    const receipts = state.receipts.length;
    const result = await manager.observe(server.connection(), {
      ...plan,
      inventory: state.inventory,
    });
    expect(result.route.state).toBe('drifted');
    expect(server.writes()).toHaveLength(writes);
    expect(state.receipts).toHaveLength(receipts);
    await expect(
      manager.apply(
        server.connection(),
        { ...plan, revision: 2, inventory: state.inventory },
        state.hooks,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_RESOURCE_DRIFT' });
  });

  it('requires the published Service UID and verifies EndpointSlice Service ownership', async () => {
    const { server, plan, state, manager } = await applied();
    server.endpointOwnerOverride = randomUUID();
    const observation = await manager.observe(server.connection(), {
      ...plan,
      inventory: state.inventory,
    });
    expect(observation.route).toMatchObject({
      state: 'drifted',
      code: 'NETWORK_BACKEND_IDENTITY_MISMATCH',
    });
    const service = server.resources.get(
      `Service/${plan.target.namespace}/${plan.target.serviceName}`,
    )!;
    service.metadata.uid = randomUUID();
    const writes = server.writes().length;
    await expect(
      manager.apply(server.connection(), { ...plan, inventory: state.inventory }, state.hooks),
    ).rejects.toMatchObject({ code: 'NETWORK_BACKEND_IDENTITY_MISMATCH' });
    expect(server.writes()).toHaveLength(writes);
  });

  it('removes only domain resources with UID and resourceVersion preconditions and retries a lost delete receipt', async () => {
    const { server, plan, state, manager } = await applied();
    state.state.failDeleteReceipt = true;
    await expect(
      manager.remove(
        server.connection(),
        { ...plan, revision: 2, inventory: state.inventory },
        state.hooks,
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_CALLBACK_FAILED' });
    const result = await manager.remove(
      server.connection(),
      { ...plan, revision: 2, inventory: state.inventory },
      state.hooks,
    );
    expect(result.route.state).toBe('removed');
    expect(state.inventory).toHaveLength(2);
    expect(state.inventory.every((row) => row.scope === 'environment')).toBe(true);
    const deletes = server.writes().filter((request) => request.method === 'DELETE');
    expect(deletes).toHaveLength(5);
    expect(
      deletes.every((request) => {
        const options = request.body?.preconditions as Record<string, unknown>;
        return options.uid && options.resourceVersion;
      }),
    ).toBe(true);
    expect(server.resources.has(key(domainResources(plan).issuer))).toBe(true);
  });

  it('does not reuse a stale Ready condition while production issuance has a newer generation', async () => {
    const { server, plan, state, manager } = await applied();
    server.autoCertificate = false;
    const next = {
      ...plan,
      revision: 2,
      certificateEnvironment: 'production' as const,
      inventory: state.inventory,
    };
    const result = await manager.apply(server.connection(), next, state.hooks);
    expect(result.certificate.state).toBe('pending');
    expect(result.certificate.authority).toBe('local_test');
  });

  it('respects cancellation before writing and redacts rejected Kubernetes response bodies', async () => {
    const { server, plan, state, manager } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.apply(server.connection(), plan, { ...state.hooks, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'KUBERNETES_CANCELLED' });
    expect(server.writes()).toHaveLength(0);
    server.rejectedWrite = { kind: 'Secret', status: 403 };
    const error = await manager
      .apply(server.connection(), plan, state.hooks)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'KUBERNETES_FORBIDDEN' });
    expect(String(error)).not.toContain('fixture-private-response-marker');
  });

  it('installs all 47 fixed manifests with digest images, bounded CRD requests and owned receipts', async () => {
    const { server, plan, state, manager } = await setup(false);
    server.unreadyDeploymentReads = 30;
    const result = await manager.installCertManager(server.connection(), plan.target, state.hooks);
    expect(result.certManager).toBe('ready');
    expect(result.certManagerVersion).toBe('v1.21.3');
    expect(state.inventory).toHaveLength(47);
    expect(
      state.inventory.every((row) => row.scope === 'cluster' && row.uid && row.revision === 1),
    ).toBe(true);
    const creates = server.writes().filter((request) => request.method === 'POST');
    expect(creates).toHaveLength(47);
    expect(
      creates.some((request) => Buffer.byteLength(JSON.stringify(request.body)) > 64 * 1024),
    ).toBe(true);
    const controller = server.resources.get('Deployment/cert-manager/cert-manager')!;
    const container = (
      controller.spec!.template as { spec: { containers: { image: string; args: string[] }[] } }
    ).spec.containers[0]!;
    expect(container.image).toMatch(/@sha256:[a-f0-9]{64}$/u);
    expect(container.args).toContain('--acme-http01-solver-nameservers=127.0.0.1:1053');
    expect(
      container.args.some((arg) =>
        /^--acme-http01-solver-image=.+@sha256:[a-f0-9]{64}$/u.test(arg),
      ),
    ).toBe(true);
    expect(
      server.requests.filter(
        (request) =>
          request.method === 'GET' &&
          request.path.includes('/customresourcedefinitions/') &&
          request.path.endsWith('cert-manager.io'),
      ),
    ).toHaveLength(18);
    const writes = server.writes().length;
    await manager.installCertManager(server.connection(), plan.target, state.hooks);
    expect(server.writes()).toHaveLength(writes);
  }, 30000);

  it('refuses to overwrite a compatible external cert-manager installation', async () => {
    const { server, plan, state, manager } = await setup();
    const capabilities = await manager.inspect(server.connection(), plan.target);
    expect(capabilities.certManager).toBe('ready');
    await expect(
      manager.installCertManager(server.connection(), plan.target, state.hooks),
    ).rejects.toMatchObject({ code: 'NETWORK_RESOURCE_OWNERSHIP_MISMATCH' });
    expect(server.writes()).toHaveLength(0);
  });

  it('keeps the ordinary transport 64 KiB request limit and rejects arbitrary paths', async () => {
    const { server } = await setup();
    const client = await createInspectionClient(
      server.connection(),
      transportLimits({}),
      new AbortController().signal,
    );
    try {
      await expect(
        client.request('POST', '/api/v1/namespaces/test/secrets', { data: 'x'.repeat(64 * 1024) }),
      ).rejects.toMatchObject({ code: 'KUBERNETES_INVALID_RESPONSE' });
      for (const path of [
        'https://evil.test',
        '/api/v1/../secrets',
        '/api/v1//secrets',
        '/api/v1/%2fsecrets',
      ])
        await expect(client.request('GET', path)).rejects.toMatchObject({
          code: 'KUBERNETES_INVALID_RESPONSE',
        });
      expect(server.writes()).toHaveLength(0);
    } finally {
      client.close();
    }
    expect(networkingNames({ domainId: '11111111-1111-1111-1111-111111111111' }).tlsSecret).toBe(
      'ozz-t-11111111111111111111111111111111',
    );
  });
});
