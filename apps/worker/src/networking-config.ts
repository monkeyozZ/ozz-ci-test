import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { ConfigurationError, type RuntimeConfig } from '@ozz/config';
import type { LocalAcmeTestConfiguration } from '@ozz/infrastructure/networking';

function localAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/gu, '').toLowerCase();
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    return (
      parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    );
  }
  return isIP(address) === 6 && (address === '::1' || /^f[cd]/u.test(address));
}

function acmeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      localAddress(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/dir'
    );
  } catch {
    return false;
  }
}

function nameserver(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 80) return false;
  if (localAddress(value)) return true;
  const match = value.match(/^(\[[a-f0-9:]+\]|[0-9.]+):(\d{1,5})$/iu);
  return Boolean(
    match && localAddress(match[1]!) && Number(match[2]) > 0 && Number(match[2]) <= 65535,
  );
}

/** Test roots are passed to one adapter only. No global TLS or DNS trust is changed. */
export async function readLocalAcmeConfiguration(
  config: Pick<RuntimeConfig, 'nodeEnv' | 'networkLocalAcmeConfigFile'>,
): Promise<LocalAcmeTestConfiguration | undefined> {
  if (!config.networkLocalAcmeConfigFile) return undefined;
  if (config.nodeEnv === 'production')
    throw new ConfigurationError('Local ACME configuration is not allowed in production');
  try {
    const file = await open(
      config.networkLocalAcmeConfigFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let text: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0)
        throw new Error('shape');
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).some(
        (key) =>
          !['version', 'stagingUrl', 'productionUrl', 'caBundle', 'solverNameservers'].includes(
            key,
          ),
      ) ||
      (data.version !== undefined && data.version !== 1) ||
      !acmeUrl(data.stagingUrl) ||
      !acmeUrl(data.productionUrl) ||
      data.stagingUrl === data.productionUrl ||
      typeof data.caBundle !== 'string' ||
      !Array.isArray(data.solverNameservers) ||
      data.solverNameservers.length < 1 ||
      data.solverNameservers.length > 4 ||
      !data.solverNameservers.every(nameserver)
    )
      throw new Error('shape');
    const certificate = new X509Certificate(data.caBundle);
    const now = Date.now();
    if (
      !certificate.ca ||
      data.caBundle.includes('PRIVATE KEY') ||
      (data.caBundle.match(/-----BEGIN CERTIFICATE-----/gu)?.length ?? 0) !== 1 ||
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) <= now
    )
      throw new Error('trust');
    return {
      stagingUrl: data.stagingUrl,
      productionUrl: data.productionUrl,
      caBundle: data.caBundle,
      solverNameservers: data.solverNameservers as string[],
    };
  } catch {
    throw new ConfigurationError(
      'Invalid local ACME test configuration; use a protected fixture file with private HTTPS endpoints and its explicit CA',
    );
  }
}
