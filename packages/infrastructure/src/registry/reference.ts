import { isIP } from 'node:net';
import {
  RegistryAdapterError,
  type ImagePlatform,
  type ParsedImageReference,
} from './contracts.js';

export const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const dockerAliases = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const repositoryComponent = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;

export function normalizeRegistry(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300)
    throw new RegistryAdapterError('REGISTRY_REFERENCE_INVALID');
  try {
    if (value.includes('/') || value.includes('?') || value.includes('#') || value.includes('@'))
      throw new Error();
    const url = new URL(`https://${value}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      value.trim() !== value ||
      !/^[A-Za-z0-9.:[\]-]+$/u.test(value)
    )
      throw new Error();
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    if (
      !isIP(hostname) &&
      (hostname.length > 253 ||
        hostname.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)))
    )
      throw new Error();
    if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error();
    return dockerAliases.has(url.host) ? 'docker.io' : url.host;
  } catch {
    throw new RegistryAdapterError('REGISTRY_REFERENCE_INVALID');
  }
}

export function registryOrigin(registry: string): string {
  return registry === 'docker.io' ? 'https://registry-1.docker.io' : `https://${registry}`;
}

export function parseImageReference(value: string): ParsedImageReference {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\s\\?#%]/u.test(value) ||
    value.includes('://')
  )
    throw new RegistryAdapterError('REGISTRY_REFERENCE_INVALID');
  const [image, digest, extra] = value.split('@');
  if (!image || extra !== undefined || (digest !== undefined && !SHA256.test(digest)))
    throw new RegistryAdapterError('REGISTRY_REFERENCE_INVALID');
  const parts = image.split('/');
  const first = parts[0]!;
  const hasRegistry =
    parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = hasRegistry ? normalizeRegistry(parts.shift()!) : 'docker.io';
  let path = parts.join('/');
  let tag: string | null = null;
  const colon = path.lastIndexOf(':');
  if (colon !== -1) {
    tag = path.slice(colon + 1);
    path = path.slice(0, colon);
    if (!tagPattern.test(tag)) throw new RegistryAdapterError('REGISTRY_REFERENCE_INVALID');
  }
  if (registry === 'docker.io' && !path.includes('/')) path = `library/${path}`;
  if (path.length > 255 || path.split('/').some((part) => !repositoryComponent.test(part)))
    throw new RegistryAdapterError('REGISTRY_REFERENCE_INVALID');
  if (tag === null && digest === undefined) tag = 'latest';
  return Object.freeze({
    input: value,
    registry,
    apiOrigin: registryOrigin(registry),
    repository: path,
    tag,
    digest: digest ?? null,
    reference: digest ?? tag!,
  });
}

export function platforms(values: readonly ImagePlatform[]): ImagePlatform[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16)
    throw new RegistryAdapterError('REGISTRY_PLATFORM_UNSUPPORTED');
  const result = new Map<string, ImagePlatform>();
  for (const value of values) {
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).some((key) => !['os', 'architecture', 'variant'].includes(key)) ||
      value.os !== 'linux' ||
      !['amd64', 'arm64'].includes(value.architecture) ||
      (value.variant !== undefined &&
        (typeof value.variant !== 'string' || !/^v[1-9][0-9]?$/u.test(value.variant)))
    )
      throw new RegistryAdapterError('REGISTRY_PLATFORM_UNSUPPORTED');
    const normalized: ImagePlatform = {
      os: value.os,
      architecture: value.architecture,
      ...(value.variant ? { variant: value.variant } : {}),
    };
    result.set(`${value.os}/${value.architecture}/${baselineVariant(normalized)}`, normalized);
  }
  return [...result.values()].sort((a, b) =>
    `${a.os}/${a.architecture}/${baselineVariant(a)}`.localeCompare(
      `${b.os}/${b.architecture}/${baselineVariant(b)}`,
    ),
  );
}

export function baselineVariant(platform: ImagePlatform): string {
  return platform.variant ?? (platform.architecture === 'arm64' ? 'v8' : 'v1');
}

export function samePlatform(
  actual: { os?: unknown; architecture?: unknown; variant?: unknown },
  expected: ImagePlatform,
): boolean {
  return (
    actual.os === expected.os &&
    actual.architecture === expected.architecture &&
    (actual.variant ?? (expected.architecture === 'arm64' ? 'v8' : 'v1')) ===
      baselineVariant(expected)
  );
}
