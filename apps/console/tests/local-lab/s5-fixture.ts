import type { Page, Route } from '@playwright/test';
import type { Operation } from '../../src/lib/types';
import type {
  DatabaseBindingCollection,
  ManualDataRecord,
  TemplatePreview,
  VolumeMountCollection,
} from '../../src/components/storage/types';
import {
  makeDatabase,
  makeDeployment,
  makeService,
  makeTemplate,
  makeVolume,
  s5Cluster,
  s5Environment,
  s5Ids,
  s5Namespace,
  s5Project,
  timestamp,
} from '../fixtures/s5-data';

export { s5Ids };
export const s5ServicePath = `/projects/${s5Ids.project}/services/${s5Ids.service}?environment=staging&tab=storage`;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const problem = (route: Route, status: number, detail: string, code = 'FIXTURE_REJECTED') =>
  json(route, { status, detail, code, requestId: 'controlled-s5-request' }, status);

export async function installS5Fixture(page: Page) {
  const db = makeDatabase();
  const databaseVolume = makeVolume({
    id: s5Ids.databaseVolume,
    name: db.dataVolume.name,
    slug: 'database-data-fixture',
    requestedBytes: '4294967296',
    retainedDatabase: {
      id: db.id,
      serviceId: db.service!.id,
      engine: db.engine,
      majorVersion: db.majorVersion,
      initializedAt: db.initialization.initializedAt,
      initializationFenceAt: db.protection.fencedAt,
    },
    pvc: {
      name: db.dataVolume.pvcName,
      uid: db.dataVolume.pvcUid,
      resourceVersion: '12',
      phase: 'Bound',
      deleting: false,
    },
    manualDataIdentity: {
      ...makeVolume().manualDataIdentity!,
      volumeId: s5Ids.databaseVolume,
      pvcUid: db.dataVolume.pvcUid!,
    },
  });
  const providerService = makeService({
    id: s5Ids.databaseService,
    name: db.service!.name,
    slug: db.service!.slug,
    kind: 'database',
    controller: { kind: 'StatefulSet', strategy: 'RollingUpdate' },
    databaseInstanceId: db.id,
    template: db.template,
  });
  const state = {
    source:
      'controlled-interface-fixture; every API request is intercepted; no real backend or cluster writes',
    volumes: [makeVolume(), databaseVolume],
    databases: [db],
    services: [makeService(), providerService],
    templates: (['docker', 'node-example', 'static-example', 'postgresql', 'redis'] as const).map(
      makeTemplate,
    ),
    operations: [] as Operation[],
    deployments: [makeDeployment()],
    manualRecords: [] as ManualDataRecord[],
    mounts: {} as Record<string, VolumeMountCollection>,
    bindings: {} as Record<string, DatabaseBindingCollection>,
    restoreMode: false,
    storageStale: false,
    provisionerReady: true,
    mountConflict: false,
    bindingConflict: false,
    deleteBlocked: false,
    createReplyLoss: false,
    templateSaveReplyLoss: false,
    bindingSaveConflict: false,
    refsMismatch: false,
    refsError: false,
    permissionsReady: true,
    capabilitiesTruncated: false,
    beforeTemplateReply: undefined as undefined | (() => Promise<void>),
    beforeCreateReply: undefined as undefined | (() => Promise<void>),
    beforeTemplateSaveReply: undefined as undefined | (() => Promise<void>),
    pageLimit: 50,
    writes: [] as { method: string; path: string; body: unknown; key: string | null }[],
    reads: [] as { path: string; query: Record<string, string> }[],
    unexpected: [] as string[],
  };
  const project = {
    ...s5Project,
    revision: 1,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    description: null,
    clusterId: s5Ids.cluster,
    cluster: { ...s5Cluster, connectionStatus: 'connected', lastObservedAt: timestamp() },
  };
  const environment = {
    ...s5Environment,
    revision: 1,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    description: null,
    projectId: s5Ids.project,
    clusterId: s5Ids.cluster,
    isDefault: false,
  };
  const cluster = {
    ...s5Cluster,
    revision: 1,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    description: null,
    region: null,
    apiEndpoint: 'https://192.0.2.50:6443',
    credentialRefId: null,
    connectionStatus: 'connected',
    lastObservedAt: timestamp(),
    identity: null,
    observation: null,
    observationStale: false,
    nodeCount: 1,
    projectCount: 1,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastOperationId: null,
  };
  const creations = new Map<string, { volumeId: string; operation: Operation }>();
  const serviceCreations = new Map<string, ReturnType<typeof makeService>>();
  let operationSequence = 0;
  function operation(kind: string, volumeId?: string, serviceId?: string) {
    const target = {
      installationId: s5Ids.installation,
      clusterId: s5Ids.cluster,
      kubeSystemUid: 'fixture-kube-system-uid',
      projectId: s5Ids.project,
      environmentId: s5Ids.environment,
      namespace: s5Namespace,
    };
    const input = volumeId
      ? { volumeId, volumeRevision: 3, mutationRevision: 1, target: { ...target, volumeId } }
      : {
          serviceId: serviceId!,
          mutationRevision: 2,
          snapshotId: '52000000-0000-4000-8000-000000000001',
          target: { ...target, serviceName: 'fixture-service' },
          volumeIds: state.volumes.map((item) => item.id),
        };
    const value = {
      id: `53000000-0000-4000-8000-${String(++operationSequence).padStart(12, '0')}`,
      kind,
      scope: volumeId ? 'volume' : 'service',
      serverId: null,
      clusterId: s5Ids.cluster,
      serviceId: serviceId ?? null,
      status: 'queued',
      input,
      result: null,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      retryOfId: null,
      cancelRequestedAt: null,
      pollUrl: '',
    } as Operation;
    value.pollUrl = `/api/operations/${value.id}`;
    state.operations.unshift(value);
    return value;
  }
  function list(route: Route, values: unknown[], url: URL, limitOverride?: number) {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), limitOverride ?? 50);
    const offset = Number(url.searchParams.get('cursor')?.split(':')[1] ?? 0),
      next = offset + limit;
    return json(route, {
      data: values.slice(offset, next),
      page: {
        hasMore: next < values.length,
        nextCursor: next < values.length ? `fixture:${next}` : null,
      },
    });
  }
  const collection = (serviceId: string) => {
    const service = state.services.find((item) => item.id === serviceId)!;
    return {
      serviceRevision: service?.revision ?? 1,
      configRevision: service?.configRevision ?? 1,
    };
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.slice(4),
      method = request.method();
    const body = method === 'GET' ? undefined : request.postDataJSON();
    const key = request.headers()['idempotency-key'] ?? null;
    if (method === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    else state.writes.push({ method, path, body, key });
    if (path === '/auth/me')
      return json(route, {
        data: {
          user: { id: '54000000-0000-4000-8000-000000000001', username: '数据界面契约测试' },
          csrfToken: 'fixture-only-not-authenticated',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          restoreMode: state.restoreMode,
        },
      });
    if (state.restoreMode && method !== 'GET')
      return problem(route, 503, '恢复核对期间只允许读取。', 'CONTROL_PLANE_READ_ONLY');
    if (path === '/operations/worker-status')
      return json(route, {
        data: {
          status: 'offline',
          queue: 'unknown',
          queuedCount: state.operations.length,
          unpublishedCount: 0,
          workers: [],
        },
      });
    if (path === '/projects') return list(route, [project], url);
    if (path === `/projects/${s5Ids.project}`) return json(route, { data: project });
    if (path === '/environments') return list(route, [environment], url);
    if (path === `/environments/${s5Ids.environment}`) return json(route, { data: environment });
    if (path === '/clusters') return list(route, [cluster], url);
    if (path === `/clusters/${s5Ids.cluster}`) return json(route, { data: cluster });
    if (path === '/secrets') return list(route, [], url);
    if (path === '/templates' && method === 'GET')
      return list(
        route,
        state.templates.filter(
          (item) =>
            (!url.searchParams.get('category') ||
              item.category === url.searchParams.get('category')) &&
            (!url.searchParams.get('search') ||
              item.name.toLowerCase().includes(url.searchParams.get('search')!.toLowerCase())),
        ),
        url,
      );
    const templateMatch = path.match(/^\/templates\/([^/]+)(?:\/(preview))?$/);
    if (templateMatch) {
      const template = state.templates.find((item) => item.id === templateMatch[1]);
      if (!template) return problem(route, 404, '测试模板不存在。');
      if (method === 'GET') return json(route, { data: template });
      if (templateMatch[2] === 'preview' && method === 'POST') {
        const value: TemplatePreview = {
          template: { id: template.id, version: template.version },
          environmentId: s5Ids.environment,
          projectId: s5Ids.project,
          clusterId: s5Ids.cluster,
          configuration: {
            ...makeService().configuration,
            image: template.image?.reference ?? body.parameters.image,
          },
          controller: template.controller,
          plannedVolumes: template.persistent
            ? [
                {
                  purpose: 'database_data',
                  requestedBytes: body.parameters.requestedBytes ?? '1073741824',
                  storageClassName: 'local-path',
                  mountPath: template.id === 'postgresql' ? '/var/lib/postgresql/data' : '/data',
                  hardQuotaSupport: 'unsupported',
                },
              ]
            : [],
          plannedCredentials: template.persistent ? [{ kind: 'database', generated: true }] : [],
          issues: [],
          previewDigest: 'a'.repeat(64),
        };
        if (state.beforeTemplateReply) await state.beforeTemplateReply();
        return json(route, { data: value });
      }
    }
    if (path === `/clusters/${s5Ids.cluster}/storage`) {
      const storageClass = makeVolume().storageClass!;
      return json(route, {
        data: {
          clusterId: s5Ids.cluster,
          capabilities: {
            observedAt: timestamp(),
            storageClasses: [storageClass],
            truncated: state.capabilitiesTruncated,
            provisioner: { state: state.provisionerReady ? 'ready' : 'missing', version: null },
            permissions: state.permissionsReady ? 'ready' : 'insufficient',
            issues: state.provisionerReady
              ? []
              : [
                  {
                    code: 'LOCAL_PATH_UNAVAILABLE',
                    message: 'local-path provisioner 当前不可用。',
                  },
                ],
          },
          storageClasses: [storageClass],
          observedAt: timestamp(),
          stale: state.storageStale,
          lastAttemptAt: timestamp(),
          errorCode: null,
        },
      });
    }
    if (path === '/volumes' && method === 'GET') {
      const q = url.searchParams;
      return list(
        route,
        state.volumes.filter(
          (item) =>
            (!q.get('search') || item.name.includes(q.get('search')!)) &&
            (!q.get('projectId') || item.project?.id === q.get('projectId')) &&
            (!q.get('environmentId') || item.environment?.id === q.get('environmentId')) &&
            (!q.get('clusterId') || item.cluster?.id === q.get('clusterId')) &&
            (!q.get('retained') || String(item.retained) === q.get('retained')) &&
            (!q.get('serviceId') ||
              [...item.mounts.desired, ...item.mounts.published].some(
                (mount) => mount.serviceId === q.get('serviceId'),
              )),
        ),
        url,
        state.pageLimit,
      );
    }
    if (path === '/volumes' && method === 'POST') {
      if (!key) return problem(route, 422, '缺少持久幂等键。');
      if (creations.has(key)) return json(route, { data: creations.get(key) }, 202);
      const volume = makeVolume({
        id: s5Ids.createdVolume,
        name: body.name,
        slug: body.slug,
        requestedBytes: body.requestedBytes,
        manualDataIdentity: {
          ...makeVolume().manualDataIdentity!,
          volumeId: s5Ids.createdVolume,
          pvcUid: 'fixture-created-pvc-uid',
        },
      });
      const task = operation('volume_create', volume.id);
      volume.activeTask = { type: 'operation', id: task.id, kind: task.kind, status: task.status };
      state.volumes.push(volume);
      const value = { volumeId: volume.id, operation: task };
      creations.set(key, value);
      if (state.beforeCreateReply) await state.beforeCreateReply();
      if (state.createReplyLoss) {
        state.createReplyLoss = false;
        return route.abort('failed');
      }
      return json(route, { data: value }, 202);
    }
    const volumeMatch = path.match(/^\/volumes\/([^/]+)(?:\/(.+))?$/);
    if (volumeMatch) {
      const volume = state.volumes.find((item) => item.id === volumeMatch[1]);
      if (!volume) return problem(route, 404, '测试卷不存在。');
      const action = volumeMatch[2];
      if (!action && method === 'GET') return json(route, { data: volume });
      if (action === 'deletion-preview' && method === 'POST')
        return json(route, {
          data: {
            volumeId: volume.id,
            revision: volume.revision,
            volumeName: volume.name,
            pvcUid: volume.pvc.uid,
            pvcName: volume.pvc.name,
            pvName: volume.pv?.name ?? null,
            reclaimPolicy: volume.pv?.reclaimPolicy ?? 'Delete',
            observedAt: volume.observation.observedAt,
            previewDigest: 'b'.repeat(64),
            blockers: volume.deletionBlockers,
            retained: volume.retained,
            retainedDatabase: volume.retainedDatabase,
            lastManualBackupRecord: volume.lastManualBackupRecord,
          },
        });
      if (action === 'manual-data-records') {
        if (method === 'GET')
          return list(
            route,
            state.manualRecords.filter(
              (item) =>
                item.volumeId === volume.id &&
                (!url.searchParams.get('type') || item.type === url.searchParams.get('type')),
            ),
            url,
            state.pageLimit,
          );
        if (method === 'POST') {
          const record: ManualDataRecord = {
            ...body,
            id: `55000000-0000-4000-8000-${String(state.manualRecords.length + 1).padStart(12, '0')}`,
            volumeId: volume.id,
            actorId: '54000000-0000-4000-8000-000000000001',
            createdAt: timestamp(),
            verificationSource: 'operator_reported',
            durationMs: Date.parse(body.completedAt) - Date.parse(body.startedAt),
          };
          state.manualRecords.unshift(record);
          if (record.type === 'backup') volume.lastManualBackupRecord = record;
          return json(route, { data: record }, 201);
        }
      }
      if (
        method === 'DELETE' ||
        ['sync', 'maintenance/enter', 'maintenance/exit'].includes(action ?? '')
      ) {
        if (!key || body.revision !== volume.revision)
          return problem(route, 409, '测试卷版本冲突。');
        const kind =
          method === 'DELETE'
            ? 'volume_destroy'
            : action === 'sync'
              ? 'volume_sync'
              : action === 'maintenance/enter'
                ? 'volume_maintenance_enter'
                : 'volume_maintenance_exit';
        const task = operation(kind, volume.id);
        if ('volumeRevision' in task.input) {
          task.input.volumeRevision = body.revision;
          if (body.maintenanceId) task.input.maintenanceId = body.maintenanceId;
          if (body.confirmation) task.input.confirmation = body.confirmation;
        }
        return json(route, { data: task }, 202);
      }
    }
    if (path === '/databases') {
      const q = url.searchParams;
      return list(
        route,
        state.databases.filter(
          (item) =>
            (!q.get('serviceId') || item.service?.id === q.get('serviceId')) &&
            (!q.get('projectId') || item.projectId === q.get('projectId')) &&
            (!q.get('environmentId') || item.environmentId === q.get('environmentId')) &&
            (!q.get('clusterId') || item.clusterId === q.get('clusterId')) &&
            (!q.get('search') ||
              `${item.service?.name ?? ''} ${item.dataVolume.name}`.includes(q.get('search')!)),
        ),
        url,
        state.pageLimit,
      );
    }
    const databaseMatch = path.match(/^\/databases\/([^/]+)$/);
    if (databaseMatch) {
      const database = state.databases.find((item) => item.id === databaseMatch[1]);
      return database ? json(route, { data: database }) : problem(route, 404, '测试数据库不存在。');
    }
    if (path === '/services' && method === 'GET') return list(route, state.services, url);
    if (path === '/services' && method === 'POST') {
      if (!body.template || body.configuration || !key)
        return problem(route, 422, '模板创建需要互斥的模板输入与幂等键。');
      if (serviceCreations.has(key)) return json(route, { data: serviceCreations.get(key) }, 201);
      const template = state.templates.find((item) => item.id === body.template.id)!;
      const service = makeService({
        id: s5Ids.createdService,
        name: body.name,
        slug: body.slug,
        description: body.description,
        template: { id: template.id, version: template.version },
        controller: template.controller,
        databaseInstanceId: template.persistent ? s5Ids.database : null,
        published: null,
        lastSuccessfulDeploymentId: null,
        configurationState: 'unpublished',
        runtimeState: 'unpublished',
        hasUnpublishedChanges: true,
        configuration: {
          ...makeService().configuration,
          image: template.image?.reference ?? body.template.parameters.image,
        },
      });
      state.services.push(service);
      serviceCreations.set(key, service);
      if (state.beforeTemplateSaveReply) await state.beforeTemplateSaveReply();
      if (state.templateSaveReplyLoss) {
        state.templateSaveReplyLoss = false;
        return route.abort('failed');
      }
      return json(route, { data: service }, 201);
    }
    const serviceMatch = path.match(/^\/services\/([^/]+)(?:\/(.*))?$/);
    if (serviceMatch) {
      const service = state.services.find((item) => item.id === serviceMatch[1]);
      if (!service) return problem(route, 404, '测试服务不存在。');
      const action = serviceMatch[2];
      if (!action && method === 'GET') return json(route, { data: service });
      if (!action && method === 'PATCH') {
        Object.assign(service, body, {
          revision: service.revision + 1,
          configRevision: service.configRevision + 1,
        });
        return json(route, { data: service });
      }
      if (action === 'database') {
        const database = state.databases.find((item) => item.service?.id === service.id);
        return database
          ? json(route, { data: database })
          : problem(route, 404, '该服务没有数据库实例。');
      }
      if (action === 'volume-mounts') {
        const current = state.mounts[service.id] ?? { data: [], ...collection(service.id) };
        if (method === 'GET') {
          if (state.refsError) return problem(route, 503, '受控挂载集合读取失败。');
          return json(route, {
            ...current,
            ...collection(service.id),
            ...(state.refsMismatch ? { serviceRevision: service.revision + 1 } : {}),
          });
        }
        if (method === 'POST') {
          if (state.mountConflict)
            return problem(route, 409, '挂载版本冲突，已创建的卷继续保留。', 'REVISION_CONFLICT');
          const volume = state.volumes.find((item) => item.id === body.volumeId)!;
          const mount = {
            id: s5Ids.mount,
            serviceId: service.id,
            service: { id: service.id, name: service.name, slug: service.slug },
            volumeId: volume.id,
            volume: {
              id: volume.id,
              name: volume.name,
              slug: volume.slug,
              revision: volume.revision,
              destroyedAt: null,
            },
            mountPath: body.mountPath,
            readOnly: body.readOnly,
            desired: true,
            lastPublishedDeploymentId: null,
            detachedAt: null,
          };
          service.revision++;
          service.configRevision++;
          service.hasUnpublishedChanges = true;
          if (!body.readOnly) service.controller = { kind: 'Deployment', strategy: 'Recreate' };
          volume.mounts.desired.push(mount);
          state.mounts[service.id] = { data: [...current.data, mount], ...collection(service.id) };
          return json(route, state.mounts[service.id]);
        }
      }
      if (action?.startsWith('volume-mounts/') && method === 'DELETE') {
        const current = state.mounts[service.id];
        if (current) current.data = current.data.filter((item) => item.id !== action.split('/')[1]);
        service.revision++;
        service.configRevision++;
        return json(route, { data: current?.data ?? [], ...collection(service.id) });
      }
      if (action === 'database-bindings/preview' && method === 'POST')
        return json(route, {
          data: {
            databaseInstanceId: body.databaseInstanceId,
            profile: body.profile,
            mapping: body.mapping,
            variables: Object.entries(body.mapping).map(([output, name]) => ({
              name,
              output,
              secret: output === 'password' || output === 'url',
              change: 'add',
            })),
            issues: state.bindingConflict
              ? [
                  {
                    code: 'DATABASE_VARIABLE_CONFLICT',
                    field: 'mapping.host',
                    blocks: 'both',
                    message: '变量 DB_HOST 已由手工配置定义。',
                  },
                ]
              : [],
            serviceRevision: service.revision,
          },
        });
      if (action === 'database-bindings') {
        const current = state.bindings[service.id] ?? { data: [], ...collection(service.id) };
        if (method === 'GET') return json(route, { ...current, ...collection(service.id) });
        if (method === 'POST') {
          if (state.bindingSaveConflict || body.revision !== service.revision)
            return problem(route, 409, '连接版本冲突，填写的映射继续保留。', 'REVISION_CONFLICT');
          const database = state.databases.find((item) => item.id === body.databaseInstanceId)!;
          service.revision++;
          service.configRevision++;
          service.hasUnpublishedChanges = true;
          state.bindings[service.id] = {
            data: [
              {
                id: s5Ids.binding,
                databaseInstanceId: database.id,
                revision: 1,
                profile: body.profile,
                mapping: body.mapping,
                desired: true,
                provider: {
                  serviceId: database.service?.id ?? null,
                  name: database.service?.name ?? database.originalService.name,
                  engine: database.engine,
                  ready: database.databaseReady,
                },
                published: false,
                issues: [],
              },
            ],
            ...collection(service.id),
          };
          return json(route, state.bindings[service.id]);
        }
      }
      if (action?.startsWith('database-bindings/') && method === 'DELETE') {
        service.revision++;
        service.configRevision++;
        state.bindings[service.id] = { data: [], ...collection(service.id) };
        return json(route, state.bindings[service.id]);
      }
      if (action === 'deletion-preview' && method === 'POST')
        return json(route, {
          data: {
            serviceId: service.id,
            revision: service.revision,
            retainedVolumes: state.volumes
              .filter((item) => item.id === s5Ids.volume)
              .map((item) => ({
                id: item.id,
                name: item.name,
                pvcUid: item.pvc.uid,
                databaseInstanceId: item.retainedDatabase?.id ?? null,
              })),
            databaseConsumers: [],
            blockers: state.deleteBlocked
              ? [
                  {
                    code: 'DATABASE_DEPENDENCY_IN_USE',
                    field: null,
                    blocks: 'both',
                    message: '仍有应用引用此数据库。',
                  },
                ]
              : [],
            dataRetentionMessage: '服务删除保留所有数据卷，独立销毁另行审阅。',
          },
        });
      if (!action && method === 'DELETE')
        return json(route, { data: operation('service_delete', undefined, service.id) }, 202);
      if (action === 'deployments' && method === 'POST') {
        if (!key || body.revision !== service.revision)
          return problem(route, 409, '发布版本冲突。');
        const value = makeDeployment({
          id: `52000000-0000-4000-8000-${String(state.deployments.length + 1).padStart(12, '0')}`,
          status: 'queued',
          phase: 'queued',
          serviceId: service.id,
          configRevision: service.configRevision,
          snapshot: {
            ...makeDeployment().snapshot,
            serviceId: service.id,
            serviceName: service.name,
            serviceSlug: service.slug,
            configRevision: service.configRevision,
            configuration: service.configuration,
            controller: service.controller,
            template: service.template,
            volumes: [],
            database: null,
            databaseBindings: [],
          },
          result: null,
          appliedAt: null,
          startedAt: null,
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
        });
        state.deployments.unshift(value);
        return json(route, { data: value }, 202);
      }
    }
    if (path === '/deployments' && method === 'GET') return list(route, state.deployments, url);
    const deploymentMatch = path.match(/^\/deployments\/([^/]+)(?:\/(logs|retry|cancel))?$/);
    if (deploymentMatch) {
      const value = state.deployments.find((item) => item.id === deploymentMatch[1]);
      if (!value) return problem(route, 404, '测试部署不存在。');
      if (deploymentMatch[2] === 'logs')
        return json(route, {
          data: [],
          page: { hasMore: false, nextCursor: null },
          source: 'deployment',
          available: false,
          unavailableReason: 'not_started',
          truncated: false,
        });
      if (deploymentMatch[2] === 'retry' && method === 'POST') {
        const retry = {
          ...structuredClone(value),
          id: `52000000-0000-4000-8000-${String(state.deployments.length + 10).padStart(12, '0')}`,
          status: 'queued' as const,
          retryOfId: value.id,
          createdAt: timestamp(),
          startedAt: null,
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
          stages: [],
        };
        state.deployments.unshift(retry);
        return json(route, { data: retry }, 202);
      }
      return json(route, { data: value });
    }
    if (path === '/operations') return list(route, state.operations, url);
    const opMatch = path.match(/^\/operations\/([^/]+)(?:\/(logs|retry|cancel))?$/);
    if (opMatch) {
      const value = state.operations.find((item) => item.id === opMatch[1]);
      if (!value) return problem(route, 404, '测试任务不存在。');
      if (opMatch[2] === 'logs')
        return json(route, {
          data: [],
          page: { hasMore: false, nextCursor: null },
          source: 'operation',
          available: false,
          unavailableReason: 'not_started',
          truncated: false,
        });
      if (opMatch[2] === 'retry' && method === 'POST') {
        const retry = operation(
          value.kind,
          'volumeId' in value.input ? value.input.volumeId : undefined,
          value.serviceId ?? undefined,
        );
        retry.input = structuredClone(value.input);
        retry.retryOfId = value.id;
        return json(route, { data: retry }, 202);
      }
      return json(route, { data: value });
    }
    state.unexpected.push(`${method} ${path}`);
    return problem(route, 501, '未声明的 S5 受控接口。');
  });
  return state;
}
