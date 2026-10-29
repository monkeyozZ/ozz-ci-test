import { createHash, randomUUID } from 'node:crypto';
import { workloadNames } from '../../packages/infrastructure/dist/workload.js';

/** Synthetic history stays in the caller's disposable schema and is never queued. */
export async function seedS3Baseline({ db, seedRequest, projects, adminId, runId }) {
  // This schema has no external targets or Worker. Give only its synthetic
  // clusters a fixture identity so the real service admission path can run.
  // This is dataset preparation, not a claim that a cluster was connected.
  for (const id of new Set(projects.map((project) => project.clusterId)))
    await db.cluster.update({ where: { id }, data: { kubeSystemUid: `synthetic-${id}` } });
  const environments = await db.environment.findMany({
    where: { slug: 'production', projectId: { in: projects.map((project) => project.id) } },
    select: { id: true, projectId: true },
  });
  const state = await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  const services = [];
  for (let index = 0; index < 100; index++) {
    const project = projects[index % projects.length];
    const environment = environments.find((value) => value.projectId === project.id);
    services.push(
      await seedRequest('/services', {
        projectId: project.id,
        environmentId: environment.id,
        name: `性能样本服务 ${String(index).padStart(3, '0')}`,
        slug: `sample-${index}`,
        description: 'Synthetic metadata sample; no container has been deployed.',
        configuration: {
          image: 'example.invalid/benchmark/app:fixed-sample',
          replicas: 1,
          ports: [{ name: 'http', protocol: 'http', containerPort: 8080, servicePort: 80 }],
          environment: [{ name: 'SAMPLE_MODE', value: 'metadata-only' }],
        },
      }),
    );
  }
  const histories = [];
  const baseTime = Date.now() - 10_000 * 1000;
  for (let offset = 0; offset < 10_000; offset += 500) {
    const rows = [];
    const stages = [];
    for (let index = offset; index < offset + 500; index++) {
      const service = services[index % services.length];
      const names = workloadNames({ serviceId: service.id, environmentId: service.environmentId });
      const id = randomUUID();
      const mutationRevision = Math.floor(index / services.length) + 1;
      const createdAt = new Date(baseTime + index * 1000);
      histories.push({ id, serviceId: service.id, projectId: service.projectId });
      rows.push({
        id,
        serviceId: service.id,
        createdById: adminId,
        generation: state.generation,
        status: 'failed',
        phase: 'resolving',
        attempts: 1,
        configRevision: service.configRevision,
        mutationRevision,
        input: { serviceId: service.id, mutationRevision },
        snapshotJson: {
          version: 1,
          serviceId: service.id,
          serviceName: service.name,
          serviceSlug: service.slug,
          configRevision: service.configRevision,
          configuration: service.configuration,
          deployAndStart: false,
          allowConfigurationRepair: false,
        },
        targetJson: {
          installationId: state.installationId,
          clusterId: service.clusterId,
          kubeSystemUid: `synthetic-${service.clusterId}`,
          projectId: service.projectId,
          environmentId: service.environmentId,
          serviceId: service.id,
          namespace: names.namespace,
          serviceName: names.service,
        },
        idempotencyScope: `baseline-history:${runId}`,
        idempotencyKey: String(index),
        requestHash: createHash('sha256').update(`${runId}:${index}`).digest('hex'),
        errorCode: 'BASELINE_SYNTHETIC_HISTORY',
        errorMessage: 'Synthetic benchmark history; no Registry or Kubernetes request was made.',
        createdAt,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 100),
        nextAttemptAt: createdAt,
      });
      stages.push({
        deploymentId: id,
        name: 'resolving',
        attempt: 1,
        status: 'failed',
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 100),
        errorCode: 'BASELINE_SYNTHETIC_HISTORY',
      });
    }
    await db.$transaction(async (tx) => {
      await tx.deployment.createMany({ data: rows });
      await tx.deploymentStage.createMany({ data: stages });
    });
  }
  await db.service.updateMany({
    where: { id: { in: services.map((service) => service.id) } },
    data: { mutationRevision: 100 },
  });
  return { services, histories };
}

export function s3BaselineRoute(worker, sequence, samples, measured) {
  const chosen = samples.services[(sequence + worker.index * 7) % samples.services.length];
  const history = samples.histories[(sequence * 17 + worker.index) % samples.histories.length];
  switch (sequence % 10) {
    case 0:
      return { key: 'services.list-global', method: 'GET', path: '/services?limit=20' };
    case 1:
    case 6:
      return { key: 'services.detail', method: 'GET', path: `/services/${chosen.id}` };
    case 2:
      return {
        key: 'services.list-project',
        method: 'GET',
        path: `/services?limit=20&projectId=${chosen.projectId}`,
      };
    case 3:
    case 7:
      return { key: 'deployments.list-global', method: 'GET', path: '/deployments?limit=20' };
    case 4:
      return { key: 'deployments.detail', method: 'GET', path: `/deployments/${history.id}` };
    case 5:
      return {
        key: 'deployments.list-service',
        method: 'GET',
        path: `/deployments?limit=20&serviceId=${chosen.id}`,
      };
    case 8:
      if (measured && worker.admissions < 20) {
        worker.admissions++;
        return {
          key: 'diagnostics.accept',
          method: 'POST',
          path: '/operations/diagnostics',
          payload: { durationMs: 0 },
          expectedStatus: 202,
        };
      }
      return { key: 'operations.list', method: 'GET', path: '/operations?limit=20' };
    default:
      return {
        key: 'services.patch',
        method: 'PATCH',
        path: `/services/${worker.service.id}`,
        payload: {
          revision: worker.service.revision,
          description: `Measured metadata revision ${sequence}`,
        },
      };
  }
}
