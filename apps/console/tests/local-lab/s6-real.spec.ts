import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import type { Envelope, Operation, Page as ApiPage, Session } from '../../src/lib/types';
import type {
  Deployment,
  DeploymentDetail,
  DeploymentLogs,
  Service,
} from '../../src/components/services/types';
import type {
  Builder,
  BuildLogPage,
  GitHubConnection,
  GitPreview,
  GitPreviewInput,
  GitRepository,
  RegistryConnection,
} from '../../src/components/git/types';
import type { Domain, ServiceNetworking } from '../../src/components/networking/types';
import {
  readRealState,
  realArtifactDirectory,
  realOrigin,
  realPasswordPath,
  type RealProductState,
} from './s6-real-support';

// Real requests only. No /api interception, response fixtures, fetch replacement, task creation,
// state-file writes, or service lifecycle actions. Login and one UI commit preview are the only writes.
async function getRaw<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get('/api' + path, { maxRedirects: 0 });
  if (response.status() !== 200)
    throw new Error(`S6_REAL_GET_FAILED ${path}: ${response.status()}`);
  return (await response.json()) as T;
}
async function get<T>(page: Page, path: string): Promise<T> {
  return (await getRaw<Envelope<T>>(page, path)).data;
}
async function collection<T>(page: Page, path: string, githubPagination = false): Promise<T[]> {
  const values: T[] = [];
  const url = new URL('/api' + path, realOrigin);
  if (!githubPagination) url.searchParams.set('limit', '100');
  const cursors = new Set<string>();
  for (let count = 0; count < 20; count++) {
    const response = await getRaw<ApiPage<T>>(page, url.pathname.slice(4) + url.search);
    values.push(...response.data);
    if (!response.page.hasMore) return values;
    const cursor = response.page.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('S6_REAL_COLLECTION_CURSOR_INVALID');
    cursors.add(cursor);
    url.searchParams.set('cursor', cursor);
  }
  throw new Error('S6_REAL_COLLECTION_BOUND_REACHED');
}
function location(service: Service, tab = 'overview') {
  return `/projects/${service.projectId}/services/${service.id}?environment=${service.environment.slug}&tab=${tab}`;
}
async function authenticate(page: Page) {
  let password = process.env.E2E_PASSWORD ?? (await readFile(realPasswordPath, 'utf8')).trim();
  const username = process.env.E2E_USERNAME ?? 'admin';
  if (!password) throw new Error('S6_REAL_LOGIN_CREDENTIAL_MISSING');
  try {
    await page.goto(
      '/login?returnTo=' + encodeURIComponent('/settings?tab=git&integration=github'),
    );
    await page.getByLabel('管理员账号', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录工作台', exact: true }).click();
    await expect(page).toHaveURL('/settings?tab=git&integration=github');
    const cookies = await page.context().cookies(realOrigin + '/api/auth/me');
    expect(cookies.some((cookie) => cookie.httpOnly && cookie.path === '/api')).toBe(true);
    return cookies.map(({ name, domain, path, httpOnly, secure, sameSite }) => ({
      name,
      domain,
      path,
      httpOnly,
      secure,
      sameSite,
    }));
  } catch {
    if (await page.getByLabel('密码', { exact: true }).isVisible())
      await page
        .getByLabel('密码', { exact: true })
        .fill('', { timeout: 1000 })
        .catch(() => undefined);
    await page.goto('about:blank').catch(() => undefined);
    throw new Error('S6_REAL_LOGIN_FAILED; credential-bearing details were not retained');
  } finally {
    password = '';
  }
}
type WriteAudit = {
  method: string;
  path: string;
  status: number | null;
  kind: 'login' | 'preview' | 'unexpected';
  origin: string | null;
  hasCsrfToken: boolean;
};
function monitor(page: Page, serviceId: string) {
  const writes: WriteAudit[] = [];
  const byRequest = new Map<Request, WriteAudit>();
  const headerReads: Promise<void>[] = [];
  const failures: Array<{ method: string; path: string; status: number }> = [];
  const foreignApiOrigins = new Set<string>();
  let pageErrors = 0;
  page.on('pageerror', () => pageErrors++);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    if (url.origin !== realOrigin) foreignApiOrigins.add(url.origin);
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const kind =
      request.method() === 'POST' && url.pathname === '/api/auth/login'
        ? 'login'
        : request.method() === 'POST' &&
            url.pathname === `/api/services/${serviceId}/git-source/preview`
          ? 'preview'
          : 'unexpected';
    const row: WriteAudit = {
      method: request.method(),
      path: url.pathname,
      status: null,
      kind,
      origin: null,
      hasCsrfToken: false,
    };
    writes.push(row);
    byRequest.set(request, row);
    // headers() omits security-related headers; retain only presence and the public Origin.
    headerReads.push(
      Promise.all([request.headerValue('origin'), request.headerValue('x-csrf-token')])
        .then(([origin, csrf]) => {
          row.origin = origin;
          row.hasCsrfToken = !!csrf;
        })
        .catch(() => undefined),
    );
  });
  page.on('response', (response) => {
    const row = byRequest.get(response.request());
    if (row) row.status = response.status();
    const url = new URL(response.url());
    if (
      url.pathname.startsWith('/api/') &&
      response.status() >= 400 &&
      !(url.pathname === '/api/auth/me' && response.status() === 401)
    )
      failures.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
      });
  });
  return {
    async result() {
      await Promise.all(headerReads);
      return { writes, pageErrors, failures, foreignApiOrigins: [...foreignApiOrigins] };
    },
    async assertScope() {
      await Promise.all(headerReads);
      expect(pageErrors, 'real Console JavaScript errors').toBe(0);
      expect(failures, 'real API response failures').toEqual([]);
      expect(
        [...foreignApiOrigins],
        'all management requests use the configured same origin',
      ).toEqual([]);
      expect(
        writes.filter((row) => row.kind === 'unexpected'),
        'no task or lifecycle mutations',
      ).toEqual([]);
      expect(writes.filter((row) => row.kind === 'login')).toHaveLength(1);
      expect(writes.filter((row) => row.kind === 'preview')).toHaveLength(1);
      expect(writes.every((row) => row.status === 200 && row.origin === realOrigin)).toBe(true);
      expect(writes.filter((row) => row.kind === 'preview').every((row) => row.hasCsrfToken)).toBe(
        true,
      );
    },
  };
}
async function inventory(page: Page, serviceId: string) {
  const [deployments, serviceOperations, allOperations] = await Promise.all([
    collection<Deployment>(page, '/deployments?serviceId=' + serviceId),
    collection<Operation>(page, '/operations?serviceId=' + serviceId),
    collection<Operation>(page, '/operations'),
  ]);
  return {
    deployments: deployments.map((item) => item.id).sort(),
    serviceOperations: serviceOperations.map((item) => item.id).sort(),
    integrationOperations: allOperations
      .filter((item) => item.scope === 'integration')
      .map((item) => item.id)
      .sort(),
  };
}
async function reveal(
  page: Page,
  locator: Locator,
  moreLabel: string,
  listSelector = '.integration-list',
) {
  await expect(page.locator(listSelector)).toBeVisible();
  for (let count = 0; count < 20; count++) {
    if (await locator.count()) return locator;
    const more = page.getByRole('button', { name: moreLabel, exact: true });
    if (!(await more.isVisible())) break;
    const previousCount = await page.locator(listSelector + ' > li').count();
    await more.click();
    await expect
      .poll(() => page.locator(listSelector + ' > li').count())
      .toBeGreaterThan(previousCount);
  }
  await expect(locator).toBeVisible();
  return locator;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function serviceIdentity(service: Service) {
  return {
    id: service.id,
    configRevision: service.configRevision,
    mutationRevision: service.mutationRevision,
    desiredState: service.desiredState,
    publishedDeploymentId: service.published?.deploymentId,
    sourceRevisionId: service.source.kind === 'github' ? service.source.currentRevision.id : null,
    policyRevision: service.source.kind === 'github' ? service.source.policyRevision : null,
    activeTaskId: service.activeTask?.id ?? null,
  };
}

test('S6 real UI: saved integrations, fixed commit review, actual build and artifact, default domain', async ({
  page,
}) => {
  const state: RealProductState = await readRealState();
  const audit = monitor(page, state.resources.service);
  const evidence: Record<string, unknown> = {
    scope:
      'Real local API/Worker/Builder/Registry/K3s UI; isolated GitHub HTTPS transport; development cookie flow',
    origin: realOrigin,
    startedAt: new Date().toISOString(),
    status: 'running',
    productionSecureCookieVerified: false,
    publicGitHubDeliveryVerified: false,
    taskCreationAllowed: false,
    previewWriteAllowed: true,
    resourceIds: state.resources,
  };
  const completed: Array<{ name: string; at: string; details: unknown }> = [];
  let currentStage = 'login';
  async function record(name: string, details: unknown) {
    completed.push({ name, at: new Date().toISOString(), details });
    await saveEvidence();
  }
  async function saveEvidence() {
    await writeFile(
      realArtifactDirectory + '/ui-evidence.json',
      JSON.stringify(
        {
          ...evidence,
          currentStage,
          completed,
          audit: await audit.result(),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  }
  async function screenshot(name: string) {
    await page.screenshot({ path: realArtifactDirectory + '/' + name + '.png', fullPage: true });
  }
  try {
    const cookieMetadata = await authenticate(page);
    const session = await get<Session>(page, '/auth/me');
    expect(session.restoreMode).toBe(false);
    await record('development-session', { cookieMetadata, authenticated: true });
    const [service, github, registry, builder, registryCheck] = await Promise.all([
      get<Service>(page, '/services/' + state.resources.service),
      get<GitHubConnection>(page, '/integrations/github/' + state.resources.github),
      get<RegistryConnection>(page, '/integrations/registries/' + state.resources.registry),
      get<Builder>(page, '/integrations/builders/' + state.resources.builder),
      get<Operation>(page, '/operations/' + state.commands['verify-registry']!.id),
    ]);
    if (service.source.kind !== 'github' || service.published?.source.kind !== 'github')
      throw new Error('S6_REAL_SERVICE_HAS_NO_PUBLISHED_GIT_SOURCE');
    expect(service.projectId).toBe(state.resources.project);
    expect(service.environmentId).toBe(state.resources.environment);
    expect(service.clusterId).toBe(state.resources.cluster);
    expect(service.activeTask).toBeNull();
    expect(service.desiredState).toBe('running');
    expect(service.published.deploymentId).toBe(state.firstDeploymentId);
    expect(service.published.source.commitSha).toBe(state.initialSha);
    expect(service.published.image?.deployReference).toBe(state.firstImage);
    expect(service.configuration).not.toHaveProperty('image');
    const source = service.source.currentRevision;
    expect(source.repository.repositoryId).toBe(state.resources.repository);
    expect(source.githubConnectionId).toBe(github.id);
    expect(source.builder.builderId).toBe(builder.id);
    expect(source.destination.registryConnectionId).toBe(registry.id);
    const before = await inventory(page, service.id);
    const beforeIdentity = serviceIdentity(service);
    await record('baseline-resource-identity', { inventory: before, service: beforeIdentity });

    currentStage = 'saved-integration-verification';
    await test.step('Read saved GitHub, Registry and Builder verification without invoking checks', async () => {
      expect(github.verification.state).toBe('verified');
      const githubRow = await reveal(
        page,
        page.locator('.integration-list > li').filter({ hasText: github.credentialRefId }),
        '载入更多连接',
      );
      await expect(githubRow).toContainText(github.name);
      await expect(githubRow).toContainText('GitHub 授权 · 验证通过');
      await githubRow.getByRole('button', { name: '查看授权仓库与 Webhook', exact: true }).click();
      const repositories = await collection<GitRepository>(
        page,
        `/integrations/github/${github.id}/repositories`,
        true,
      );
      const repository = repositories.find((item) => item.id === state.resources.repository);
      if (!repository) throw new Error('S6_REAL_AUTHORIZED_REPOSITORY_MISSING');
      const repositoryRow = await reveal(
        page,
        page
          .locator('[data-github-repositories] .repository-list > li')
          .filter({ hasText: repository.fullName }),
        '载入更多授权仓库',
        '[data-github-repositories] .repository-list',
      );
      await expect(repositoryRow).toContainText(repository.fullName);
      await screenshot('01-github-authorized-repository');

      await page.goto('/settings?tab=git&integration=registries');
      const registryRow = await reveal(
        page,
        page.locator('.integration-list > li').filter({ hasText: registry.pushCredentialRefId }),
        '载入更多连接',
      );
      expect(registry.pushCredentialRefId).not.toBe(registry.pullCredentialRefId);
      expect(registry.pushVerification.state).toBe('verified');
      expect(registry.pullVerification.state).toBe('verified');
      await expect(registryRow).toContainText(registry.pullCredentialRefId);
      await expect(registryRow).toContainText('构建推送 · 验证通过');
      await expect(registryRow).toContainText('运行拉取与只读权限 · 验证通过');
      await screenshot('02-registry-distinct-identities');

      await page.goto('/operations/' + registryCheck.id);
      expect(registryCheck.kind).toBe('registry_validate');
      expect(registryCheck.status).toBe('succeeded');
      if (!registryCheck.result || !('pullCannotPush' in registryCheck.result))
        throw new Error('S6_REAL_REGISTRY_CHECK_HAS_NO_RESULT');
      expect(registryCheck.result.push).toBe(true);
      expect(registryCheck.result.pull).toBe(true);
      expect(registryCheck.result.pullCannotPush).toBe(true);
      const operationPanel = page.locator('[data-integration-operation]');
      await expect(operationPanel).toContainText(registryCheck.result.probeReference);
      await expect(operationPanel).toContainText('拉取身份禁止推送 已确认');
      await screenshot('03-registry-persisted-result');

      await page.goto('/settings?tab=git&integration=builders');
      const builderRow = await reveal(
        page,
        page.locator('.integration-list > li').filter({ hasText: builder.credentialRefId }),
        '载入更多连接',
      );
      expect(builder.verification.state).toBe('verified');
      expect(builder.enabled).toBe(true);
      if (!builder.capabilities) throw new Error('S6_REAL_BUILDER_CAPABILITIES_MISSING');
      expect(builder.capabilities.highGeneration).toBe(
        builder.capabilities.controlPlaneGenerationAtCheck,
      );
      await expect(builderRow).toContainText(builder.instanceId);
      await expect(builderRow).toContainText('Builder 身份与能力 · 验证通过');
      await expect(builderRow).toContainText(
        `Builder 代际 ${builder.capabilities.highGeneration} / 控制面核对代际 ${builder.capabilities.controlPlaneGenerationAtCheck}`,
      );
      await screenshot('04-builder-identity-and-generation');
      await record('saved-integration-verification', {
        githubConnectionId: github.id,
        repositoryId: repository.id,
        hookState: repository.hook.state,
        registryConnectionId: registry.id,
        registryOperationId: registryCheck.id,
        pushAndPullUseDistinctReferences: true,
        pullCannotPush: true,
        builderId: builder.id,
        builderInstanceId: builder.instanceId,
        highGeneration: builder.capabilities.highGeneration,
        controlPlaneGenerationAtCheck: builder.capabilities.controlPlaneGenerationAtCheck,
      });
    });

    currentStage = 'source-and-fixed-commit-preview';
    await test.step('Read saved Git source, prepare the exact published commit, then leave without publishing', async () => {
      await page.goto(location(service, 'source'));
      const sourceSummary = page.locator('[data-git-source-summary]');
      await expect(sourceSummary).toContainText(source.repository.fullNameAtCapture);
      await expect(sourceSummary).toContainText(source.branchRef);
      await expect(sourceSummary).toContainText(source.dockerfilePath);
      await expect(sourceSummary).toContainText(source.builder.builderId);
      await expect(page.getByLabel('Dockerfile 路径', { exact: true })).toHaveValue(
        source.dockerfilePath,
      );
      await expect(page.getByLabel('构建上下文', { exact: true })).toHaveValue(source.contextPath);
      for (const platform of source.platforms)
        await expect(
          page.getByLabel('Linux / ' + platform.architecture, { exact: true }),
        ).toBeChecked();
      await screenshot('05-saved-git-source');
      await page
        .getByRole('navigation', { name: '服务页面', exact: true })
        .getByRole('link', { name: '发布预览', exact: true })
        .click();
      const review = page.locator('[data-deployment-review]');
      await review.getByLabel('指定完整 commit', { exact: true }).check();
      await review.getByLabel('完整 commit SHA', { exact: true }).fill(state.initialSha);
      const responsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/services/${service.id}/git-source/preview`,
      );
      await review.getByRole('button', { name: '读取固定提交预览', exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const previewInput: GitPreviewInput = response.request().postDataJSON();
      expect(previewInput).toEqual({
        revision: service.revision,
        selection: { kind: 'commit', commitSha: state.initialSha },
      });
      const preview = ((await response.json()) as Envelope<GitPreview>).data;
      expect(preview.source.commitSha).toBe(state.initialSha);
      expect(preview.source.revision.id).toBe(source.id);
      expect(preview.serviceRevision).toBe(service.revision);
      expect(preview.configuration).not.toHaveProperty('image');
      expect(preview.issues).toEqual([]);
      await expect(review.locator('[data-git-source-summary]')).toContainText(
        preview.source.commitSha,
      );
      await expect(review.locator('[data-git-source-summary]')).toContainText(
        preview.source.revision.id,
      );
      await expect(review.getByRole('button', { name: '确认发布', exact: true })).toBeEnabled();
      await screenshot('06-fixed-preview-not-submitted');
      await page
        .getByRole('navigation', { name: '服务页面', exact: true })
        .getByRole('link', { name: '概览', exact: true })
        .click();
      await expect(page.locator('[data-deployment-review]')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await record('fixed-preview-not-published', {
        previewId: preview.id,
        commitSha: preview.source.commitSha,
        sourceRevisionId: preview.source.revision.id,
        serviceRevision: preview.serviceRevision,
        configRevision: preview.configRevision,
        expiresAt: preview.expiresAt,
        leftPreviewWithoutPublication: true,
      });
    });

    currentStage = 'actual-build-artifact-and-logs';
    await test.step('Match the displayed build and logs to the successful persisted deployment and Registry digest', async () => {
      const deployment = await get<DeploymentDetail>(
        page,
        '/deployments/' + state.firstDeploymentId,
      );
      if (
        deployment.snapshot.version !== 3 ||
        !deployment.build ||
        deployment.build.artifact.state !== 'registry'
      )
        throw new Error('S6_REAL_GIT_DEPLOYMENT_ARTIFACT_NOT_READY');
      const build = deployment.build;
      const artifact = deployment.build.artifact;
      expect(deployment.status).toBe('succeeded');
      expect(deployment.kind).toBe('git_deploy');
      expect(deployment.serviceId).toBe(service.id);
      expect(deployment.snapshot.source.commitSha).toBe(state.initialSha);
      expect(artifact.commitSha).toBe(state.initialSha);
      expect(artifact.sourceRevisionId).toBe(deployment.snapshot.source.revision.id);
      expect(state.firstImage.endsWith('@' + artifact.rootDigest)).toBe(true);
      expect(deployment.resolvedImage?.deployReference).toBe(state.firstImage);
      expect(build.runs.length).toBeGreaterThan(0);
      for (const run of build.runs) {
        expect(run.builderId).toBe(builder.id);
        expect(run.executionState).toBe('ended');
        expect(run.executionClosedAt).toBeTruthy();
        expect(run.proofVerifiedAt).toBeTruthy();
      }
      const run = build.runs.at(-1)!;
      const [buildLogs, deploymentLogs] = await Promise.all([
        getRaw<BuildLogPage>(
          page,
          `/deployments/${deployment.id}/build-logs?runId=${run.id}&limit=50`,
        ),
        getRaw<DeploymentLogs>(page, `/deployments/${deployment.id}/logs?limit=100`),
      ]);
      expect(buildLogs.runId).toBe(run.id);
      expect(buildLogs.source).toBe('builder');
      expect(deploymentLogs.source).toBe('deployment');
      await page.goto('/deployments/' + deployment.id);
      const summary = page.locator('[data-build-summary]');
      await expect(summary).toContainText(artifact.rootDigest);
      await expect(summary).toContainText(artifact.commitSha);
      await expect(summary).toContainText(
        artifact.image ? '已推送并核验镜像' : '已推送，等待独立镜像核验',
      );
      await summary.locator('summary').click();
      await expect(summary).toContainText(run.id);
      await expect(summary).toContainText('结束证明已核验');
      const output = page.locator('[data-build-logs]');
      await expect(output.getByLabel('选择构建执行', { exact: true })).toHaveValue(run.id);
      if (buildLogs.available && buildLogs.items.length) {
        await expect(output.locator('.build-chunk pre').last()).toHaveText(
          buildLogs.items.at(-1)!.content,
        );
      } else {
        await expect(output).toContainText(
          buildLogs.unavailableReason === 'expired'
            ? '已超过保留期限'
            : buildLogs.unavailableReason === 'not_started'
              ? '构建尚未开始'
              : '尚无可读取的构建输出',
        );
      }
      const platformLogs = page.locator('[data-deployment-logs]');
      await expect(platformLogs).toContainText('来源：平台阶段事件');
      if (deploymentLogs.available && deploymentLogs.data.length)
        await expect(platformLogs).toContainText(deploymentLogs.data[0]!.message);
      await screenshot('07-real-build-artifact-and-logs');
      await record('persisted-build-artifact-and-logs', {
        deploymentId: deployment.id,
        status: deployment.status,
        commitSha: deployment.snapshot.source.commitSha,
        sourceRevisionId: deployment.snapshot.source.revision.id,
        artifactId: artifact.id,
        rootDigest: artifact.rootDigest,
        image: deployment.resolvedImage?.deployReference,
        artifactState: artifact.state,
        artifactAvailability: artifact.availability,
        buildRuns: build.runs.map((value) => ({
          id: value.id,
          builderInstanceId: value.builderInstanceId,
          executionState: value.executionState,
          executionClosedAt: value.executionClosedAt,
          proofVerifiedAt: value.proofVerifiedAt,
        })),
        buildLogPage: {
          runId: buildLogs.runId,
          available: buildLogs.available,
          unavailableReason: buildLogs.unavailableReason,
          truncated: buildLogs.truncated,
          hasMore: buildLogs.pageInfo.hasMore,
          chunks: buildLogs.items.map((line) => ({
            sequence: line.sequence,
            phase: line.phase,
            contentSha256: hash(line.content),
            truncated: line.truncated,
          })),
        },
        deploymentLogPage: {
          available: deploymentLogs.available,
          count: deploymentLogs.data.length,
          firstMessageSha256: deploymentLogs.data[0] ? hash(deploymentLogs.data[0].message) : null,
        },
      });
    });

    currentStage = 'default-domain-observation';
    await test.step('Read independent DNS, route and local certificate observations from the real default domain', async () => {
      const [network, domain] = await Promise.all([
        get<ServiceNetworking>(page, `/services/${service.id}/networking`),
        get<Domain>(page, '/domains/' + state.resources.domain),
      ]);
      expect(domain.serviceId).toBe(service.id);
      expect(domain.hostname).toBe(state.hostname);
      expect(domain.desiredState).toBe('active');
      expect(domain.activeTask).toBeNull();
      expect(domain.observationStale).toBe(false);
      expect(domain.dns?.state).toBe('matched');
      expect(domain.route?.state).toBe('ready');
      expect(['ready', 'staging_ready', 'renewing']).toContain(domain.certificate?.state);
      expect(network.domains.some((item) => item.id === domain.id)).toBe(true);
      const networkResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === `/api/services/${service.id}/networking`,
      );
      await page.goto(location(service, 'network'));
      const networkResponse = await networkResponsePromise;
      expect(networkResponse.status()).toBe(200);
      const displayedNetwork = ((await networkResponse.json()) as Envelope<ServiceNetworking>).data;
      const displayedDomain = displayedNetwork.domains.find((item) => item.id === domain.id);
      if (!displayedDomain?.certificate) throw new Error('S6_REAL_DISPLAYED_CERTIFICATE_MISSING');
      const certificate = displayedDomain.certificate;
      expect(displayedDomain.observationStale).toBe(false);
      expect(displayedDomain.dns?.state).toBe('matched');
      expect(displayedDomain.route?.state).toBe('ready');
      expect(['ready', 'staging_ready', 'renewing']).toContain(certificate.state);
      expect(Date.parse(certificate.notBefore ?? '')).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(certificate.notAfter ?? '')).toBeGreaterThan(Date.now());
      const row = page.locator(`[data-domain-id="${domain.id}"]`);
      await expect(row).toContainText(domain.hostname);
      await expect(row.locator('[data-label="DNS"]')).toContainText('记录匹配');
      await expect(row.locator('[data-label="路由"]')).toContainText('后端已就绪');
      await expect(row.locator('[data-label="TLS"]')).toContainText(
        certificate.state === 'renewing'
          ? '正在续期'
          : certificate.authority === 'local_test'
            ? '本地测试证书'
            : certificate.environment === 'staging'
              ? '测试证书就绪'
              : '正式证书有效',
      );
      await screenshot('08-default-domain-independent-observations');
      await row.getByRole('link', { name: `查看域名 ${domain.hostname}`, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(domain.hostname);
      if (certificate.authority === 'local_test')
        await expect(page.locator('[data-network-state="certificate"]')).toContainText(
          '本地测试 CA',
        );
      await screenshot('09-default-domain-detail');
      await record('default-domain-observations', {
        domainId: domain.id,
        hostname: domain.hostname,
        serviceId: domain.serviceId,
        dnsState: domain.dns?.state,
        routeState: domain.route?.state,
        initialCertificateState: domain.certificate?.state,
        certificateState: certificate.state,
        certificateAuthority: certificate.authority,
        certificateNotBefore: certificate.notBefore,
        certificateNotAfter: certificate.notAfter,
        certificateEnvironment: domain.certificateEnvironment,
        observationStale: domain.observationStale,
        liveApplicationHttpsProof:
          'Recorded separately by the root product probe; this pass reads actual API observations',
      });
    });

    currentStage = 'no-task-or-lifecycle-side-effects';
    const after = await inventory(page, service.id);
    const afterService = await get<Service>(page, '/services/' + service.id);
    expect(after).toEqual(before);
    expect(serviceIdentity(afterService)).toEqual(beforeIdentity);
    expect(afterService.published?.image?.deployReference).toBe(state.firstImage);
    await audit.assertScope();
    await record('no-task-or-lifecycle-side-effects', { before, after, service: beforeIdentity });
    evidence.status = 'passed';
    evidence.completedAt = new Date().toISOString();
  } catch (error) {
    evidence.status = 'failed';
    evidence.failureStage = currentStage;
    evidence.failureKind = error instanceof Error ? error.name : 'UnknownError';
    throw error;
  } finally {
    await saveEvidence();
  }
});
