import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { OperationRequestError, validateOperationId } from '../tasks/contracts.js';
import type { UpdateClusterNetworkingInput, UpdatePlatformSettingsInput } from './contracts.js';

export function inputRecord(
  value: unknown,
  allowed: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new OperationRequestError(422, 'NETWORKING_INPUT_INVALID', '网络配置包含无效字段。');
}

export function revision(value: unknown, initial = false): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < (initial ? 0 : 1) ||
    Number(value) > 2147483647
  )
    throw new OperationRequestError(422, 'NETWORKING_INPUT_INVALID', '网络配置版本无效。');
  return Number(value);
}

export function resourceId(value: unknown): string {
  if (typeof value !== 'string')
    throw new OperationRequestError(422, 'NETWORKING_INPUT_INVALID', '资源 ID 无效。');
  validateOperationId(value);
  return value;
}

/** Hostnames are data, never URLs or shell fragments. A trailing DNS root dot is normalized. */
export function hostname(value: unknown, singleLabel = false): string {
  if (typeof value !== 'string' || value.length > 1024)
    throw new OperationRequestError(422, 'DOMAIN_HOSTNAME_INVALID', '域名格式无效。');
  const source = value.trim().replace(/\.$/u, '');
  if (!source || /[\s/:\\?#@%*[\]]/u.test(source) || isIP(source))
    throw new OperationRequestError(
      422,
      'DOMAIN_HOSTNAME_INVALID',
      '请填写域名，不含协议、路径或通配符。',
    );
  const normalized = domainToASCII(source).toLowerCase();
  const labels = normalized.split('.');
  if (
    !normalized ||
    normalized.length > 253 ||
    (singleLabel ? labels.length !== 1 : labels.length < 2) ||
    labels.some(
      (label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    ) ||
    isIP(normalized)
  )
    throw new OperationRequestError(422, 'DOMAIN_HOSTNAME_INVALID', '域名标签或总长度无效。');
  return normalized;
}

function email(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new OperationRequestError(422, 'ACME_EMAIL_INVALID', '请填写有效的 ACME 联系邮箱。');
  const text = value.trim();
  if (text.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(text))
    throw new OperationRequestError(422, 'ACME_EMAIL_INVALID', '请填写有效的 ACME 联系邮箱。');
  const [local, domain] = text.split('@');
  if (!local || local.length > 64 || !domain)
    throw new OperationRequestError(422, 'ACME_EMAIL_INVALID', '请填写有效的 ACME 联系邮箱。');
  return `${local}@${hostname(domain)}`;
}

export function platformSettingsInput(value: unknown): UpdatePlatformSettingsInput {
  inputRecord(value, ['revision', 'appsDomainSuffix', 'acmeEmail']);
  return {
    revision: revision(value.revision, true),
    appsDomainSuffix: value.appsDomainSuffix === null ? null : hostname(value.appsDomainSuffix),
    acmeEmail: email(value.acmeEmail),
  };
}

export function normalizedAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || value.includes('%'))
    throw new OperationRequestError(422, 'NETWORK_ENTRY_INVALID', '入口地址必须为 IPv4 或 IPv6。');
  const text = value.trim();
  const family = isIP(text);
  if (!family)
    throw new OperationRequestError(422, 'NETWORK_ENTRY_INVALID', '入口地址必须为 IPv4 或 IPv6。');
  return family === 6 ? new URL(`http://[${text}]/`).hostname.slice(1, -1) : text;
}

export function clusterNetworkingInput(value: unknown): UpdateClusterNetworkingInput {
  inputRecord(value, ['revision', 'subdomain', 'entryAddresses', 'cnameTarget']);
  if (!Array.isArray(value.entryAddresses) || value.entryAddresses.length > 8)
    throw new OperationRequestError(422, 'NETWORK_ENTRY_INVALID', '最多配置 8 个入口 IP 地址。');
  const addresses = [...new Set(value.entryAddresses.map(normalizedAddress))].sort();
  const cnameTarget = value.cnameTarget === null ? null : hostname(value.cnameTarget);
  if (!addresses.length && !cnameTarget)
    throw new OperationRequestError(422, 'NETWORK_ENTRY_REQUIRED', '请提供入口 IP 或 CNAME 目标。');
  return {
    revision: revision(value.revision, true),
    subdomain: hostname(value.subdomain, true),
    entryAddresses: addresses,
    cnameTarget,
  };
}

export function clusterDomainSuffix(appsSuffix: string, subdomain: string): string {
  const result = hostname(`${subdomain}.${appsSuffix}`);
  if (result.length > 238)
    throw new OperationRequestError(
      422,
      'DOMAIN_SUFFIX_TOO_LONG',
      '后缀过长，无法分配稳定的服务域名。',
    );
  return result;
}

export function allocateHostname(slug: string, domainId: string, suffix: string): string {
  resourceId(domainId);
  const stable = domainId.replaceAll('-', '').slice(0, 12);
  const allowed = Math.min(63, 253 - suffix.length - 1) - stable.length - 1;
  if (allowed < 1)
    throw new OperationRequestError(
      422,
      'DOMAIN_SUFFIX_TOO_LONG',
      '后缀过长，无法分配稳定的服务域名。',
    );
  const prefix =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9-]/gu, '-')
      .slice(0, allowed)
      .replace(/-+$/u, '') || 's';
  return hostname(`${prefix}-${stable}.${suffix}`);
}
