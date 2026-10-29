import { createHash, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { RegistryAdapterError, type RegistryAccess } from './contracts.js';
import { normalizeRegistry, registryOrigin } from './reference.js';

export interface RegistryAccessMaterial {
  readonly registry: string;
  readonly basicAuthorization?: string;
  readonly username?: string;
  readonly password?: string;
  readonly ca?: readonly string[];
  readonly tokenOrigins: ReadonlySet<string>;
  readonly blobOrigins: ReadonlySet<string>;
}

const materials = new WeakMap<RegistryAccess, RegistryAccessMaterial>();

function invalid(): never {
  throw new RegistryAdapterError('REGISTRY_ACCESS_INVALID');
}

function origins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) invalid();
  return value.map((item) => {
    if (typeof item !== 'string' || item.length > 512 || item.trim() !== item) invalid();
    try {
      const url = new URL(item);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        /[\s\\]/u.test(item)
      )
        invalid();
      normalizeRegistry(url.host);
      return url.origin;
    } catch {
      invalid();
    }
  });
}

function caBundle(value: unknown): { ca?: readonly string[]; fingerprint: string | null } {
  if (value === undefined) return { fingerprint: null };
  if (typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1024) invalid();
  const pattern = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n \t]+-----END CERTIFICATE-----/gu;
  const pem = [...value.matchAll(pattern)].map((match) => match[0]);
  if (!pem.length || pem.length > 8 || value.replace(pattern, '').trim() !== '') invalid();
  try {
    const certificates = pem.map((text) => new X509Certificate(text));
    if (certificates.some((certificate) => !certificate.ca)) invalid();
    const digest = createHash('sha256');
    for (const certificate of certificates) digest.update(certificate.raw);
    return { ca: [...rootCertificates, ...pem], fingerprint: `SHA256:${digest.digest('hex')}` };
  } catch {
    invalid();
  }
}

function defaults(registry: string) {
  const origin = registryOrigin(registry);
  return {
    tokenOrigins: new Set([
      origin,
      ...(registry === 'docker.io' ? ['https://auth.docker.io'] : []),
    ]),
    blobOrigins: new Set([origin]),
  };
}

export function parseRegistryAccess(value: unknown): RegistryAccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          'registry',
          'username',
          'password',
          'caCertificate',
          'tokenServiceOrigins',
          'blobServiceOrigins',
        ].includes(key),
    )
  )
    invalid();
  let registry: string;
  try {
    registry = normalizeRegistry(raw.registry as string);
  } catch {
    invalid();
  }
  const authenticated = raw.username !== undefined || raw.password !== undefined;
  if (
    authenticated &&
    (typeof raw.username !== 'string' ||
      typeof raw.password !== 'string' ||
      raw.username.length === 0 ||
      raw.username.length > 1024 ||
      raw.password.length === 0 ||
      raw.password.length > 16 * 1024 ||
      /[:\p{Cc}]/u.test(raw.username) ||
      /\p{Cc}/u.test(raw.password))
  )
    invalid();
  const ca = caBundle(raw.caCertificate);
  const allowed = defaults(registry);
  for (const origin of origins(raw.tokenServiceOrigins)) allowed.tokenOrigins.add(origin);
  for (const origin of origins(raw.blobServiceOrigins)) allowed.blobOrigins.add(origin);
  const access: RegistryAccess = Object.freeze({
    registry,
    authentication: authenticated ? 'basic' : 'none',
    caFingerprint: ca.fingerprint,
  });
  materials.set(access, {
    registry,
    ...allowed,
    ...(ca.ca ? { ca: ca.ca } : {}),
    ...(authenticated
      ? {
          username: raw.username as string,
          password: raw.password as string,
          basicAuthorization: `Basic ${Buffer.from(`${raw.username}:${raw.password}`).toString('base64')}`,
        }
      : {}),
  });
  return access;
}

export function accessMaterial(registry: string, access?: RegistryAccess): RegistryAccessMaterial {
  if (!access) return { registry, ...defaults(registry) };
  const material = materials.get(access);
  if (!material) invalid();
  if (material.registry !== registry) throw new RegistryAdapterError('REGISTRY_ACCESS_MISMATCH');
  return material;
}

/**
 * Explicit secret-bearing API for the workload writer only. Never add its result
 * to image snapshots, ordinary API responses, task logs or audit metadata.
 * Additional resolver CA trust does not configure a node's container runtime.
 */
export function registryDockerConfigJson(access: RegistryAccess): string | null {
  const material = accessMaterial(access.registry, access);
  if (!material.basicAuthorization) return null;
  return JSON.stringify({
    auths: {
      [material.registry]: {
        username: material.username,
        password: material.password,
        auth: material.basicAuthorization.slice('Basic '.length),
      },
    },
  });
}

export function registryPullSecretData(
  access: RegistryAccess,
): { '.dockerconfigjson': string } | null {
  const config = registryDockerConfigJson(access);
  return config ? { '.dockerconfigjson': Buffer.from(config).toString('base64') } : null;
}
