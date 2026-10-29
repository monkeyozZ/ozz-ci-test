import { randomUUID } from 'node:crypto';
import { Prisma } from '@ozz/database';
import { withWritableControlPlane } from '../recovery.js';
import { assertResourceIdle } from '../infrastructure/persistence.js';
import {
  assertServiceTarget,
  currentTarget,
  json,
  lockService,
  requireIdle,
  requireServiceRevision,
  serviceInclude,
  type ServiceRecord,
} from '../services/persistence.js';
import {
  OperationRequestError,
  pageLimit,
  domainOperationKinds,
  clusterNetworkingKinds,
  domainOperationInput,
  clusterNetworkingOperationInput,
  type DomainOperationInput,
  type DomainOperationKind,
  type ClusterNetworkingKind,
} from '../tasks/contracts.js';
import { TaskRepository, type OperationActor } from '../tasks/repository.js';
import {
  NetworkingConflictError,
  NETWORK_OBSERVATION_STALE_MS,
  type DomainAction,
  type DomainTarget,
  type DomainListQuery,
  type ServiceNetworkingView,
} from './contracts.js';
import {
  domainInclude,
  eligibleHttpPorts,
  identity,
  lockNetworkingConfiguration,
  presentDomain,
  readClusterNetworking,
  readPlatformSettings,
  requireDomain,
  type DomainRecord,
} from './persistence.js';
import {
  clusterDomainSuffix,
  allocateHostname,
  clusterNetworkingInput,
  platformSettingsInput,
  resourceId,
  inputRecord,
  revision,
} from './validation.js';

export class NetworkingCommands {
  constructor(readonly repository: TaskRepository) {}

  platformSettings() {
    return readPlatformSettings(this.repository.db);
  }

  updatePlatformSettings(raw: unknown) {
    const input = platformSettingsInput(raw);
    return withWritableControlPlane(this.repository.db, async (tx) => {
      await lockNetworkingConfiguration(tx);
      const current = await readPlatformSettings(tx);
      if (input.revision !== current.revision)
        throw new OperationRequestError(409, 'REVISION_CONFLICT', '平台设置已修改，请刷新后核对。');
      const changing =
        input.appsDomainSuffix !== current.appsDomainSuffix ||
        input.acmeEmail !== current.acmeEmail;
      if (!changing) return current;
      const existing = await tx.domain.findMany({ take: 20, select: { hostname: true } });
      if (existing.length)
        throw new NetworkingConflictError(
          'DOMAIN_SETTINGS_IN_USE',
          '已有域名使用这些设置；请先明确处理绑定，不能通过普通保存迁移入口或 ACME 账户。',
          existing.map((row) => row.hostname),
        );
      if (input.appsDomainSuffix)
        for (const row of await tx.clusterNetworking.findMany({ select: { subdomain: true } }))
          clusterDomainSuffix(input.appsDomainSuffix, row.subdomain);
      const data = { appsDomainSuffix: input.appsDomainSuffix, acmeEmail: input.acmeEmail };
      await tx.platformSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...data },
        update: { ...data, revision: { increment: 1 } },
      });
      return readPlatformSettings(tx);
    });
  }

  async clusterNetworking(id: string) {
    resourceId(id);
    await this.requireCluster(id);
    return readClusterNetworking(this.repository.db, id);
  }

  async updateClusterNetworking(id: string, raw: unknown) {
    resourceId(id);
    const input = clusterNetworkingInput(raw);
    try {
      return await withWritableControlPlane(this.repository.db, async (tx) => {
        await lockNetworkingConfiguration(tx);
        if (!(await tx.cluster.findUnique({ where: { id }, select: { id: true } })))
          throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '集群不存在。');
        const current = await readClusterNetworking(tx, id);
        if (input.revision !== current.revision)
          throw new OperationRequestError(
            409,
            'REVISION_CONFLICT',
            '集群入口已修改，请刷新后核对。',
          );
        const { revision: _revision, ...data } = input;
        if (
          current.subdomain === input.subdomain &&
          current.cnameTarget === input.cnameTarget &&
          JSON.stringify(current.entryAddresses) === JSON.stringify(input.entryAddresses)
        )
          return current;
        const existing = await tx.domain.findMany({
          where: { service: { environment: { project: { clusterId: id } } } },
          take: 20,
          select: { hostname: true },
        });
        if (existing.length)
          throw new NetworkingConflictError(
            'CLUSTER_NETWORKING_IN_USE',
            '该集群已有域名，不能通过普通保存迁移后缀或入口。',
            existing.map((row) => row.hostname),
          );
        const settings = await readPlatformSettings(tx);
        if (settings.appsDomainSuffix)
          clusterDomainSuffix(settings.appsDomainSuffix, input.subdomain);
        await tx.clusterNetworking.upsert({
          where: { clusterId: id },
          create: { clusterId: id, ...data },
          update: {
            ...data,
            revision: { increment: 1 },
            capabilitiesJson: Prisma.DbNull,
            capabilitiesAt: null,
          },
        });
        return readClusterNetworking(tx, id, settings);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new NetworkingConflictError(
          'CLUSTER_SUBDOMAIN_CONFLICT',
          '集群子后缀已被其他集群使用。',
        );
      throw error;
    }
  }

  async serviceNetworking(id: string): Promise<ServiceNetworkingView> {
    resourceId(id);
    const service = await this.repository.db.service.findUnique({
      where: { id },
      include: serviceInclude,
    });
    if (!service) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '服务不存在。');
    const environment = service.environment;
    const project = environment.project;
    const cluster = project.cluster;
    const settings = await readPlatformSettings(this.repository.db);
    const network = await readClusterNetworking(this.repository.db, cluster.id, settings);
    const domains = await this.repository.db.domain.findMany({
      where: { serviceId: id },
      include: domainInclude,
    });
    const ports = eligibleHttpPorts(service);
    const blockers: ServiceNetworkingView['blockers'] = [];
    if (!settings.appsDomainSuffix)
      blockers.push({ code: 'DOMAIN_SUFFIX_REQUIRED', message: '请先配置平台应用域名后缀。' });
    if (!settings.acmeEmail)
      blockers.push({ code: 'ACME_EMAIL_REQUIRED', message: '请先配置 ACME 联系邮箱。' });
    if (!network.domainSuffix || (!network.entryAddresses.length && !network.cnameTarget))
      blockers.push({ code: 'NETWORK_ENTRY_REQUIRED', message: '请先配置此集群的应用入口。' });
    if (
      !cluster.kubeSystemUid ||
      !cluster.credentialRefId ||
      !cluster.apiEndpoint ||
      cluster.connectionStatus !== 'connected'
    )
      blockers.push({ code: 'CLUSTER_NOT_CONNECTED', message: '目标集群尚未连接或当前不可达。' });
    if (!service.publishedDeployment?.appliedAt || service.configurationState !== 'consistent')
      blockers.push({
        code: 'PUBLISHED_CONFIGURATION_REQUIRED',
        message: '请先完整发布并核对服务配置。',
      });
    if (!ports.length)
      blockers.push({
        code: 'PUBLISHED_HTTP_PORT_REQUIRED',
        message: '没有可绑定的已发布 HTTP 端口。',
      });
    if (domains.length)
      blockers.push({
        code: domains.some((row) => row.desiredState === 'deleting')
          ? 'DOMAIN_DELETING'
          : 'DEFAULT_DOMAIN_EXISTS',
        message: '此服务已有默认域名；请查看现有绑定。',
      });
    if (service.activeMutation)
      blockers.push({
        code: 'SERVICE_OPERATION_ACTIVE',
        message: '服务有正在执行的变更，请先查看任务。',
      });
    return {
      serviceId: id,
      serviceRevision: service.revision,
      publishedConfigRevision: service.publishedDeployment?.appliedAt
        ? service.publishedDeployment.configRevision
        : null,
      project: identity(project),
      environment: identity(environment),
      cluster: identity(cluster),
      eligiblePorts: ports,
      blockers,
      platformSettings: settings,
      clusterNetworking: network,
      domains: domains.map(presentDomain),
    };
  }

  async get(id: string) {
    resourceId(id);
    return presentDomain(await requireDomain(this.repository.db, id));
  }

  async list(query: DomainListQuery = {}) {
    const limit = pageLimit(query.limit);
    for (const key of ['projectId', 'environmentId', 'serviceId', 'clusterId'] as const)
      if (query[key] !== undefined) resourceId(query[key]);
    if (
      query.search !== undefined &&
      (typeof query.search !== 'string' || query.search.length > 253)
    )
      throw new OperationRequestError(422, 'NETWORKING_INPUT_INVALID', '域名搜索词过长。');
    let cursor: { id: string; createdAt: string } | null = null;
    if (query.cursor) {
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(query.cursor))
          throw new Error('cursor');
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
          id: string;
          createdAt: string;
        };
        resourceId(cursor.id);
        if (typeof cursor.createdAt !== 'string' || !Number.isFinite(Date.parse(cursor.createdAt)))
          throw new Error('cursor');
      } catch {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '分页游标无效，请从第一页读取。');
      }
    }
    const rows = await this.repository.db.domain.findMany({
      where: {
        serviceId: query.serviceId,
        service: {
          environmentId: query.environmentId,
          environment: { projectId: query.projectId, project: { clusterId: query.clusterId } },
        },
        AND: [
          query.search
            ? {
                OR: [
                  { hostname: { contains: query.search, mode: 'insensitive' } },
                  { service: { name: { contains: query.search, mode: 'insensitive' } } },
                ],
              }
            : {},
          cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      include: domainInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    return {
      data: data.map(presentDomain),
      page: {
        hasMore: rows.length > limit,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() }),
              ).toString('base64url')
            : null,
      },
    };
  }

  bind(serviceId: string, raw: unknown, actor: OperationActor, key: unknown) {
    resourceId(serviceId);
    inputRecord(raw, ['revision', 'portId']);
    const input = { revision: revision(raw.revision), portId: resourceId(raw.portId) };
    return this.repository.enqueue(
      actor,
      key,
      { kind: 'domain_bind', request: { serviceId, ...input } },
      async (tx) => {
        const service = await lockService(tx, serviceId);
        requireServiceRevision(service, input.revision);
        requireIdle(service);
        await lockNetworkingConfiguration(tx);
        const { settings, network } = await this.requiredSettings(tx, service);
        if (await tx.domain.findUnique({ where: { serviceId }, select: { id: true } }))
          throw new NetworkingConflictError(
            'DEFAULT_DOMAIN_EXISTS',
            '此服务已有默认域名，请查看现有绑定。',
          );
        const port = eligibleHttpPorts(service).find((item) => item.id === input.portId);
        if (!port)
          throw new OperationRequestError(
            422,
            'PUBLISHED_HTTP_PORT_REQUIRED',
            '请选择属于此服务的已发布 HTTP 端口。',
          );
        const base = await currentTarget(tx, service);
        const managed = await tx.managedResource.findUnique({
          where: {
            clusterId_kind_namespace_name: {
              clusterId: base.clusterId,
              kind: 'Service',
              namespace: base.namespace,
              name: base.serviceName,
            },
          },
        });
        if (!managed?.uid || managed.deletedAt || managed.serviceId !== serviceId)
          throw new NetworkingConflictError(
            'PUBLISHED_SERVICE_IDENTITY_REQUIRED',
            '缺少已发布 Kubernetes Service 的可信身份，请先核对服务。',
          );
        let domainId = '';
        let hostname = '';
        for (let attempt = 0; attempt < 8; attempt++) {
          domainId = randomUUID();
          hostname = allocateHostname(service.slug, domainId, network.domainSuffix!);
          if (!(await tx.domain.findUnique({ where: { hostname }, select: { id: true } }))) break;
          hostname = '';
        }
        if (!hostname)
          throw new NetworkingConflictError(
            'DOMAIN_ALLOCATION_CONFLICT',
            '暂时无法分配唯一域名，请重试。',
          );
        const target: DomainTarget = {
          ...base,
          serviceUid: managed.uid,
          domainId,
          hostname,
          portId: port.id,
          portName: port.name,
        };
        await tx.domain.create({
          data: {
            id: domainId,
            serviceId,
            servicePortId: port.id,
            hostname,
            targetJson: json(target),
            portJson: json(port),
          },
        });
        // Domains share the mutation slot but do not pretend to create a workload revision.
        await tx.service.update({ where: { id: serviceId }, data: { revision: { increment: 1 } } });
        const operation: DomainOperationInput = {
          domainId,
          hostname,
          serviceId,
          serviceMutationRevision: service.mutationRevision,
          domainRevision: 1,
          platformRevision: settings.revision,
          networkRevision: network.revision,
          certificateEnvironment: 'staging',
          target,
        };
        return { serviceId, clusterId: base.clusterId, input: operation };
      },
    );
  }

  action(id: string, action: DomainAction, raw: unknown, actor: OperationActor, key: unknown) {
    resourceId(id);
    inputRecord(raw, ['revision']);
    const inputRevision = revision(raw.revision);
    if (!['sync', 'reconcile', 'unbind', 'production'].includes(action))
      throw new OperationRequestError(422, 'NETWORKING_INPUT_INVALID', '域名操作无效。');
    const kind = `domain_${action}` as DomainOperationKind;
    return this.repository.enqueue(
      actor,
      key,
      { kind, request: { id, revision: inputRevision } },
      async (tx) => {
        const candidate = await requireDomain(tx, id);
        const service = await lockService(tx, candidate.serviceId);
        requireIdle(service);
        await lockNetworkingConfiguration(tx);
        const domain = await requireDomain(tx, id);
        if (domain.revision !== inputRevision)
          throw new OperationRequestError(409, 'REVISION_CONFLICT', '域名已修改，请刷新后核对。');
        if (domain.desiredState === 'deleting' && action !== 'unbind')
          throw new NetworkingConflictError('DOMAIN_DELETING', '域名正在解绑，请继续原清理任务。');
        return this.prepareDomainAction(tx, service, domain, kind);
      },
    );
  }

  async retryOperation(id: string, actor: OperationActor, key: unknown) {
    resourceId(id);
    const original = await this.repository.db.operation.findUnique({ where: { id } });
    if (!original) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '操作任务不存在。');
    if ((clusterNetworkingKinds as readonly string[]).includes(original.kind)) {
      const previous = clusterNetworkingOperationInput(original.input);
      return this.clusterAction(
        previous.clusterId,
        original.kind as ClusterNetworkingKind,
        { revision: previous.networkRevision },
        actor,
        key,
        id,
      );
    }
    if (!(domainOperationKinds as readonly string[]).includes(original.kind))
      throw new OperationRequestError(409, 'OPERATION_NOT_RETRYABLE', '此任务不是域名操作。');
    const kind = original.kind as DomainOperationKind;
    return this.repository.enqueue(
      actor,
      key,
      { kind, request: { id }, retryOfId: id },
      async (tx) => {
        const row = await tx.operation.findUniqueOrThrow({ where: { id } });
        if (!['failed', 'cancelled'].includes(row.status))
          throw new NetworkingConflictError(
            'OPERATION_NOT_RETRYABLE',
            '只能重试已失败或取消的操作。',
          );
        const previous = domainOperationInput(row.input);
        const service = await lockService(tx, previous.serviceId);
        requireIdle(service);
        await lockNetworkingConfiguration(tx);
        const domain = await requireDomain(tx, previous.domainId);
        if (
          domain.revision !== previous.domainRevision ||
          domain.hostname !== previous.hostname ||
          service.mutationRevision !== previous.serviceMutationRevision
        )
          throw new NetworkingConflictError(
            'DOMAIN_TASK_SUPERSEDED',
            '原任务后已有新的域名或服务变更，请检查当前绑定；需要写入时使用“重新应用绑定”。',
          );
        await assertServiceTarget(tx, service, previous.target);
        return this.prepareDomainAction(tx, service, domain, kind, previous);
      },
    );
  }

  clusterAction(
    id: string,
    kind: ClusterNetworkingKind,
    raw: unknown,
    actor: OperationActor,
    key: unknown,
    retryOfId?: string,
  ) {
    resourceId(id);
    inputRecord(raw, ['revision']);
    const networkRevision = revision(raw.revision, true);
    if (!(clusterNetworkingKinds as readonly string[]).includes(kind))
      throw new OperationRequestError(422, 'NETWORKING_INPUT_INVALID', '集群网络操作无效。');
    return this.repository.enqueue(
      actor,
      key,
      {
        kind,
        request: retryOfId ? { id: retryOfId } : { clusterId: id, revision: networkRevision },
        retryOfId,
      },
      async (tx) => {
        await lockNetworkingConfiguration(tx);
        const cluster = await tx.cluster.findUnique({ where: { id } });
        if (
          !cluster?.kubeSystemUid ||
          !cluster.credentialRefId ||
          !cluster.apiEndpoint ||
          !cluster.caFingerprint
        )
          throw new NetworkingConflictError('CLUSTER_NOT_CONNECTED', '请先验证集群连接。');
        const network = await readClusterNetworking(tx, id);
        if (!network.revision)
          throw new NetworkingConflictError('NETWORK_ENTRY_REQUIRED', '请先保存集群应用入口设置。');
        if (network.revision !== networkRevision)
          throw new NetworkingConflictError('REVISION_CONFLICT', '集群入口配置已变更。');
        await assertResourceIdle(tx, { clusterId: id });
        if (retryOfId) {
          const original = await tx.operation.findUniqueOrThrow({ where: { id: retryOfId } });
          const previous = clusterNetworkingOperationInput(original.input);
          if (
            !['failed', 'cancelled'].includes(original.status) ||
            previous.clusterId !== id ||
            previous.clusterConnectionRevision !== cluster.connectionRevision ||
            previous.kubeSystemUid !== cluster.kubeSystemUid ||
            previous.networkRevision !== network.revision
          )
            throw new NetworkingConflictError(
              'OPERATION_NOT_RETRYABLE',
              '原任务目标已变化，不能重放到当前集群。',
            );
        }
        const state = await tx.controlPlaneState.findUniqueOrThrow({
          where: { id: 'control-plane' },
        });
        return {
          clusterId: id,
          input: {
            clusterId: id,
            installationId: state.installationId,
            kubeSystemUid: cluster.kubeSystemUid,
            clusterConnectionRevision: cluster.connectionRevision,
            networkRevision,
          },
        };
      },
    );
  }

  private async requiredSettings(tx: Prisma.TransactionClient, service: ServiceRecord) {
    const settings = await readPlatformSettings(tx);
    const network = await readClusterNetworking(
      tx,
      service.environment.project.clusterId,
      settings,
    );
    if (!settings.appsDomainSuffix)
      throw new NetworkingConflictError('DOMAIN_SUFFIX_REQUIRED', '请先保存平台应用域名后缀。');
    if (!settings.acmeEmail)
      throw new NetworkingConflictError('ACME_EMAIL_REQUIRED', '请先保存 ACME 联系邮箱。');
    if (!network.domainSuffix || (!network.entryAddresses.length && !network.cnameTarget))
      throw new NetworkingConflictError('NETWORK_ENTRY_REQUIRED', '请先保存集群应用入口。');
    return { settings, network };
  }

  private async prepareDomainAction(
    tx: Prisma.TransactionClient,
    service: ServiceRecord,
    domain: DomainRecord,
    kind: DomainOperationKind,
    previous?: DomainOperationInput,
  ) {
    const { settings, network } = await this.requiredSettings(tx, service);
    const stored = domain.targetJson as unknown as DomainTarget;
    await assertServiceTarget(tx, service, stored);
    if (
      previous &&
      (previous.platformRevision !== settings.revision ||
        previous.networkRevision !== network.revision)
    )
      throw new NetworkingConflictError('DOMAIN_TASK_SUPERSEDED', '原任务的入口设置已变更。');
    const unbind = kind === 'domain_unbind';
    const stagingVerification =
      kind === 'domain_production'
        ? previous
          ? previous.stagingVerification
          : this.stagingVerification(domain)
        : undefined;
    if (kind === 'domain_production' && !stagingVerification)
      throw new NetworkingConflictError(
        'STAGING_CERTIFICATE_REQUIRED',
        '原任务没有 staging 验证记录，不能申请生产证书。',
      );
    let target = stored;
    let port: Prisma.InputJsonValue = json(domain.portJson);
    if (!unbind && kind !== 'domain_sync' && !previous) {
      const eligible = eligibleHttpPorts(service).find(
        (item) => item.id === domain.servicePortId && item.name === stored.portName,
      );
      if (!eligible)
        throw new NetworkingConflictError(
          'PUBLISHED_HTTP_PORT_REQUIRED',
          '当前已发布配置无法提供此绑定端口，请先核对服务。',
        );
      const managed = await tx.managedResource.findUnique({
        where: {
          clusterId_kind_namespace_name: {
            clusterId: stored.clusterId,
            kind: 'Service',
            namespace: stored.namespace,
            name: stored.serviceName,
          },
        },
      });
      if (!managed?.uid || managed.deletedAt || managed.serviceId !== service.id)
        throw new NetworkingConflictError(
          'PUBLISHED_SERVICE_IDENTITY_REQUIRED',
          '当前服务资源身份尚未核对。',
        );
      target = { ...stored, serviceUid: managed.uid };
      port = json(eligible);
    }
    // A diagnostic does not supersede a failed write's immutable intention.
    const checking = kind === 'domain_sync';
    const next = domain.revision + (checking ? 0 : 1);
    const certificateEnvironment =
      kind === 'domain_production'
        ? 'production'
        : (domain.certificateEnvironment as 'staging' | 'production');
    await tx.domain.update({
      where: { id: domain.id },
      data: {
        revision: next,
        desiredState: unbind ? 'deleting' : 'active',
        certificateEnvironment,
        targetJson: json(target),
        portJson: port as Prisma.InputJsonValue,
        observationLeaseToken: null,
        observationLeaseExpiresAt: null,
        nextObservationAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (!checking)
      await tx.service.update({ where: { id: service.id }, data: { revision: { increment: 1 } } });
    const input: DomainOperationInput = {
      domainId: domain.id,
      hostname: domain.hostname,
      serviceId: service.id,
      serviceMutationRevision: service.mutationRevision,
      domainRevision: next,
      platformRevision: settings.revision,
      networkRevision: network.revision,
      certificateEnvironment,
      ...(stagingVerification ? { stagingVerification } : {}),
      target,
    };
    return { serviceId: service.id, clusterId: target.clusterId, input };
  }

  private stagingVerification(
    domain: DomainRecord,
  ): NonNullable<DomainOperationInput['stagingVerification']> {
    const current = presentDomain(domain);
    const certificate = current.certificate;
    const dns = current.dns;
    const now = Date.now();
    const fresh = (value: string | undefined) => {
      const time = value ? Date.parse(value) : NaN;
      return (
        Number.isFinite(time) && time <= now + 30_000 && now - time <= NETWORK_OBSERVATION_STALE_MS
      );
    };
    if (
      domain.certificateEnvironment !== 'staging' ||
      current.observationStale ||
      certificate?.state !== 'staging_ready' ||
      certificate.environment !== 'staging' ||
      !['letsencrypt', 'local_test'].includes(certificate.authority) ||
      !fresh(certificate.observedAt) ||
      dns?.state !== 'matched' ||
      !fresh(dns.observedAt) ||
      !certificate.notBefore ||
      !certificate.notAfter ||
      !Number.isFinite(Date.parse(certificate.notBefore)) ||
      Date.parse(certificate.notBefore) > now ||
      !Number.isFinite(Date.parse(certificate.notAfter)) ||
      Date.parse(certificate.notAfter) <= now
    )
      throw new NetworkingConflictError(
        'STAGING_CERTIFICATE_REQUIRED',
        '请先取得当前有效的 staging 证书并完成最新 DNS 检查，再申请生产证书。',
      );
    return {
      authority: certificate.authority as 'letsencrypt' | 'local_test',
      certificateObservedAt: certificate.observedAt,
      certificateNotAfter: certificate.notAfter,
      dnsObservedAt: dns.observedAt,
    };
  }

  private async requireCluster(id: string) {
    const row = await this.repository.db.cluster.findUnique({ where: { id } });
    if (!row) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '集群不存在。');
    return row;
  }
}
