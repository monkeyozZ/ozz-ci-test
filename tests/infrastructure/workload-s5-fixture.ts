import { randomUUID } from 'node:crypto';
import { KubernetesStorageAdapter } from '../../packages/infrastructure/dist/storage.js';
import {
  KubernetesWorkloadAdapter,
  workloadNames,
} from '../../packages/infrastructure/dist/workload.js';
import { journal, plan } from './workload-fixture.js';
import { StorageFixture, storageJournal, storagePlan } from './storage-fixture.js';

export const workloadAdapter = () =>
  new KubernetesWorkloadAdapter({
    operationTimeoutMs: 4000,
    rolloutTimeoutMs: 350,
    pollIntervalMs: 15,
    requestTimeoutMs: 700,
  });
export async function statefulWorkload(
  server: StorageFixture,
  engine?: 'postgresql' | 'redis',
  strategy: 'RollingUpdate' | 'OnDelete' = 'RollingUpdate',
) {
  const target = server.target(),
    storage = storageJournal(storagePlan(server, target));
  await new KubernetesStorageAdapter().create(server.connection(), storage.plan, storage.hooks);
  const input = plan(target);
  input.configuration.controller = { kind: 'StatefulSet', strategy };
  input.configuration.volumes = [
    {
      volumeId: storage.plan.target.volumeId,
      claimName: storage.plan.claim.name,
      claimUid: storage.plan.claim.uid!,
      path: '/data',
      readOnly: false,
    },
  ];
  input.inventory = input.inventory
    .filter((row) => row.kind !== 'Deployment')
    .map((row) => (row.kind === 'Namespace' ? storage.plan.namespace : row));
  for (const [kind, name] of [
    ['StatefulSet', workloadNames(target).statefulSet],
    ['Service', workloadNames(target).headlessService],
  ] as const)
    input.inventory = [
      ...input.inventory,
      {
        kind,
        name,
        namespace: target.namespace,
        creationNonce: randomUUID(),
        creationAttempted: false,
        uid: null,
        resourceVersion: null,
        mutationRevision: 0,
        specFingerprint: null,
      },
    ];
  if (engine) {
    const port = engine === 'postgresql' ? 5432 : 6379;
    input.configuration.database = {
      engine,
      expectedMajor: engine === 'postgresql' ? 17 : 7,
      username: engine === 'postgresql' ? 'app' : 'default',
      databaseName: engine === 'postgresql' ? 'app' : null,
    };
    input.configuration.ports = [
      { name: 'database', protocol: 'tcp', containerPort: port, servicePort: port },
    ];
    input.configuration.readiness = {
      type: 'tcp',
      port: 'database',
      initialDelaySeconds: 0,
      periodSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 3,
    };
    input.configuration.startup = input.configuration.readiness;
    input.configuration.environment =
      engine === 'postgresql'
        ? [
            { name: 'POSTGRES_USER', value: 'app' },
            { name: 'POSTGRES_DB', value: 'app' },
            { name: 'POSTGRES_PASSWORD', value: 'synthetic-private-database-password' },
          ]
        : [
            { name: 'REDIS_USERNAME', value: 'default' },
            { name: 'REDIS_PASSWORD', value: 'synthetic-private-database-password' },
          ];
    if (engine === 'redis') {
      input.configuration.command = ['redis-server'];
      input.configuration.args = ['/run/ozz/database/redis.conf'];
      input.configuration.secretFiles = [
        {
          key: 'redis-conf',
          path: '/run/ozz/database/redis.conf',
          value: 'appendonly yes\nappendfsync everysec\naclfile /run/ozz/database/users.acl',
        },
        {
          key: 'redis-acl',
          path: '/run/ozz/database/users.acl',
          value: `user default reset on #${'a'.repeat(64)} ~* &* +@all`,
        },
      ];
    }
  }
  const state = journal(input),
    manager = workloadAdapter();
  const applied = await manager.apply(server.connection(), input, state.hooks);
  return { server, target, input, storage, state, manager, applied };
}
