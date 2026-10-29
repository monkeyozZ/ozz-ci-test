import { generateKeyPair } from 'node:crypto';
import type {
  LocalAcmeTestConfiguration,
  ManagedNetworkResource,
  NetworkDomainPlan,
  NetworkResourceDescriptor,
} from './contracts.js';
import { descriptor, keys, ownership, type Resource } from './resources.js';

export const ACME_SERVERS = {
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  production: 'https://acme-v02.api.letsencrypt.org/directory',
} as const;

export function networkingNames(target: Pick<NetworkDomainPlan['target'], 'domainId'>) {
  const id = target.domainId.replaceAll('-', '');
  return {
    httpIngress: `ozz-d-${id}-http`,
    httpsIngress: `ozz-d-${id}-https`,
    certificate: `ozz-d-${id}`,
    tlsSecret: `ozz-t-${id}`,
    redirect: `ozz-d-${id}-redirect`,
    stagingIssuer: 'ozz-acme-staging',
    productionIssuer: 'ozz-acme-production',
    stagingAccount: 'ozz-acme-staging-account',
    productionAccount: 'ozz-acme-production-account',
  };
}

export function domainResources(
  plan: NetworkDomainPlan,
): Record<
  'http' | 'https' | 'redirect' | 'certificate' | 'tls' | 'issuer' | 'account',
  NetworkResourceDescriptor
> {
  const names = networkingNames(plan.target);
  const row = (
    apiVersion: string,
    kind: string,
    name: string,
    role: string,
    scope: 'domain' | 'environment' = 'domain',
  ) =>
    descriptor(
      { apiVersion, kind, metadata: { name, namespace: plan.target.namespace } },
      role,
      scope,
    );
  return {
    http: row('networking.k8s.io/v1', 'Ingress', names.httpIngress, 'http'),
    https: row('networking.k8s.io/v1', 'Ingress', names.httpsIngress, 'https'),
    redirect: row('traefik.io/v1alpha1', 'Middleware', names.redirect, 'redirect'),
    certificate: row('cert-manager.io/v1', 'Certificate', names.certificate, 'certificate'),
    tls: row('v1', 'Secret', names.tlsSecret, 'tls'),
    issuer: row(
      'cert-manager.io/v1',
      'Issuer',
      plan.certificateEnvironment === 'staging' ? names.stagingIssuer : names.productionIssuer,
      'issuer',
      'environment',
    ),
    account: row(
      'v1',
      'Secret',
      plan.certificateEnvironment === 'staging' ? names.stagingAccount : names.productionAccount,
      'acme_account',
      'environment',
    ),
  };
}
export function bare(row: NetworkResourceDescriptor): Resource {
  return {
    apiVersion: row.apiVersion,
    kind: row.kind,
    metadata: { name: row.name, ...(row.namespace ? { namespace: row.namespace } : {}) },
  };
}
export async function accountSecret(row: NetworkResourceDescriptor): Promise<Resource> {
  const privateKey = await new Promise<string>((resolve, reject) => {
    generateKeyPair(
      'rsa',
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      },
      (error, _publicKey, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
  return {
    ...bare(row),
    type: 'Opaque',
    data: { 'tls.key': Buffer.from(privateKey).toString('base64') },
  };
}
export function issuerManifest(
  plan: NetworkDomainPlan,
  localAcme?: LocalAcmeTestConfiguration,
): Resource {
  const rows = domainResources(plan);
  const server = localAcme
    ? plan.certificateEnvironment === 'staging'
      ? localAcme.stagingUrl
      : localAcme.productionUrl
    : ACME_SERVERS[plan.certificateEnvironment];
  return {
    ...bare(rows.issuer),
    spec: {
      acme: {
        server,
        email: plan.acmeEmail,
        privateKeySecretRef: { name: rows.account.name },
        disableAccountKeyGeneration: true,
        ...(localAcme ? { caBundle: Buffer.from(localAcme.caBundle).toString('base64') } : {}),
        solvers: [
          {
            http01: {
              ingress: {
                ingressClassName: 'traefik',
                ingressTemplate: {
                  metadata: {
                    annotations: {
                      'traefik.ingress.kubernetes.io/router.entrypoints': 'web',
                      'traefik.ingress.kubernetes.io/router.priority': '10000',
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
  };
}
export function certificateManifest(
  plan: NetworkDomainPlan,
  tls: ManagedNetworkResource,
): Resource {
  const rows = domainResources(plan);
  const owned = ownership(plan.target, tls);
  return {
    ...bare(rows.certificate),
    spec: {
      secretName: rows.tls.name,
      dnsNames: [plan.target.hostname],
      issuerRef: { name: rows.issuer.name, kind: 'Issuer', group: 'cert-manager.io' },
      privateKey: { algorithm: 'RSA', size: 2048, rotationPolicy: 'Always' },
      usages: ['digital signature', 'key encipherment'],
      revisionHistoryLimit: 1,
      // Works with short-lived local fixtures and public certificates alike.
      renewBeforePercentage: 33,
      secretTemplate: {
        labels: owned.labels,
        annotations: {
          ...owned.annotations,
          [keys.nonce]: tls.creationNonce,
          [keys.revision]: String(plan.revision),
          [keys.serviceUid]: plan.target.serviceUid,
        },
      },
    },
  };
}
export function routeManifests(plan: NetworkDomainPlan): {
  redirect: Resource;
  http: Resource;
  https: Resource;
} {
  const rows = domainResources(plan);
  const rules = [
    {
      host: plan.target.hostname,
      http: {
        paths: [
          {
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: { name: plan.target.serviceName, port: { name: plan.target.portName } },
            },
          },
        ],
      },
    },
  ];
  const ingress = (row: NetworkResourceDescriptor, tls: boolean): Resource => ({
    ...bare(row),
    metadata: {
      ...bare(row).metadata,
      annotations: {
        [keys.serviceUid]: plan.target.serviceUid,
        'traefik.ingress.kubernetes.io/router.entrypoints': tls ? 'websecure' : 'web',
        'traefik.ingress.kubernetes.io/router.priority': '1',
        ...(tls
          ? { 'traefik.ingress.kubernetes.io/router.tls': 'true' }
          : {
              'traefik.ingress.kubernetes.io/router.middlewares': `${plan.target.namespace}-${rows.redirect.name}@kubernetescrd`,
            }),
      },
    },
    spec: {
      ingressClassName: 'traefik',
      rules,
      ...(tls ? { tls: [{ hosts: [plan.target.hostname], secretName: rows.tls.name }] } : {}),
    },
  });
  return {
    redirect: {
      ...bare(rows.redirect),
      spec: { redirectScheme: { scheme: 'https', permanent: true } },
    },
    http: ingress(rows.http, false),
    https: ingress(rows.https, true),
  };
}
