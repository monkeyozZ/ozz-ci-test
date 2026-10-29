import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { parseDocument, visit } from 'yaml';
import { hasControlCharacters } from './text.js';
import {
  KubernetesAdapterError,
  type CertificateSummary,
  type KubernetesCredentialSummary,
  type ParseKubeconfigOptions,
  type ParsedKubernetesConnection,
} from './contracts.js';

export interface ConnectionMaterial {
  ca: string;
  certificate?: string;
  privateKey?: string;
  token?: string;
}

const materialByConnection = new WeakMap<ParsedKubernetesConnection, ConnectionMaterial>();
const MAX_CONFIG_BYTES = 256 * 1024;

function invalid(): never {
  throw new KubernetesAdapterError('KUBECONFIG_INVALID');
}

function unsupported(): never {
  throw new KubernetesAdapterError('KUBECONFIG_UNSUPPORTED');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) unsupported();
}

function string(value: unknown, max = 1024): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    hasControlCharacters(value)
  )
    invalid();
  return value;
}

function entries(value: unknown, childName: string): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) invalid();
  const result = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const entry = record(item);
    keys(entry, ['name', childName]);
    const name = string(entry.name, 253);
    if (result.has(name)) invalid();
    result.set(name, record(entry[childName]));
  }
  return result;
}

function decodePem(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length > maxBytes * 2) invalid();
  const encoded = value.replace(/[ \t\r\n]/gu, '');
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    invalid();
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length > maxBytes || decoded.toString('base64') !== encoded) invalid();
  const pem = decoded.toString('utf8');
  if (!Buffer.from(pem).equals(decoded)) invalid();
  return pem;
}

function certificates(pem: string): X509Certificate[] {
  const pattern = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n \t]+-----END CERTIFICATE-----/gu;
  const matches = [...pem.matchAll(pattern)].map((match) => match[0]);
  if (matches.length === 0 || matches.length > 8 || pem.replace(pattern, '').trim() !== '')
    invalid();
  return matches.map((value) => new X509Certificate(value));
}

function summary(certificate: X509Certificate): CertificateSummary {
  const notBefore = new Date(certificate.validFrom);
  const expiresAt = new Date(certificate.validTo);
  if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(expiresAt.getTime())) invalid();
  return Object.freeze({
    fingerprint: `SHA256:${createHash('sha256').update(certificate.raw).digest('hex')}`,
    notBefore: notBefore.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
}

function tokenTimes(token: string): { expiresAt: string | null; notBefore: string | null } {
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1] || segments[1].length > 8192)
    return { expiresAt: null, notBefore: null };
  try {
    const claims = record(JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')));
    const time = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      const date = new Date(value * 1000);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };
    return { expiresAt: time(claims.exp), notBefore: time(claims.nbf) };
  } catch {
    return { expiresAt: null, notBefore: null };
  }
}

function parseEndpoint(value: unknown): string {
  const text = string(value, 2048);
  const url = new URL(text);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/') ||
    text.includes('\\')
  )
    unsupported();
  return url.origin;
}

/** Parses data, never loads files, launches an authenticator, or changes a global context. */
export function parseKubeconfig(
  raw: string,
  options: ParseKubeconfigOptions = {},
): ParsedKubernetesConnection {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_CONFIG_BYTES || !raw.trim())
      invalid();
    const document = parseDocument(raw, {
      schema: 'core',
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      customTags: [],
    });
    if (document.errors.length || document.warnings.length) invalid();
    visit(document, {
      Alias: () => unsupported(),
      Node: (_key, _node, path) => {
        if (path.length > 12) invalid();
      },
    });
    const root = record(document.toJS({ maxAliasCount: 0 }));
    keys(root, [
      'apiVersion',
      'kind',
      'preferences',
      'clusters',
      'users',
      'contexts',
      'current-context',
    ]);
    if (root.apiVersion !== 'v1' || root.kind !== 'Config') invalid();
    if (root.preferences !== undefined && Object.keys(record(root.preferences)).length)
      unsupported();
    const clusterEntries = entries(root.clusters, 'cluster');
    const userEntries = entries(root.users, 'user');
    const contextEntries = entries(root.contexts, 'context');

    // Validate every entry, including unused contexts. A saved config must never
    // become executable after a future context switch or SDK update.
    const clusters = new Map<
      string,
      { endpoint: string; ca: string; certificates: X509Certificate[] }
    >();
    for (const [name, cluster] of clusterEntries) {
      keys(cluster, ['server', 'certificate-authority-data', 'insecure-skip-tls-verify']);
      if (
        cluster['insecure-skip-tls-verify'] !== undefined &&
        cluster['insecure-skip-tls-verify'] !== false
      )
        unsupported();
      const endpoint = parseEndpoint(cluster.server);
      const ca = decodePem(cluster['certificate-authority-data'], 64 * 1024);
      const bundle = certificates(ca);
      if (bundle.some((certificate) => !certificate.ca)) invalid();
      clusters.set(name, { endpoint, ca, certificates: bundle });
    }

    const users = new Map<
      string,
      {
        material: Omit<ConnectionMaterial, 'ca'>;
        credential: Omit<KubernetesCredentialSummary, 'caCertificates'>;
      }
    >();
    for (const [name, user] of userEntries) {
      keys(user, ['client-certificate-data', 'client-key-data', 'token']);
      const hasToken = user.token !== undefined;
      const hasCertificate =
        user['client-certificate-data'] !== undefined || user['client-key-data'] !== undefined;
      if (hasToken === hasCertificate) invalid();
      if (hasToken) {
        const token = string(user.token, 16 * 1024);
        if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(token)) invalid();
        const times = tokenTimes(token);
        users.set(name, {
          material: { token },
          credential: {
            authentication: 'token',
            clientCertificate: null,
            ...times,
            expirationSource: times.expiresAt ? 'token_claim' : 'unknown',
          },
        });
      } else {
        const certificate = decodePem(user['client-certificate-data'], 64 * 1024);
        const privateKey = decodePem(user['client-key-data'], 16 * 1024);
        if (
          !/^\s*-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[A-Za-z0-9+/=\r\n \t]+-----END (?:RSA |EC )?PRIVATE KEY-----\s*$/u.test(
            privateKey,
          )
        )
          invalid();
        const leaf = certificates(certificate)[0]!;
        const key = createPrivateKey({ key: privateKey, format: 'pem' });
        if (!leaf.checkPrivateKey(key)) invalid();
        const clientCertificate = summary(leaf);
        users.set(name, {
          material: { certificate, privateKey },
          credential: {
            authentication: 'client_certificate',
            clientCertificate,
            expiresAt: clientCertificate.expiresAt,
            notBefore: clientCertificate.notBefore,
            expirationSource: 'client_certificate',
          },
        });
      }
    }

    for (const context of contextEntries.values()) {
      keys(context, ['cluster', 'user', 'namespace']);
      if (!clusters.has(string(context.cluster, 253)) || !users.has(string(context.user, 253)))
        invalid();
      if (
        context.namespace !== undefined &&
        !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(string(context.namespace, 63))
      )
        invalid();
    }
    const selected = contextEntries.get(string(root['current-context'], 253));
    if (!selected) invalid();
    const cluster = clusters.get(selected.cluster as string)!;
    const user = users.get(selected.user as string)!;
    const caCertificates = Object.freeze(cluster.certificates.map(summary));
    const fingerprints = [...new Set(caCertificates.map((value) => value.fingerprint))].sort();
    const caFingerprint =
      fingerprints.length === 1
        ? fingerprints[0]!
        : `SHA256:${createHash('sha256').update(fingerprints.join('\n')).digest('hex')}`;
    const connection = Object.freeze({
      endpoint:
        options.endpointOverride === undefined
          ? cluster.endpoint
          : parseEndpoint(options.endpointOverride),
      caFingerprint,
      credential: Object.freeze({ ...user.credential, caCertificates }),
    });
    materialByConnection.set(connection, { ca: cluster.ca, ...user.material });
    return connection;
  } catch (error) {
    if (error instanceof KubernetesAdapterError) throw error;
    // YAML and OpenSSL exceptions can contain source text or PEM fragments.
    throw new KubernetesAdapterError('KUBECONFIG_INVALID');
  }
}

export function connectionMaterial(connection: ParsedKubernetesConnection): ConnectionMaterial {
  const material = materialByConnection.get(connection);
  if (!material) invalid();
  return material;
}

export function verifyCredentialTime(connection: ParsedKubernetesConnection, now: Date): void {
  const time = now.getTime();
  const { credential } = connection;
  if (!Number.isFinite(time)) invalid();
  // The CA bundle may include an old CA during rotation. At least one trusted CA
  // must be currently valid; TLS still validates the chain actually presented.
  const validCa = credential.caCertificates.some(
    (ca) => Date.parse(ca.notBefore) <= time && Date.parse(ca.expiresAt) > time,
  );
  if (!validCa) {
    throw new KubernetesAdapterError(
      credential.caCertificates.every((ca) => Date.parse(ca.notBefore) > time)
        ? 'KUBERNETES_CREDENTIAL_NOT_YET_VALID'
        : 'KUBERNETES_CREDENTIAL_EXPIRED',
    );
  }
  // A JWT's decoded claims are informational, not an authenticated verdict.
  // The API owns token verification and clock-skew policy; comparing its newly
  // issued nbf against the control-plane clock can reject a valid credential.
  if (credential.authentication === 'client_certificate') {
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= time)
      throw new KubernetesAdapterError('KUBERNETES_CREDENTIAL_EXPIRED');
    if (credential.notBefore && Date.parse(credential.notBefore) > time)
      throw new KubernetesAdapterError('KUBERNETES_CREDENTIAL_NOT_YET_VALID');
  }
}
