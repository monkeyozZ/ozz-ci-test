import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma, NetworkManagedResource } from '../../packages/database/dist/index.js';
import type { NetworkResourceDescriptor } from '../../packages/infrastructure/src/networking/contracts.js';
import { loadCertManagerManifests } from '../../packages/infrastructure/src/networking/cert-manager-assets.js';
import {
  reserveNetworkResource,
  type NetworkOwner,
} from '../../packages/control-plane/src/networking/ledger.js';

const owner: NetworkOwner = {
  installationId: randomUUID(),
  clusterId: randomUUID(),
  kubeSystemUid: randomUUID(),
  caFingerprint: 'a'.repeat(64),
};

function resource(overrides: Partial<NetworkResourceDescriptor> = {}): NetworkResourceDescriptor {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    namespace: 'kube-system',
    name: 'cert-manager:leaderelection',
    role: 'cert_manager',
    scope: 'cluster',
    ...overrides,
  };
}

function transaction(value: NetworkResourceDescriptor) {
  const row: NetworkManagedResource = {
    ...value,
    id: randomUUID(),
    clusterId: owner.clusterId,
    domainId: null,
    targetJson: { ...owner },
    creationNonce: randomUUID(),
    creationAttempted: false,
    uid: null,
    resourceVersion: null,
    revision: 0,
    ledgerVersion: 0,
    receiptJson: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const lock = vi.fn().mockResolvedValue(1);
  const findUnique = vi.fn().mockResolvedValue(row);
  const create = vi.fn();
  const update = vi.fn();
  return {
    tx: {
      $executeRaw: lock,
      networkManagedResource: { findUnique, create, update },
    } as unknown as Prisma.TransactionClient,
    lock,
    findUnique,
    create,
    update,
    row,
  };
}

async function rejectsBeforeDatabase(value: NetworkResourceDescriptor, target = owner) {
  const fixture = transaction(value);
  await expect(reserveNetworkResource(fixture.tx, target, value, true)).rejects.toMatchObject({
    code: 'NETWORK_RESOURCE_OWNERSHIP_MISMATCH',
  });
  expect(fixture.lock).not.toHaveBeenCalled();
  expect(fixture.findUnique).not.toHaveBeenCalled();
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.update).not.toHaveBeenCalled();
}

describe('network resource ledger descriptor boundary', () => {
  it('can reserve every unmodified official cert-manager identity, including its ten RBAC names with colons', async () => {
    const objects = await loadCertManagerManifests();
    let colonNames = 0;
    for (const object of objects) {
      const metadata = object.metadata as Record<string, string>;
      const value = resource({
        apiVersion: object.apiVersion as string,
        kind: object.kind as string,
        name: metadata.name,
        namespace: metadata.namespace ?? '',
      });
      if (value.name.includes(':')) colonNames++;
      const fixture = transaction(value);
      const reserved = await reserveNetworkResource(fixture.tx, owner, value, false);
      expect(reserved).toMatchObject({ ...value, creationNonce: fixture.row.creationNonce });
      expect(fixture.findUnique).toHaveBeenCalledWith({
        where: {
          clusterId_kind_namespace_name: {
            clusterId: owner.clusterId,
            kind: value.kind,
            namespace: value.namespace,
            name: value.name,
          },
        },
      });
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.update).not.toHaveBeenCalled();
    }
    expect(colonNames).toBe(10);
  });

  it.each(['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'])(
    'allows a bounded RBAC name for %s without changing its original identity',
    async (kind) => {
      const value = resource({
        kind,
        namespace: kind.startsWith('Cluster') ? '' : 'kube-system',
        name: `${'a'.repeat(125)}:${'b'.repeat(127)}`,
      });
      const fixture = transaction(value);
      await expect(reserveNetworkResource(fixture.tx, owner, value, false)).resolves.toMatchObject({
        name: value.name,
      });
    },
  );

  it.each([
    { apiVersion: 'v1', kind: 'Secret' },
    { apiVersion: 'v1', kind: 'Namespace' },
    { apiVersion: 'apps/v1', kind: 'Deployment' },
    { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' },
    { apiVersion: 'rbac.authorization.k8s.io/v1beta1', kind: 'Role' },
    { apiVersion: 'example.io/v1', kind: 'Role' },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Rule' },
  ])('does not permit colon names for $apiVersion $kind', async (overrides) => {
    await rejectsBeforeDatabase(resource(overrides));
  });

  it.each([
    '',
    '.',
    '..',
    'a'.repeat(254),
    'name/path',
    'name\\path',
    'name%2Fpath',
    'name%252Fpath',
    'name?key=value',
    'name#fragment',
    'name with space',
    'name\nsuffix',
    ':name',
    'name:',
  ])('rejects an invalid RBAC path segment before any database operation (%j)', async (name) => {
    await rejectsBeforeDatabase(resource({ name }));
  });

  it('keeps namespace and ownership fences for RBAC resources', async () => {
    await rejectsBeforeDatabase(resource({ namespace: 'kube:system' }));
    await rejectsBeforeDatabase(resource({ scope: 'environment' }));
    const domainOwner: NetworkOwner = {
      ...owner,
      projectId: randomUUID(),
      environmentId: randomUUID(),
      serviceId: randomUUID(),
      namespace: 'ozz-application',
      serviceName: 'service',
      serviceUid: randomUUID(),
      domainId: randomUUID(),
      hostname: 'service.example.test',
      portId: randomUUID(),
      portName: 'http',
    };
    await rejectsBeforeDatabase(resource(), domainOwner);
    await rejectsBeforeDatabase(resource({ scope: 'domain' }), domainOwner);
  });
});
