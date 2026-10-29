import { describe, expect, it } from 'vitest';
import {
  certificateStatus,
  dnsStatus,
  publicHttpsUrl,
  routeStatus,
} from '../../src/components/networking/presentation';
import {
  domainOperationInput,
  serviceOperationInput,
} from '../../src/components/infrastructure/operation-presentation';
import type { Domain } from '../../src/components/networking/types';
import type { Operation } from '../../src/lib/types';

const now = Date.parse('2026-10-26T08:00:00Z');
const domain = {
  id: 'c5a9f029-e1c7-4b63-ae11-3acb7736fba1',
  hostname: 'web-stable.lab.apps.example.test',
  kind: 'default',
  serviceId: '6d87d601-4bd8-4451-8ada-16fe914dbc3a',
  serviceName: 'Test web',
  servicePort: {
    id: '31f4d7aa-389c-4ed1-a4c9-84a027df6d46',
    name: 'web',
    protocol: 'http',
    containerPort: 3000,
    servicePort: 80,
    publishedConfigRevision: 7,
  },
  project: { id: 'project-test', name: 'Test project', slug: 'test' },
  environment: { id: 'environment-test', name: 'Test environment', slug: 'staging' },
  cluster: { id: 'cluster-test', name: 'Test cluster', slug: 'lab' },
  revision: 2,
  desiredState: 'active',
  certificateEnvironment: 'production',
  dns: {
    state: 'matched',
    observedAt: '2026-10-26T07:59:50Z',
    addresses: ['192.0.2.10'],
    expectedAddresses: ['192.0.2.10'],
    cnameChain: [],
    expectedCname: null,
    code: null,
    message: 'The records match the configured entry.',
  },
  route: {
    state: 'ready',
    observedAt: '2026-10-26T07:59:50Z',
    ingressNames: ['domain-test'],
    backendServiceName: 'web-test',
    portName: 'web',
    readyEndpoints: 1,
    code: null,
    message: 'The configured backend is ready.',
  },
  certificate: {
    state: 'ready',
    environment: 'production',
    authority: 'letsencrypt',
    observedAt: '2026-10-26T07:59:50Z',
    certificateName: 'domain-test',
    issuerName: 'production-test',
    notBefore: '2026-10-25T00:00:00Z',
    notAfter: '2027-01-25T00:00:00Z',
    renewalTime: '2026-12-25T00:00:00Z',
    code: null,
    message: 'The certificate is ready.',
  },
  observationStale: false,
  activeTask: null,
  lastAttemptAt: '2026-10-26T07:59:45Z',
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-26T07:59:50Z',
} satisfies Domain;

describe('network observations preserve independent evidence', () => {
  it('does not promote DNS success into unobserved routing or TLS success', () => {
    const value: Domain = { ...domain, route: null, certificate: null };
    expect(dnsStatus(value.dns).tone).toBe('good');
    expect(routeStatus(value.route).tone).toBe('neutral');
    expect(certificateStatus(value.certificate, now).tone).toBe('neutral');
    expect(publicHttpsUrl(value, now)).toBeNull();
  });

  it('expires a formerly ready certificate using the current time', () => {
    const value: Domain = {
      ...domain,
      certificate: { ...domain.certificate, notAfter: '2026-10-26T07:59:59Z' },
    };
    expect(certificateStatus(value.certificate, now)).toEqual({
      label: '证书已过期',
      tone: 'danger',
    });
    expect(publicHttpsUrl(value, now)).toBeNull();
  });

  it('never presents staging readiness as a trusted production entry', () => {
    const staging: Domain = {
      ...domain,
      certificate: { ...domain.certificate, state: 'staging_ready', environment: 'staging' },
    };
    expect(certificateStatus(staging.certificate, now).label).toBe('测试证书就绪');
    expect(publicHttpsUrl(staging, now)).toBeNull();
    expect(
      publicHttpsUrl(
        { ...staging, certificate: { ...staging.certificate!, environment: 'production' } },
        now,
      ),
    ).toBeNull();
  });

  it('withholds trusted HTTPS for local test and unknown certificate authorities', () => {
    for (const authority of ['local_test', 'unknown'] as const) {
      const value: Domain = { ...domain, certificate: { ...domain.certificate, authority } };
      expect(certificateStatus(value.certificate, now).tone).toBe('warning');
      expect(publicHttpsUrl(value, now)).toBeNull();
    }
    expect(certificateStatus({ ...domain.certificate, authority: 'local_test' }, now).label).toBe(
      '本地测试证书',
    );
  });

  it('withholds an entry when its latest observed success is stale or deletion has started', () => {
    expect(publicHttpsUrl({ ...domain, observationStale: true }, now)).toBeNull();
    expect(publicHttpsUrl({ ...domain, desiredState: 'deleting' }, now)).toBeNull();
    expect(
      publicHttpsUrl({ ...domain, dns: { ...domain.dns, state: 'mismatch' } }, now),
    ).toBeNull();
  });

  it('keeps renewal failures visible even while DNS and routing are ready', () => {
    const value: Domain = {
      ...domain,
      certificate: { ...domain.certificate, state: 'failed', code: 'ACME_RENEWAL_FAILED' },
    };
    expect(dnsStatus(value.dns).tone).toBe('good');
    expect(routeStatus(value.route).tone).toBe('good');
    expect(certificateStatus(value.certificate, now).tone).toBe('danger');
    expect(publicHttpsUrl(value, now)).toBeNull();
  });

  it('requires a known current validity window before offering the HTTPS entry', () => {
    expect(publicHttpsUrl(domain, now)).toBe(`https://${domain.hostname}`);
    expect(
      publicHttpsUrl({ ...domain, certificate: { ...domain.certificate, notAfter: null } }, now),
    ).toBeNull();
    expect(
      publicHttpsUrl(
        { ...domain, certificate: { ...domain.certificate, notBefore: '2026-10-27T00:00:00Z' } },
        now,
      ),
    ).toBeNull();
  });

  it.each(['domain_bind', 'domain_reconcile'])(
    'does not classify %s sharing a service scope as a workload operation',
    (kind) => {
      const operation = {
        scope: 'service',
        kind,
        input: {
          domainId: domain.id,
          hostname: domain.hostname,
          serviceId: domain.serviceId,
          target: {},
        },
      } as unknown as Operation;
      expect(serviceOperationInput(operation)).toBeNull();
      expect(domainOperationInput(operation)?.domainId).toBe(domain.id);
    },
  );
});
