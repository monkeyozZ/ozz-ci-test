import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { connectionMaterial, verifyCredentialTime } from '../kubernetes/config.js';
import type {
  KubernetesAdapterOptions,
  ParsedKubernetesConnection,
} from '../kubernetes/contracts.js';
import {
  createInspectionClient,
  transportLimits,
  type InspectionClient,
  type TransportLimits,
} from '../kubernetes/transport.js';
import {
  CERT_MANAGER_IMAGES,
  CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS,
  CERT_MANAGER_VERSION,
  loadCertManagerManifests,
} from './cert-manager-assets.js';
import type {
  KubernetesNetworkingManager,
  LocalAcmeTestConfiguration,
  NetworkClusterTarget,
  NetworkDomainPlan,
  NetworkDomainReceipt,
  NetworkingCapabilities,
  NetworkWriteHooks,
} from './contracts.js';
import {
  accountSecret,
  bare,
  certificateManifest,
  domainResources,
  issuerManifest,
  routeManifests,
} from './manifests.js';
import { observeDomain, observePlan, removedObservation, verifyBackend } from './observation.js';
import {
  ResourceWriter,
  assertOwnership,
  descriptor,
  entries,
  fail,
  fields,
  readResource,
  resourceKey,
  safeError,
  verifyTlsParent,
  type Resource,
} from './resources.js';

export interface KubernetesNetworkingAdapterOptions extends KubernetesAdapterOptions {
  operationTimeoutMs?: number;
  installTimeoutMs?: number;
  pollIntervalMs?: number;
  localAcme?: LocalAcmeTestConfiguration;
  now?: () => Date;
}
function limit(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new TypeError('Invalid networking adapter limit');
  return result;
}
function validateCluster(target: NetworkClusterTarget): void {
  for (const id of [target.installationId, target.clusterId, target.kubeSystemUid])
    if (!/^[A-Za-z0-9_-]{1,63}$/u.test(id)) fail('NETWORK_INPUT_INVALID', '集群网络目标身份无效。');
  if (!/^SHA256:[a-f0-9]{64}$/u.test(target.caFingerprint))
    fail('NETWORK_INPUT_INVALID', '集群 CA 指纹无效。');
}
function validatePlan(plan: NetworkDomainPlan): void {
  validateCluster(plan.target);
  const target = plan.target;
  for (const id of [
    target.projectId,
    target.environmentId,
    target.serviceId,
    target.domainId,
    target.portId,
  ])
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
      fail('NETWORK_INPUT_INVALID', '域名网络目标身份无效。');
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(target.serviceUid) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(target.namespace) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(target.serviceName) ||
    !/^[a-z]([-a-z0-9]{0,13}[a-z0-9])?$/u.test(target.portName) ||
    target.hostname.length > 253 ||
    target.hostname.split('.').length < 2 ||
    target.hostname
      .split('.')
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    !Number.isSafeInteger(plan.platformRevision) ||
    plan.platformRevision < 1 ||
    !['staging', 'production'].includes(plan.certificateEnvironment) ||
    typeof plan.reconcileMissing !== 'boolean' ||
    !/^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{2,63}$/u.test(plan.acmeEmail) ||
    plan.inventory.length > 256
  )
    fail('NETWORK_INPUT_INVALID', '域名网络计划无效。');
  const allowed = new Map(
    [
      ...Object.values(domainResources({ ...plan, certificateEnvironment: 'staging' })),
      ...Object.values(domainResources({ ...plan, certificateEnvironment: 'production' })),
    ].map((row) => [resourceKey(row), row]),
  );
  const seen = new Set<string>();
  for (const row of plan.inventory) {
    const expected = allowed.get(resourceKey(row));
    if (
      !expected ||
      seen.has(resourceKey(row)) ||
      Object.entries(expected).some(([key, value]) => row[key as keyof typeof row] !== value)
    )
      fail('NETWORK_RESOURCE_OWNERSHIP_MISMATCH', '域名网络台账包含无关或重复的资源。');
    seen.add(resourceKey(row));
  }
}
function localConfiguration(
  value: LocalAcmeTestConfiguration | undefined,
): LocalAcmeTestConfiguration | undefined {
  if (!value) return undefined;
  const privateAddress = (host: string) => {
    const address = host.replace(/^\[|\]$/gu, '').toLowerCase();
    return (
      (isIP(address) === 4 &&
        (/^127\./u.test(address) ||
          /^10\./u.test(address) ||
          /^192\.168\./u.test(address) ||
          /^172\.(1[6-9]|2[0-9]|3[01])\./u.test(address))) ||
      (isIP(address) === 6 && (address === '::1' || /^f[cd]/u.test(address)))
    );
  };
  try {
    for (const address of [value.stagingUrl, value.productionUrl]) {
      const url = new URL(address);
      if (
        url.protocol !== 'https:' ||
        !privateAddress(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== '/dir' ||
        url.search ||
        url.hash
      )
        throw new Error();
    }
    const ca = new X509Certificate(value.caBundle);
    if (
      value.stagingUrl === value.productionUrl ||
      value.caBundle.length > 128 * 1024 ||
      !ca.ca ||
      value.caBundle.includes('PRIVATE KEY') ||
      (value.caBundle.match(/-----BEGIN CERTIFICATE-----/gu)?.length ?? 0) !== 1 ||
      Date.parse(ca.validFrom) > Date.now() ||
      Date.parse(ca.validTo) <= Date.now() ||
      value.solverNameservers.length === 0 ||
      value.solverNameservers.length > 4 ||
      value.solverNameservers.some((server) => {
        if (privateAddress(server)) return false;
        const match = /^(\[[a-f0-9:]+\]|[0-9.]+):(\d{1,5})$/iu.exec(server);
        return (
          !match || !privateAddress(match[1]!) || Number(match[2]) < 1 || Number(match[2]) > 65535
        );
      })
    )
      throw new Error();
  } catch {
    fail('NETWORK_LOCAL_ACME_INVALID', '本地 ACME 测试配置无效。');
  }
  return structuredClone(value);
}
function readyDeployment(value: Resource | null): boolean {
  if (!value || value.metadata.deletionTimestamp) return false;
  const replicas = Number(value.spec?.replicas ?? 1);
  return (
    Number(value.status?.observedGeneration) >= Number(value.metadata.generation) &&
    replicas > 0 &&
    Number(value.status?.readyReplicas) >= replicas &&
    Number(value.status?.availableReplicas) >= replicas
  );
}
function deploymentVersion(value: Resource): string | null {
  const versions = entries(fields(fields(value.spec?.template).spec).containers).map((container) =>
    typeof container.image === 'string'
      ? /:(v\d+\.\d+\.\d+)(?:@sha256:[a-f0-9]{64})?$/u.exec(container.image)?.[1]
      : undefined,
  );
  return versions.length === 1 ? (versions[0] ?? null) : null;
}

export class KubernetesNetworkingAdapter implements KubernetesNetworkingManager {
  private readonly limits: TransportLimits;
  private readonly operationTimeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly localAcme?: LocalAcmeTestConfiguration;
  private readonly now: () => Date;
  constructor(options: KubernetesNetworkingAdapterOptions = {}) {
    this.limits = transportLimits(options);
    this.operationTimeoutMs = limit(options.operationTimeoutMs, 120_000, 50, 900_000);
    this.installTimeoutMs = limit(options.installTimeoutMs, 600_000, 50, 900_000);
    this.pollIntervalMs = limit(options.pollIntervalMs, 2000, 10, 10000);
    this.localAcme = localConfiguration(options.localAcme);
    this.now = options.now ?? (() => new Date());
  }
  private async session<T>(
    connection: ParsedKubernetesConnection,
    target: NetworkClusterTarget,
    signal: AbortSignal | undefined,
    installing: boolean,
    work: (client: InspectionClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    validateCluster(target);
    connectionMaterial(connection);
    verifyCredentialTime(connection, this.now());
    if (connection.caFingerprint !== target.caFingerprint)
      fail('KUBERNETES_CA_MISMATCH', '集群 CA 与已登记指纹不一致。');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort('operation_timeout'),
      installing ? this.installTimeoutMs : this.operationTimeoutMs,
    );
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let client: InspectionClient | undefined;
    try {
      if (combined.aborted) fail('KUBERNETES_CANCELLED', '网络操作已取消。');
      client = await createInspectionClient(
        connection,
        {
          ...this.limits,
          ...(installing
            ? { maxRequestBytes: 256 * 1024, maxInspectionBytes: 32 * 1024 * 1024 }
            : {}),
        },
        combined,
      );
      const system = await client.core.readNamespace({ name: 'kube-system' });
      if (system.metadata?.name !== 'kube-system' || system.metadata.uid !== target.kubeSystemUid)
        fail('KUBERNETES_CLUSTER_IDENTITY_MISMATCH', '目标不是已登记的 Kubernetes 集群。');
      const result = await work(client, combined);
      if (combined.aborted) fail('KUBERNETES_CANCELLED', '网络操作已取消。');
      return result;
    } catch (error) {
      if (signal?.aborted) fail('KUBERNETES_CANCELLED', '网络操作已取消。');
      if (controller.signal.aborted)
        fail('NETWORK_OPERATION_TIMEOUT', '网络操作超时，已保留创建前登记和已确认回执。', true);
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      controller.abort('operation_finished');
      client?.close();
    }
  }
  private async capabilities(
    client: InspectionClient,
    permissions = true,
  ): Promise<NetworkingCapabilities> {
    const result: NetworkingCapabilities = {
      observedAt: this.now().toISOString(),
      ingressClass: 'unknown',
      ingressClassName: 'traefik',
      traefikMiddleware: 'unknown',
      certManager: 'unknown',
      certManagerVersion: null,
      permissions: 'unknown',
      issues: [],
    };
    const issue = (error: unknown) => {
      const safe = safeError(error);
      result.issues.push({ code: safe.code, message: safe.message });
    };
    try {
      const ingressClass = await readResource(client, {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'IngressClass',
        namespace: '',
        name: 'traefik',
      });
      result.ingressClass =
        ingressClass?.spec?.controller === 'traefik.io/ingress-controller' ? 'ready' : 'missing';
    } catch (error) {
      issue(error);
    }
    try {
      const middleware = await readResource(client, {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        namespace: '',
        name: 'middlewares.traefik.io',
      });
      result.traefikMiddleware =
        middleware &&
        entries(middleware.spec?.versions).some(
          (value) => value.name === 'v1alpha1' && value.served === true,
        ) &&
        entries(middleware.status?.conditions).some(
          (value) => value.type === 'Established' && value.status === 'True',
        )
          ? 'ready'
          : 'missing';
    } catch (error) {
      issue(error);
    }
    try {
      const deployments: Resource[] = [];
      for (const name of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook']) {
        const value = await readResource(client, {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          namespace: 'cert-manager',
          name,
        });
        if (value) deployments.push(value);
      }
      const versions = new Set(deployments.map(deploymentVersion));
      result.certManagerVersion = versions.size === 1 ? [...versions][0]! : null;
      if (!deployments.length) result.certManager = 'missing';
      else if (
        deployments.length !== 3 ||
        !result.certManagerVersion ||
        !/^v1\.21\.\d+$/u.test(result.certManagerVersion)
      )
        result.certManager = 'incompatible';
      else {
        let established = true;
        for (const name of [
          'certificates.cert-manager.io',
          'issuers.cert-manager.io',
          'challenges.acme.cert-manager.io',
          'orders.acme.cert-manager.io',
          'certificaterequests.cert-manager.io',
          'clusterissuers.cert-manager.io',
        ]) {
          const crd = await readResource(client, {
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            namespace: '',
            name,
          });
          if (
            !crd ||
            !entries(crd.spec?.versions).some(
              (version) => version.name === 'v1' && version.served === true,
            ) ||
            !entries(crd.status?.conditions).some(
              (condition) => condition.type === 'Established' && condition.status === 'True',
            )
          )
            established = false;
        }
        result.certManager =
          established && deployments.every(readyDeployment) ? 'ready' : 'unknown';
      }
    } catch (error) {
      issue(error);
    }
    if (permissions) {
      try {
        const checks = [
          ['', 'services', ['get']],
          ['', 'secrets', ['get', 'create', 'update', 'delete']],
          ['networking.k8s.io', 'ingresses', ['get', 'create', 'update', 'delete']],
          ['traefik.io', 'middlewares', ['get', 'create', 'update', 'delete']],
          ['cert-manager.io', 'certificates', ['get', 'create', 'update', 'delete']],
          ['cert-manager.io', 'issuers', ['get', 'create', 'update']],
          ['discovery.k8s.io', 'endpointslices', ['list']],
          ['cert-manager.io', 'certificaterequests', ['list']],
          ['acme.cert-manager.io', 'orders', ['list']],
          ['acme.cert-manager.io', 'challenges', ['list']],
        ] as const;
        let allowed = true;
        for (const [group, resource, verbs] of checks)
          for (const verb of verbs) {
            const review = await client.authorization.createSelfSubjectAccessReview({
              body: {
                apiVersion: 'authorization.k8s.io/v1',
                kind: 'SelfSubjectAccessReview',
                spec: { resourceAttributes: { group, resource, verb } },
              },
            });
            if (review.status?.allowed !== true || review.status.denied === true) allowed = false;
          }
        result.permissions = allowed ? 'ready' : 'insufficient';
      } catch (error) {
        issue(error);
      }
    }
    if (result.ingressClass !== 'ready')
      result.issues.push({
        code: 'TRAEFIK_INGRESS_CLASS_MISSING',
        message: '需要可用的 traefik IngressClass。',
      });
    if (result.traefikMiddleware !== 'ready')
      result.issues.push({
        code: 'TRAEFIK_MIDDLEWARE_MISSING',
        message: '需要可用的 Traefik Middleware CRD。',
      });
    if (result.certManager !== 'ready')
      result.issues.push({
        code: 'CERT_MANAGER_NOT_READY',
        message: 'cert-manager 缺失、版本不兼容或尚未就绪。',
      });
    if (result.permissions === 'insufficient')
      result.issues.push({
        code: 'NETWORK_PERMISSIONS_INSUFFICIENT',
        message: '凭据没有全部网络资源读写权限。',
      });
    return result;
  }
  async inspect(
    connection: ParsedKubernetesConnection,
    target: NetworkClusterTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<NetworkingCapabilities> {
    return this.session(connection, target, options.signal, false, (client) =>
      this.capabilities(client),
    );
  }
  async installCertManager(
    connection: ParsedKubernetesConnection,
    target: NetworkClusterTarget,
    hooks: NetworkWriteHooks,
  ): Promise<NetworkingCapabilities> {
    const manifests = (await loadCertManagerManifests()) as unknown as Resource[];
    for (const manifest of manifests)
      if (manifest.kind === 'Deployment') {
        for (const container of entries(fields(fields(manifest.spec?.template).spec).containers)) {
          const component =
            manifest.metadata.name === 'cert-manager'
              ? 'controller'
              : manifest.metadata.name === 'cert-manager-webhook'
                ? 'webhook'
                : 'cainjector';
          container.image = CERT_MANAGER_IMAGES[component];
          if (component === 'controller') {
            const args = (Array.isArray(container.args) ? container.args : []).filter(
              (arg) =>
                typeof arg === 'string' &&
                !arg.startsWith('--acme-http01-solver-image=') &&
                !arg.startsWith('--acme-http01-solver-nameservers='),
            );
            args.push(`--acme-http01-solver-image=${CERT_MANAGER_IMAGES.acmesolver}`);
            if (this.localAcme)
              args.push(
                `--acme-http01-solver-nameservers=${this.localAcme.solverNameservers.join(',')}`,
              );
            container.args = args;
          }
        }
      }
    return this.session(connection, target, hooks.signal, true, async (client, signal) => {
      const version = await client.version.getCode();
      const minor = Number(/^(\d+)/u.exec(version.minor ?? '')?.[1]);
      if (
        version.major !== '1' ||
        !(CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS as readonly number[]).includes(minor)
      )
        fail(
          'CERT_MANAGER_KUBERNETES_INCOMPATIBLE',
          '固定 cert-manager 版本要求 Kubernetes 1.33–1.36。',
        );
      const writer = new ResourceWriter(
        client,
        target,
        [],
        { domain: 0, environment: 0, cluster: 1 },
        hooks,
        signal,
        this.now,
      );
      const rows = manifests.map((manifest) => descriptor(manifest, 'cert_manager', 'cluster'));
      for (const row of rows) await writer.reserve(row);
      // Every known name is checked before the first Kubernetes write, including external installations.
      for (const row of rows) await writer.preflight(writer.row(row));
      const order = (resource: Resource) =>
        resource.kind === 'Namespace'
          ? 0
          : resource.kind === 'CustomResourceDefinition'
            ? 1
            : resource.kind === 'Deployment'
              ? 3
              : resource.kind.endsWith('WebhookConfiguration')
                ? 4
                : 2;
      for (const manifest of [...manifests].sort((a, b) => order(a) - order(b)))
        await writer.ensure(descriptor(manifest, 'cert_manager', 'cluster'), () => manifest);
      while (true) {
        await writer.checkpoint();
        // CRD schemas are large. Wait on the three small Deployments while images pull;
        // read the complete fixed API capability only once a rollout is ready.
        let deploymentsReady = true;
        for (const name of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook']) {
          const deployment = await readResource(client, {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            namespace: 'cert-manager',
            name,
          });
          if (!readyDeployment(deployment)) deploymentsReady = false;
        }
        if (deploymentsReady) {
          const capabilities = await this.capabilities(client);
          if (capabilities.certManager === 'ready') return capabilities;
        }
        await delay(this.pollIntervalMs, undefined, { signal });
      }
    });
  }
  async apply(
    connection: ParsedKubernetesConnection,
    plan: NetworkDomainPlan,
    hooks: NetworkWriteHooks,
  ): Promise<NetworkDomainReceipt> {
    validatePlan(plan);
    return this.session(connection, plan.target, hooks.signal, false, async (client, signal) => {
      const capabilities = await this.capabilities(client, false);
      if (
        capabilities.ingressClass !== 'ready' ||
        capabilities.traefikMiddleware !== 'ready' ||
        capabilities.certManager !== 'ready'
      )
        fail('NETWORK_CAPABILITIES_NOT_READY', 'Traefik 或兼容的 cert-manager 尚未就绪。', true);
      await verifyBackend(client, plan);
      const writer = new ResourceWriter(
        client,
        plan.target,
        plan.inventory,
        { domain: plan.revision, environment: plan.platformRevision, cluster: 1 },
        hooks,
        signal,
        this.now,
        plan.reconcileMissing,
      );
      const rows = domainResources(plan);
      for (const row of Object.values(rows)) await writer.reserve(row);
      for (const row of Object.values(rows)) await writer.preflight(writer.row(row));
      await writer.ensure(rows.account, (_row, account) =>
        account
          ? { ...bare(rows.account), type: account.type, data: account.data }
          : accountSecret(rows.account),
      );
      await writer.ensure(rows.issuer, () => issuerManifest(plan, this.localAcme));
      const tls = await writer.prepareChild(rows.tls);
      await writer.ensure(rows.certificate, () => certificateManifest(plan, tls));
      const routes = routeManifests(plan);
      await writer.ensure(rows.redirect, () => routes.redirect);
      // The backend's persisted UID is checked again at the final route write boundary.
      await verifyBackend(client, plan);
      await writer.ensure(rows.https, () => routes.https);
      await writer.ensure(rows.http, () => routes.http);
      const observation = await observeDomain(
        client,
        observePlan(plan, writer.inventory.values()),
        this.now(),
        this.localAcme,
      );
      for (const receipt of observation.verifiedResources ?? []) {
        const row = writer.row(receipt);
        if (receipt.kind === 'Secret' && receipt.role === 'tls' && !row.uid) {
          const actual = await writer.inspect(row);
          if (actual) await writer.record(row, actual, 'verified');
        }
      }
      return { ...observation, resources: writer.receipts, completedAt: this.now().toISOString() };
    });
  }
  async observe(
    connection: ParsedKubernetesConnection,
    plan: NetworkDomainPlan,
    options: { signal?: AbortSignal } = {},
  ) {
    validatePlan(plan);
    return this.session(connection, plan.target, options.signal, false, (client) =>
      observeDomain(client, plan, this.now(), this.localAcme),
    );
  }
  async remove(
    connection: ParsedKubernetesConnection,
    plan: NetworkDomainPlan,
    hooks: NetworkWriteHooks,
  ): Promise<NetworkDomainReceipt> {
    validatePlan(plan);
    return this.session(connection, plan.target, hooks.signal, false, async (client, signal) => {
      const writer = new ResourceWriter(
        client,
        plan.target,
        plan.inventory,
        { domain: plan.revision, environment: plan.platformRevision, cluster: 1 },
        hooks,
        signal,
        this.now,
      );
      const resources = plan.inventory.filter((row) => row.scope === 'domain');
      // Do not reserve missing/deleted rows on cleanup, and leave shared account Secrets/Issuers intact.
      for (const row of resources) {
        await writer.checkpoint();
        const actual = await readResource(client, row);
        if (actual) {
          assertOwnership(plan.target, row, actual, plan.revision);
          await verifyTlsParent(
            client,
            plan.target,
            writer.inventory.values(),
            row,
            actual,
            plan.revision,
          );
          if (!row.uid) await writer.record(writer.row(row), actual, 'verified');
        }
      }
      const rank = (row: (typeof resources)[number]) =>
        row.kind === 'Ingress' ? 0 : row.kind === 'Certificate' ? 1 : row.kind === 'Secret' ? 3 : 2;
      for (const row of [...resources].sort((a, b) => rank(a) - rank(b)))
        await writer.remove(writer.row(row), this.pollIntervalMs);
      return {
        ...removedObservation(plan, this.now()),
        resources: writer.receipts,
        completedAt: this.now().toISOString(),
      };
    });
  }
}

export { CERT_MANAGER_VERSION };
