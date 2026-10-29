import { createPrivateKey, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import type { InspectionClient } from '../kubernetes/transport.js';
import type {
  DomainCertificateObservation,
  DomainRouteObservation,
  LocalAcmeTestConfiguration,
  ManagedNetworkResource,
  NetworkDomainObservation,
  NetworkDomainPlan,
  NetworkResourceReceipt,
} from './contracts.js';
import {
  certificateManifest,
  domainResources,
  issuerManifest,
  routeManifests,
} from './manifests.js';
import {
  assertOwnership,
  contains,
  entries,
  fail,
  fields,
  keys,
  readResource,
  resourceKey,
  revision,
  safeError,
  specFingerprint,
  verifyTlsParent,
  withOwnership,
  type Resource,
} from './resources.js';

export async function verifyBackend(
  client: InspectionClient,
  plan: NetworkDomainPlan,
): Promise<Resource> {
  const target = plan.target;
  const resource = await readResource(client, {
    apiVersion: 'v1',
    kind: 'Service',
    namespace: target.namespace,
    name: target.serviceName,
  });
  if (!resource) fail('NETWORK_BACKEND_MISSING', '已发布的 Service 已消失。');
  const labels = resource.metadata.labels ?? {};
  if (
    resource.metadata.uid !== target.serviceUid ||
    resource.metadata.deletionTimestamp ||
    labels['app.kubernetes.io/managed-by'] !== 'ozz' ||
    labels['ozz.dev/installation-id'] !== target.installationId ||
    labels['ozz.dev/cluster-id'] !== target.clusterId ||
    labels['ozz.dev/project-id'] !== target.projectId ||
    labels['ozz.dev/environment-id'] !== target.environmentId ||
    labels['ozz.dev/service-id'] !== target.serviceId
  )
    fail('NETWORK_BACKEND_IDENTITY_MISMATCH', 'Service 的发布 UID 或归属已变化，请重新协调域名。');
  if (
    !entries(resource.spec?.ports).some(
      (port) => port.name === target.portName && (port.protocol ?? 'TCP') === 'TCP',
    )
  )
    fail('NETWORK_BACKEND_PORT_MISSING', '域名绑定的已发布 Service 端口已消失。');
  return resource;
}
async function readyEndpoints(client: InspectionClient, plan: NetworkDomainPlan): Promise<number> {
  const value = fields(
    await client.request(
      'GET',
      `/apis/discovery.k8s.io/v1/namespaces/${plan.target.namespace}/endpointslices?limit=101&labelSelector=${encodeURIComponent(`kubernetes.io/service-name=${plan.target.serviceName}`)}`,
    ),
  );
  const slices = entries(value.items);
  if (value.kind !== 'EndpointSliceList' || slices.length > 100 || fields(value.metadata).continue)
    fail('NETWORK_RESOURCE_LIMIT', '后端端点观察超出本次资源上限。');
  const endpoints = new Set<string>();
  for (const slice of slices) {
    const metadata = fields(slice.metadata);
    if (
      metadata.namespace !== plan.target.namespace ||
      fields(metadata.labels)['kubernetes.io/service-name'] !== plan.target.serviceName ||
      !entries(metadata.ownerReferences).some(
        (owner) =>
          owner.apiVersion === 'v1' &&
          owner.kind === 'Service' &&
          owner.name === plan.target.serviceName &&
          owner.uid === plan.target.serviceUid,
      )
    )
      fail('NETWORK_BACKEND_IDENTITY_MISMATCH', '后端端点的 Service 归属无法验证。');
    if (
      !entries(slice.ports).some(
        (port) => port.name === plan.target.portName && (port.protocol ?? 'TCP') === 'TCP',
      )
    )
      continue;
    for (const endpoint of entries(slice.endpoints)) {
      if (
        fields(endpoint.conditions).ready !== true ||
        fields(endpoint.conditions).terminating === true
      )
        continue;
      for (const address of Array.isArray(endpoint.addresses) ? endpoint.addresses : []) {
        if (typeof address !== 'string') fail('KUBERNETES_INVALID_RESPONSE', '后端端点响应无效。');
        endpoints.add(address);
      }
      if (endpoints.size > 1000) fail('NETWORK_RESOURCE_LIMIT', '后端端点数量超出本次上限。');
    }
  }
  return endpoints.size;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function publiclyTrustedChain(encoded: string, now: Date): boolean {
  try {
    const blocks =
      Buffer.from(encoded, 'base64')
        .toString('utf8')
        .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
    if (!blocks.length || blocks.length > 8) return false;
    const chain = blocks.map((block) => new X509Certificate(block));
    const roots = rootCertificates
      .map((pem) => new X509Certificate(pem))
      .filter((root) => /(?:^|\n)CN=ISRG Root X[12](?:\n|$)/u.test(root.subject));
    let current = chain[0]!;
    const used = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      if (
        Date.parse(current.validFrom) > now.getTime() ||
        Date.parse(current.validTo) <= now.getTime() ||
        used.has(current.fingerprint256)
      )
        return false;
      used.add(current.fingerprint256);
      if (
        roots.some(
          (root) =>
            Date.parse(root.validTo) > now.getTime() &&
            current.checkIssued(root) &&
            current.verify(root.publicKey),
        )
      )
        return true;
      const issuer = chain.find(
        (candidate) =>
          candidate.ca &&
          !used.has(candidate.fingerprint256) &&
          current.checkIssued(candidate) &&
          current.verify(candidate.publicKey),
      );
      if (!issuer) return false;
      current = issuer;
    }
  } catch {
    return false;
  }
  return false;
}

function ownedBy(
  resource: Record<string, unknown>,
  parent: Resource | Record<string, unknown>,
  kind: string,
  apiVersion: string,
): boolean {
  const metadata = fields(resource.metadata);
  const parentMetadata = fields(parent.metadata);
  return entries(metadata.ownerReferences).some(
    (reference) =>
      reference.apiVersion === apiVersion &&
      reference.kind === kind &&
      reference.controller === true &&
      reference.uid === parentMetadata.uid &&
      reference.name === parentMetadata.name,
  );
}
/** Follow only the current Certificate -> CertificateRequest -> Order -> Challenge owner chain. */
async function issuanceFailure(
  client: InspectionClient,
  plan: NetworkDomainPlan,
  certificate: Resource,
): Promise<{ code: string; message: string } | null> {
  const list = async (group: string, plural: string, kind: string) => {
    const response = fields(
      await client.request(
        'GET',
        `/apis/${group}/v1/namespaces/${plan.target.namespace}/${plural}?limit=101`,
      ),
    );
    const values = entries(response.items);
    if (
      response.kind !== `${kind}List` ||
      values.length > 100 ||
      fields(response.metadata).continue
    )
      fail('NETWORK_RESOURCE_LIMIT', 'ACME 诊断资源超过本次观察上限。');
    if (values.some((value) => fields(value.metadata).namespace !== plan.target.namespace))
      fail('KUBERNETES_INVALID_RESPONSE', 'ACME 诊断资源命名空间不匹配。');
    return values;
  };
  const issuer = fields(certificate.spec?.issuerRef);
  const revision = (resource: Record<string, unknown>) =>
    Number(
      fields(fields(resource.metadata).annotations)['cert-manager.io/certificate-revision'] ?? 0,
    );
  const requests = (
    await list('cert-manager.io', 'certificaterequests', 'CertificateRequest')
  ).filter(
    (resource) =>
      ownedBy(resource, certificate, 'Certificate', 'cert-manager.io/v1') &&
      contains(fields(resource.spec).issuerRef, issuer) &&
      revision(resource) >= Number(certificate.status?.revision ?? 1),
  );
  const latest = Math.max(0, ...requests.map(revision));
  const current = requests.filter((resource) => revision(resource) === latest);
  if (!current.length) return null;
  for (const request of current) {
    if (
      entries(fields(request.status).conditions).some(
        (condition) =>
          (condition.type === 'Denied' && condition.status === 'True') ||
          (condition.type === 'Ready' &&
            condition.status === 'False' &&
            ['Failed', 'Denied', 'InvalidRequest'].includes(String(condition.reason))),
      )
    )
      return {
        code: 'CERTIFICATE_REQUEST_FAILED',
        message: '当前 CertificateRequest 被拒绝或签发失败，请检查签发策略与 ACME 配置。',
      };
  }
  const orders = (await list('acme.cert-manager.io', 'orders', 'Order')).filter((order) =>
    current.some((request) => ownedBy(order, request, 'CertificateRequest', 'cert-manager.io/v1')),
  );
  if (
    orders.some((order) =>
      ['invalid', 'errored', 'expired', 'revoked', 'deactivated'].includes(
        String(fields(order.status).state),
      ),
    )
  )
    return {
      code: 'ACME_ORDER_FAILED',
      message: '当前 ACME Order 已失败，请核对签发者、域名与 HTTP-01 验证配置。',
    };
  if (!orders.length) return null;
  const challenges = (await list('acme.cert-manager.io', 'challenges', 'Challenge')).filter(
    (challenge) =>
      orders.some((order) => ownedBy(challenge, order, 'Order', 'acme.cert-manager.io/v1')),
  );
  if (
    challenges.some((challenge) =>
      ['invalid', 'errored', 'expired', 'revoked', 'deactivated'].includes(
        String(fields(challenge.status).state),
      ),
    )
  )
    return {
      code: 'ACME_CHALLENGE_FAILED',
      message: '当前 HTTP-01 challenge 验证失败，请核对 DNS 和 80 端口访问。',
    };
  // Self-check errors remain retryable, but the bounded code makes the cause visible.
  if (
    challenges.some(
      (challenge) =>
        typeof fields(challenge.status).reason === 'string' &&
        String(fields(challenge.status).reason).length > 0 &&
        fields(challenge.status).state === 'pending',
    )
  )
    return {
      code: 'ACME_CHALLENGE_SELF_CHECK_PENDING',
      message: 'HTTP-01 自检尚未通过，cert-manager 正在重试；请核对域名解析和 80 端口。',
    };
  return null;
}
export async function observeDomain(
  client: InspectionClient,
  plan: NetworkDomainPlan,
  now: Date,
  localAcme?: LocalAcmeTestConfiguration,
): Promise<NetworkDomainObservation> {
  const rows = domainResources(plan);
  const route: DomainRouteObservation = {
    state: 'pending',
    observedAt: now.toISOString(),
    ingressNames: [rows.http.name, rows.https.name],
    backendServiceName: plan.target.serviceName,
    portName: plan.target.portName,
    readyEndpoints: null,
    code: null,
    message: '正在等待路由观察。',
  };
  const certificate: DomainCertificateObservation = {
    authority: 'unknown',
    state: 'pending',
    observedAt: now.toISOString(),
    environment: plan.certificateEnvironment,
    certificateName: rows.certificate.name,
    issuerName: rows.issuer.name,
    notBefore: null,
    notAfter: null,
    renewalTime: null,
    code: null,
    message: '正在等待证书签发。',
  };
  const inventory = new Map(plan.inventory.map((row) => [resourceKey(row), row]));
  const actuals = new Map<string, Resource>();
  const errors = new Map<string, string>();
  const verifiedResources: NetworkResourceReceipt[] = [];
  const verify = async (name: keyof typeof rows) => {
    const descriptor = rows[name];
    const row = inventory.get(resourceKey(descriptor));
    if (!row) {
      errors.set(name, 'NETWORK_RESOURCE_MISSING');
      return;
    }
    try {
      const actual = await readResource(client, row);
      if (!actual) {
        errors.set(name, 'NETWORK_RESOURCE_MISSING');
        return;
      }
      assertOwnership(
        plan.target,
        row,
        actual,
        row.scope === 'domain' ? plan.revision : plan.platformRevision,
      );
      await verifyTlsParent(client, plan.target, plan.inventory, row, actual, plan.revision);
      if (actual.metadata.deletionTimestamp)
        fail('NETWORK_RESOURCE_DELETING', '网络资源正在删除。');
      if (
        row.specFingerprint &&
        revision(actual) === row.revision &&
        specFingerprint(actual, row) !== row.specFingerprint
      )
        fail('NETWORK_RESOURCE_DRIFT', '网络资源配置与原回执不一致。');
      actuals.set(name, actual);
      verifiedResources.push({
        ...descriptor,
        action: 'verified',
        creationNonce: row.creationNonce,
        uid: actual.metadata.uid!,
        resourceVersion: actual.metadata.resourceVersion!,
        revision: revision(actual),
        specFingerprint: specFingerprint(actual, row),
        observedAt: now.toISOString(),
      });
    } catch (error) {
      errors.set(name, safeError(error).code);
    }
  };
  // Named reads are bounded; a partial/forbidden read never fabricates readiness.
  for (const name of Object.keys(rows) as Array<keyof typeof rows>) await verify(name);
  const desiredRoutes = routeManifests(plan);
  for (const name of ['http', 'https', 'redirect'] as const) {
    const actual = actuals.get(name);
    const row = inventory.get(resourceKey(rows[name]));
    if (
      actual &&
      row &&
      !contains(actual, withOwnership(desiredRoutes[name], plan.target, row, plan.revision))
    )
      errors.set(name, 'NETWORK_RESOURCE_DRIFT');
  }
  try {
    await verifyBackend(client, plan);
    route.readyEndpoints = await readyEndpoints(client, plan);
    const code = ['http', 'https', 'redirect'].map((name) => errors.get(name)).find(Boolean);
    if (code) {
      route.code = code;
      route.state =
        code === 'NETWORK_RESOURCE_MISSING'
          ? 'missing'
          : code.startsWith('NETWORK_RESOURCE_')
            ? 'drifted'
            : 'unknown';
      route.message =
        route.state === 'missing'
          ? '路由资源尚未创建或已消失。'
          : '路由身份、配置或观察权限需要检查。';
    } else if (route.readyEndpoints === 0) {
      route.state = 'backend_pending';
      route.code = 'NETWORK_NO_READY_ENDPOINTS';
      route.message = '路由已配置，等待已发布 Service 的就绪端点。';
    } else {
      const admitted = ['http', 'https'].every(
        (name) => entries(fields(actuals.get(name)?.status?.loadBalancer).ingress).length > 0,
      );
      route.state = admitted ? 'ready' : 'pending';
      route.message = admitted
        ? '路由资源与就绪端点已核对；公网可达性需另行验证。'
        : '路由已配置，等待 Ingress 控制器接纳。';
    }
  } catch (error) {
    const safe = safeError(error);
    route.code = safe.code;
    route.state = safe.code.startsWith('NETWORK_BACKEND_') ? 'drifted' : 'unknown';
    route.message = safe.message;
  }
  const cert = actuals.get('certificate');
  const issuer = actuals.get('issuer');
  const tls = actuals.get('tls');
  const issuerRow = inventory.get(resourceKey(rows.issuer));
  const certificateRow = inventory.get(resourceKey(rows.certificate));
  const tlsRow = inventory.get(resourceKey(rows.tls));
  if (
    issuer &&
    issuerRow &&
    !contains(
      issuer,
      withOwnership(issuerManifest(plan, localAcme), plan.target, issuerRow, plan.platformRevision),
    )
  )
    errors.set('issuer', 'NETWORK_RESOURCE_DRIFT');
  if (
    cert &&
    certificateRow &&
    tlsRow &&
    !contains(
      cert,
      withOwnership(certificateManifest(plan, tlsRow), plan.target, certificateRow, plan.revision),
    )
  )
    errors.set('certificate', 'NETWORK_RESOURCE_DRIFT');
  const certificateError = ['certificate', 'issuer', 'account', 'tls']
    .map((name) => errors.get(name))
    .find((code) => code && code !== 'NETWORK_RESOURCE_MISSING');
  if (certificateError) {
    certificate.state = 'unknown';
    certificate.code = certificateError;
    certificate.message = '证书资源身份、配置或观察权限需要检查。';
  } else if (!cert || !issuer || !actuals.has('account') || (!tls && tlsRow?.uid)) {
    certificate.state = 'missing';
    certificate.code = 'NETWORK_RESOURCE_MISSING';
    certificate.message = '证书、签发者或已登记的 Secret 尚未创建或已消失。';
  } else {
    certificate.authority = localAcme ? 'local_test' : 'letsencrypt';
    certificate.notBefore = timestamp(cert.status?.notBefore);
    certificate.notAfter = timestamp(cert.status?.notAfter);
    certificate.renewalTime = timestamp(cert.status?.renewalTime);
    const conditions = entries(cert.status?.conditions);
    const current = (condition: Record<string, unknown>) =>
      condition.observedGeneration === cert.metadata.generation;
    const ready = conditions.some(
      (condition) =>
        condition.type === 'Ready' && condition.status === 'True' && current(condition),
    );
    const issuing = conditions.some(
      (condition) =>
        condition.type === 'Issuing' && condition.status === 'True' && current(condition),
    );
    const failed = conditions.some(
      (condition) =>
        condition.type === 'Ready' &&
        condition.status === 'False' &&
        current(condition) &&
        ['Failed', 'Denied', 'InvalidRequest'].includes(String(condition.reason)),
    );
    let valid = false;
    let publicTrustUnverified = false;
    let invalidSecret = false;
    if (tls) {
      try {
        const pem = fields(tls.data)['tls.crt'];
        const privatePem = fields(tls.data)['tls.key'];
        if (
          typeof pem !== 'string' ||
          pem.length > 128 * 1024 ||
          typeof privatePem !== 'string' ||
          privatePem.length > 64 * 1024 ||
          tls.type !== 'kubernetes.io/tls'
        )
          throw new Error();
        const leaf = new X509Certificate(Buffer.from(pem, 'base64'));
        if (!leaf.checkPrivateKey(createPrivateKey(Buffer.from(privatePem, 'base64'))))
          throw new Error();
        valid =
          leaf.checkHost(plan.target.hostname, { wildcards: false, subject: 'never' }) ===
            plan.target.hostname &&
          Date.parse(leaf.validFrom) <= now.getTime() &&
          Date.parse(leaf.validTo) > now.getTime() &&
          leaf.validFromDate.toISOString() === certificate.notBefore &&
          leaf.validToDate.toISOString() === certificate.notAfter;
        if (
          valid &&
          !localAcme &&
          plan.certificateEnvironment === 'production' &&
          !publiclyTrustedChain(pem, now)
        ) {
          valid = false;
          publicTrustUnverified = true;
          certificate.authority = 'unknown';
        }
      } catch {
        valid = false;
        invalidSecret = true;
      }
    }
    if (certificate.notAfter && Date.parse(certificate.notAfter) <= now.getTime()) {
      certificate.state = 'expired';
      certificate.code = 'CERTIFICATE_EXPIRED';
      certificate.message = '证书已过期。';
    } else if (issuing) {
      certificate.state = valid ? 'renewing' : 'issuing';
      certificate.message = valid ? '证书有效，正在续期。' : '正在完成 ACME HTTP-01 签发。';
    } else if (failed) {
      certificate.state = 'failed';
      certificate.code = 'CERTIFICATE_ISSUANCE_FAILED';
      certificate.message = '证书签发失败，请核对 DNS、HTTP-01 路由与签发者状态。';
    } else if (
      ready &&
      valid &&
      revision(tls!) === plan.revision &&
      tls!.metadata.annotations?.[keys.serviceUid] === plan.target.serviceUid
    ) {
      certificate.state = plan.certificateEnvironment === 'staging' ? 'staging_ready' : 'ready';
      certificate.message = localAcme
        ? '本地测试证书已签发；不代表公网信任。'
        : plan.certificateEnvironment === 'staging'
          ? 'Let’s Encrypt staging 证书已签发；可继续生产签发。'
          : 'Let’s Encrypt 生产证书已签发。';
    } else {
      certificate.state = 'pending';
      certificate.message = '等待当前版本的证书、TLS Secret 与签发状态一致。';
    }
    if (publicTrustUnverified) {
      certificate.code = 'CERTIFICATE_PUBLIC_TRUST_UNVERIFIED';
      certificate.message = '证书尚未通过 Let’s Encrypt 生产证书链校验。';
    }
    if (invalidSecret) {
      certificate.code = 'CERTIFICATE_SECRET_INVALID';
      certificate.message = 'TLS Secret 中的证书或密钥无法验证，正在等待 cert-manager 修复。';
    }
    if (!ready || issuing) {
      try {
        const diagnostic = await issuanceFailure(client, plan, cert);
        if (diagnostic) {
          certificate.code = diagnostic.code;
          certificate.message = diagnostic.message;
          if (
            diagnostic.code !== 'ACME_CHALLENGE_SELF_CHECK_PENDING' &&
            certificate.state !== 'expired'
          )
            certificate.state = valid ? 'renewing' : 'failed';
        }
      } catch (error) {
        const safe = safeError(error);
        certificate.code = safe.code;
        certificate.message = '当前 ACME 父资源链无法完整观察，请核对读取权限或稍后重试。';
      }
    }
  }
  // Do not upgrade the ledger with a receipt for a resource whose desired configuration failed verification.
  return {
    route,
    certificate,
    verifiedResources: verifiedResources.filter(
      (receipt) =>
        ![...errors.keys()].some(
          (name) => resourceKey(rows[name as keyof typeof rows]) === resourceKey(receipt),
        ),
    ),
  };
}

export function removedObservation(plan: NetworkDomainPlan, now: Date): NetworkDomainObservation {
  const rows = domainResources(plan);
  return {
    route: {
      state: 'removed',
      observedAt: now.toISOString(),
      ingressNames: [],
      backendServiceName: plan.target.serviceName,
      portName: plan.target.portName,
      readyEndpoints: null,
      code: null,
      message: '域名路由已移除。',
    },
    certificate: {
      authority: 'unknown',
      state: 'removed',
      observedAt: now.toISOString(),
      environment: plan.certificateEnvironment,
      certificateName: rows.certificate.name,
      issuerName: rows.issuer.name,
      notBefore: null,
      notAfter: null,
      renewalTime: null,
      code: null,
      message: '域名证书资源已移除。',
    },
  };
}

export function observePlan(
  plan: NetworkDomainPlan,
  inventory: Iterable<ManagedNetworkResource>,
): NetworkDomainPlan {
  return { ...plan, inventory: [...inventory] };
}
