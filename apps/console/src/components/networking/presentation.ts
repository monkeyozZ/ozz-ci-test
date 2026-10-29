import type { Domain, NetworkStatus } from './types';

const unobserved: NetworkStatus = { label: '尚未检查', tone: 'neutral' };

export function dnsStatus(dns: Domain['dns']): NetworkStatus {
  if (!dns) return unobserved;
  return {
    unconfigured: { label: '入口未配置', tone: 'warning' },
    matched: { label: '记录匹配', tone: 'good' },
    mismatch: { label: '记录不匹配', tone: 'danger' },
    not_found: { label: '未找到记录', tone: 'warning' },
    error: { label: '检查失败', tone: 'danger' },
  }[dns.state] as NetworkStatus;
}

export function routeStatus(route: Domain['route']): NetworkStatus {
  if (!route) return unobserved;
  return {
    pending: { label: '等待同步', tone: 'primary' },
    ready: { label: '后端已就绪', tone: 'good' },
    backend_pending: { label: '等待后端', tone: 'warning' },
    missing: { label: '路由缺失', tone: 'danger' },
    drifted: { label: '路由有差异', tone: 'danger' },
    unknown: { label: '状态未知', tone: 'warning' },
    removed: { label: '已移除', tone: 'neutral' },
  }[route.state] as NetworkStatus;
}

export function certificateStatus(
  certificate: Domain['certificate'],
  now = Date.now(),
): NetworkStatus {
  if (!certificate) return unobserved;
  const endsAt = certificate.notAfter ? Date.parse(certificate.notAfter) : NaN;
  const startsAt = certificate.notBefore ? Date.parse(certificate.notBefore) : NaN;
  if (
    !['removed', 'missing'].includes(certificate.state) &&
    Number.isFinite(endsAt) &&
    endsAt <= now
  )
    return { label: '证书已过期', tone: 'danger' };
  if (certificate.state === 'ready' || certificate.state === 'staging_ready') {
    if (certificate.authority === 'local_test') return { label: '本地测试证书', tone: 'warning' };
    if (certificate.environment === 'staging' || certificate.state === 'staging_ready')
      return { label: '测试证书就绪', tone: 'warning' };
    if (certificate.authority !== 'letsencrypt')
      return { label: '签发来源待确认', tone: 'warning' };
    if (!Number.isFinite(endsAt)) return { label: '有效期待确认', tone: 'warning' };
    if (Number.isFinite(startsAt) && startsAt > now)
      return { label: '证书尚未生效', tone: 'warning' };
    return { label: '正式证书有效', tone: 'good' };
  }
  return {
    pending: { label: '等待申请', tone: 'primary' },
    issuing: { label: '正在签发', tone: 'primary' },
    renewing: { label: '正在续期', tone: 'warning' },
    failed: { label: '签发或续期失败', tone: 'danger' },
    expired: { label: '证书已过期', tone: 'danger' },
    missing: { label: '证书缺失', tone: 'danger' },
    unknown: { label: '状态未知', tone: 'warning' },
    removed: { label: '已移除', tone: 'neutral' },
  }[certificate.state] as NetworkStatus;
}

export function certificateEnvironmentLabel(environment: 'staging' | 'production') {
  return environment === 'production' ? 'ACME production' : 'ACME staging · 测试证书';
}

export function certificateAuthorityLabel(certificate: Domain['certificate']) {
  if (certificate?.authority === 'letsencrypt') return "Let's Encrypt";
  if (certificate?.authority === 'local_test') return '本地测试 CA';
  return '来源待确认';
}

/** A last known Ready value does not prove that an expired or stale entry is usable. */
export function publicHttpsUrl(domain: Domain, now = Date.now()): string | null {
  if (
    domain.desiredState !== 'active' ||
    domain.observationStale ||
    domain.dns?.state !== 'matched' ||
    domain.route?.state !== 'ready' ||
    domain.certificateEnvironment !== 'production' ||
    domain.certificate?.environment !== 'production' ||
    domain.certificate?.authority !== 'letsencrypt' ||
    certificateStatus(domain.certificate, now).tone !== 'good'
  )
    return null;
  return `https://${domain.hostname}`;
}

export function domainServiceLocation(domain: Domain, tab = 'network') {
  return {
    path: `/projects/${domain.project.id}/services/${domain.serviceId}`,
    query: { environment: domain.environment.slug, tab },
  };
}

export function networkingSettingsLocation(clusterId?: string) {
  return {
    path: '/settings',
    query: { tab: 'network', ...(clusterId ? { clusterId } : {}) },
  };
}
