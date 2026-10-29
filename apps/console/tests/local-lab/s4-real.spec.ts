import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { test, expect, type Page, type Request, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { components } from '@ozz/api-client';
import { login } from '../e2e/helpers';

type Schema = components['schemas'];
type Service = Schema['ServiceResponseDto'];
type Domain = Schema['DomainDto'];
type Networking = Schema['ServiceNetworkingDto'];
type Operation = Schema['OperationDto'];
type DomainInput = Schema['DomainOperationInputDto'];
type DomainResult = Schema['DomainOperationResultDto'];
type Scope = {
  version: 1;
  service: { id: string; slug: 'ui-check'; projectId: string; clusterId: string };
  preservedServiceIds: string[];
};
type Write = {
  method: string;
  path: string;
  origin: string | null;
  hasCsrfToken: boolean;
  hasIdempotencyKey: boolean;
  status: number | null;
};
const origin = 'http://127.0.0.1:5173';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readScope(): Promise<Scope> {
  const path = process.env.S4_REAL_STATE_PATH;
  if (!path || !isAbsolute(path))
    throw new Error('Set S4_REAL_STATE_PATH to the protected, dedicated S4 UI state file.');
  if (((await stat(path)).mode & 0o077) !== 0)
    throw new Error('The S4 UI state file must not be accessible to other users.');
  const scope = JSON.parse(await readFile(path, 'utf8')) as Scope;
  if (
    scope.version !== 1 ||
    scope.service?.slug !== 'ui-check' ||
    ![scope.service.id, scope.service.projectId, scope.service.clusterId].every((id) =>
      uuid.test(id),
    ) ||
    !Array.isArray(scope.preservedServiceIds) ||
    scope.preservedServiceIds.length !== 2 ||
    !scope.preservedServiceIds.every((id) => uuid.test(id)) ||
    new Set([scope.service.id, ...scope.preservedServiceIds]).size !== 3
  )
    throw new Error('S4 UI scope requires ui-check and two distinct preserved S4 A/B services.');
  return {
    version: 1,
    service: {
      id: scope.service.id,
      slug: scope.service.slug,
      projectId: scope.service.projectId,
      clusterId: scope.service.clusterId,
    },
    preservedServiceIds: [...scope.preservedServiceIds],
  };
}

async function authenticate(page: Page) {
  try {
    await login(page);
  } catch {
    // Avoid retaining credential-bearing action errors or login page snapshots.
    await page.goto('about:blank').catch(() => undefined);
    throw new Error('Real UI login failed; credential details were not retained.');
  }
}

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  expect(response.status(), `GET /api${path}`).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

function serviceLocation(service: Service) {
  const query = new URLSearchParams({ environment: service.environment.slug, tab: 'network' });
  return `/projects/${service.projectId}/services/${service.id}?${query}`;
}

function serviceConfiguration(service: Service) {
  return {
    id: service.id,
    projectId: service.projectId,
    environmentId: service.environmentId,
    clusterId: service.clusterId,
    configRevision: service.configRevision,
    desiredState: service.desiredState,
    publishedDeploymentId: service.published?.deploymentId ?? null,
    hasUnpublishedChanges: service.hasUnpublishedChanges,
  };
}

function domainIdentity(domain: Domain) {
  return {
    id: domain.id,
    hostname: domain.hostname,
    serviceId: domain.serviceId,
    projectId: domain.project.id,
    environmentId: domain.environment.id,
    clusterId: domain.cluster.id,
    portId: domain.servicePort.id,
    portName: domain.servicePort.name,
    certificateEnvironment: domain.certificateEnvironment,
  };
}

function domainEvidence(domain: Domain) {
  return {
    ...domainIdentity(domain),
    revision: domain.revision,
    desiredState: domain.desiredState,
    dns: domain.dns && {
      state: domain.dns.state,
      observedAt: domain.dns.observedAt,
      addresses: domain.dns.addresses,
      expectedAddresses: domain.dns.expectedAddresses,
      code: domain.dns.code,
    },
    route: domain.route && {
      state: domain.route.state,
      observedAt: domain.route.observedAt,
      ingressNames: domain.route.ingressNames,
      readyEndpoints: domain.route.readyEndpoints,
      code: domain.route.code,
    },
    certificate: domain.certificate && {
      authority: domain.certificate.authority,
      state: domain.certificate.state,
      environment: domain.certificate.environment,
      observedAt: domain.certificate.observedAt,
      notBefore: domain.certificate.notBefore,
      notAfter: domain.certificate.notAfter,
      renewalTime: domain.certificate.renewalTime,
      code: domain.certificate.code,
    },
    observationStale: domain.observationStale,
    lastErrorCode: domain.lastErrorCode,
  };
}

function domainInput(operation: Operation): DomainInput {
  if (!('domainId' in operation.input)) throw new Error('Expected a real domain operation.');
  return operation.input;
}

async function accepted(
  page: Page,
  path: string,
  method: 'POST' | 'DELETE',
  trigger: () => Promise<unknown>,
): Promise<Operation> {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === `/api${path}`,
  );
  await trigger();
  const response = await pending;
  if (response.status() !== 202) {
    const problem = (await response.json().catch(() => ({}))) as { code?: unknown };
    const code =
      typeof problem.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(problem.code)
        ? problem.code
        : 'UNAVAILABLE';
    throw new Error(`${method} /api${path}: HTTP ${response.status()}, code ${code}`);
  }
  return ((await response.json()) as { data: Operation }).data;
}

async function completed(page: Page, operation: Operation) {
  let current = operation;
  await expect
    .poll(
      async () => {
        current = await get<Operation>(page, `/operations/${operation.id}`);
        return ['queued', 'running'].includes(current.status);
      },
      {
        timeout: 180_000,
        intervals: [1000, 2000, 3000],
        message: `${operation.kind} terminal state`,
      },
    )
    .toBe(false);
  expect(current.status, current.errorCode ?? operation.kind).toBe('succeeded');
  await expect(page.locator('.page-head .badge')).toHaveText('已完成');
  return current;
}

async function localCertificate(page: Page, domainId: string) {
  let current = await get<Domain>(page, `/domains/${domainId}`);
  await expect
    .poll(
      async () => {
        current = await get<Domain>(page, `/domains/${domainId}`);
        return {
          dns: current.dns?.state,
          route: current.route?.state,
          certificate: current.certificate?.state,
          authority: current.certificate?.authority,
          fresh: !current.observationStale,
          valid: Date.parse(current.certificate?.notAfter ?? '') > Date.now(),
        };
      },
      { timeout: 180_000, intervals: [1500, 3000, 5000], message: 'Actual local CA observations' },
    )
    .toEqual({
      dns: 'matched',
      route: 'ready',
      certificate: 'staging_ready',
      authority: 'local_test',
      fresh: true,
      valid: true,
    });
  return current;
}

async function appearance(page: Page, width: number, dark: boolean) {
  await page.setViewportSize({ width, height: 1000 });
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: dark ? '深色' : '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', dark ? 'dark' : 'light');
}

async function sample(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('.skeleton')).toHaveCount(0);
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.width + 1);
  expect(overflow.body).toBeLessThanOrEqual(overflow.width + 1);
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = scan.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.length,
  }));
  expect(violations).toEqual([]);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await chmod(path, 0o600);
  await info.attach(name, { path, contentType: 'image/png' });
  return { name, overflow, axeViolations: violations.length };
}

test('真实 S4 登录与只读预检', async ({ page }, info) => {
  const scope = await readScope();
  await authenticate(page);
  const writes: Array<{ method: string; path: string }> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      writes.push({ method: request.method(), path });
  });
  const service = await get<Service>(page, `/services/${scope.service.id}`);
  expect({
    id: service.id,
    slug: service.slug,
    projectId: service.projectId,
    clusterId: service.clusterId,
  }).toEqual(scope.service);
  const network = await get<Networking>(page, `/services/${service.id}/networking`);
  expect(network.project.id).toBe(scope.service.projectId);
  expect(network.cluster.id).toBe(scope.service.clusterId);
  await page.goto(serviceLocation(service));
  await expect(page.locator('[data-service-networking]')).toBeVisible();
  await expect(page.locator('[data-domain-allocation]')).toBeVisible();
  await appearance(page, 1440, false);
  const surface = await sample(page, info, 'real-service-network-preflight-1440-light');
  expect(writes).toEqual([]);
  const path = info.outputPath('real-networking-preflight.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        source: 'real authenticated API and current source UI',
        passed: true,
        domainWritesPerformed: false,
        scope,
        serviceConfiguration: serviceConfiguration(service),
        eligiblePorts: network.eligiblePorts,
        blockers: network.blockers.map(({ code }) => code),
        surface,
        writes,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await info.attach('real-networking-preflight', { path, contentType: 'application/json' });
});

test('真实 S4：专用服务分配、独立观察、只读检查、重新应用与完整域名解绑', async ({
  page,
  context,
}, info) => {
  // This suite intentionally has no page.route(), fetch replacement, storageState,
  // direct API mutation, or Kubernetes access. Every domain write uses its real UI.
  const scope = await readScope();
  let phase = 'login';
  let authenticated = false;
  let passed = false;
  let unbound = false;
  let domain: Domain | undefined;
  let allocatedDomainId: string | null = null;
  let pageErrorCount = 0;
  let headerReadFailures = 0;
  let confirmationReachability:
    { withinViewport: boolean; pointerAtCenter: boolean; notifications: number } | undefined;
  const writes: Write[] = [];
  const requests = new Map<Request, Write>();
  const headerReads: Array<Promise<void>> = [];
  const operations: Array<{ id: string; kind: string; status: string; errorCode: string | null }> =
    [];
  const observations: Array<{ phase: string; domain: ReturnType<typeof domainEvidence> }> = [];
  const samples: Array<Awaited<ReturnType<typeof sample>>> = [];
  let before: ReturnType<typeof serviceConfiguration> | undefined;
  const remember = (value: Operation) => {
    operations.push({
      id: value.id,
      kind: value.kind,
      status: value.status,
      errorCode: value.errorCode,
    });
  };

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await authenticate(page);
    authenticated = true;
    page.on('pageerror', () => pageErrorCount++);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        !url.pathname.startsWith('/api/') ||
        ['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      )
        return;
      const entry: Write = {
        method: request.method(),
        path: url.pathname,
        origin: null,
        hasCsrfToken: false,
        hasIdempotencyKey: false,
        status: null,
      };
      requests.set(request, entry);
      writes.push(entry);
      // Chromium reports browser-added headers through its extra-info event.
      // Read the requested values asynchronously; never retain a complete header map.
      headerReads.push(
        Promise.all([
          request.headerValue('origin'),
          request.headerValue('x-csrf-token'),
          request.headerValue('idempotency-key'),
        ])
          .then(([requestOrigin, csrf, key]) => {
            entry.origin = requestOrigin;
            entry.hasCsrfToken = !!csrf;
            entry.hasIdempotencyKey = !!key;
          })
          .catch(() => {
            headerReadFailures++;
          }),
      );
    });
    page.on('response', (response) => {
      const entry = requests.get(response.request());
      if (entry) entry.status = response.status();
    });

    phase = 'scope-preflight';
    const service = await get<Service>(page, `/services/${scope.service.id}`);
    expect({
      id: service.id,
      slug: service.slug,
      projectId: service.projectId,
      clusterId: service.clusterId,
    }).toEqual(scope.service);
    expect(service.activeTask).toBeNull();
    expect(service.published).not.toBeNull();
    expect(service.desiredState).toBe('running');
    before = serviceConfiguration(service);
    const network = await get<Networking>(page, `/services/${service.id}/networking`);
    expect(network.serviceId).toBe(service.id);
    expect(network.project.id).toBe(scope.service.projectId);
    expect(network.cluster.id).toBe(scope.service.clusterId);
    expect(network.blockers).toEqual([]);
    expect(network.domains, 'Refuse to reuse a domain from a previous run.').toEqual([]);
    expect(network.eligiblePorts.length).toBeGreaterThan(0);
    const port = network.eligiblePorts[0]!;
    const servicePath = serviceLocation(service);
    await page.goto(servicePath);
    await expect(page.locator('[data-service-networking]')).toBeVisible();
    await expect(page.getByLabel('已发布 HTTP 端口', { exact: true })).toHaveValue(port.id);
    await expect(
      page.getByLabel('已发布 HTTP 端口', { exact: true }).locator('option:checked'),
    ).toContainText(`r${port.publishedConfigRevision}`);
    await appearance(page, 1440, false);
    samples.push(await sample(page, info, 'allocation-1440-light'));

    phase = 'bind';
    const allocation = page.locator('[data-domain-allocation]');
    await expect(
      allocation.getByRole('button', { name: '分配默认域名', exact: true }),
    ).toBeDisabled();
    await allocation
      .getByRole('checkbox', { name: '已核对目标集群、HTTP 端口和 DNS 记录归属。' })
      .check();
    const binding = await accepted(page, `/services/${service.id}/domains`, 'POST', () =>
      allocation.getByRole('button', { name: '分配默认域名', exact: true }).click(),
    );
    remember(binding);
    expect(binding.kind).toBe('domain_bind');
    const input = domainInput(binding);
    allocatedDomainId = input.domainId;
    expect(input.serviceId).toBe(service.id);
    expect(input.target.projectId).toBe(scope.service.projectId);
    expect(input.target.clusterId).toBe(scope.service.clusterId);
    expect(input.target.portId).toBe(port.id);
    expect(input.certificateEnvironment).toBe('staging');
    await expect(page).toHaveURL(`${origin}/domains/${input.domainId}?operation=${binding.id}`);
    await page
      .locator('[data-network-operation]')
      .getByRole('link', { name: '查看本次任务', exact: true })
      .click();
    await expect(page).toHaveURL(`${origin}/operations/${binding.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('分配默认域名');
    await expect(page.locator('[data-domain-operation-context]')).toContainText(input.hostname);
    remember(await completed(page, binding));

    phase = 'local-certificate';
    domain = await localCertificate(page, input.domainId);
    const identity = domainIdentity(domain);
    observations.push({ phase, domain: domainEvidence(domain) });
    await page.getByRole('link', { name: '查看域名独立检查', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(domain.hostname);
    await expect(page.locator('[data-network-state="dns"]')).toContainText('记录匹配');
    await expect(page.locator('[data-network-state="route"]')).toContainText('后端已就绪');
    await expect(page.locator('[data-network-state="certificate"]')).toContainText('本地测试证书');
    await expect(page.locator('[data-network-state="certificate"]')).toContainText(
      '浏览器默认不信任',
    );
    await expect(page.getByRole('link', { name: '打开 HTTPS', exact: true })).toHaveCount(0);
    for (const width of [1440, 390]) {
      for (const dark of [false, true]) {
        await appearance(page, width, dark);
        samples.push(await sample(page, info, `domain-${width}-${dark ? 'dark' : 'light'}`));
      }
    }

    phase = 'refresh';
    const beforeRefresh = writes.length;
    const refreshed = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/api/domains/${domain!.id}`,
    );
    await page.getByRole('button', { name: '刷新域名观察', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    expect(writes).toHaveLength(beforeRefresh);

    for (const action of ['sync', 'reconcile'] as const) {
      phase = action;
      const label = action === 'sync' ? '重新检查' : '重新应用绑定';
      const operation = await accepted(page, `/domains/${domain.id}/${action}`, 'POST', () =>
        page.getByRole('button', { name: label, exact: true }).click(),
      );
      remember(operation);
      expect(operation.kind).toBe(`domain_${action}`);
      expect(operation.serviceId).toBe(service.id);
      expect(domainInput(operation).domainId).toBe(domain.id);
      expect(domainInput(operation).certificateEnvironment).toBe(identity.certificateEnvironment);
      await page
        .locator('[data-network-operation]')
        .getByRole('link', { name: '查看本次任务', exact: true })
        .click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        action === 'sync' ? '域名网络检查' : '重新应用绑定',
      );
      await expect(page.locator('[data-domain-operation-context]')).toContainText(
        identity.hostname,
      );
      const finished = await completed(page, operation);
      remember(finished);
      expect((finished.result as DomainResult).action).toBe(action);
      domain = await get<Domain>(page, `/domains/${domain.id}`);
      expect(domainIdentity(domain)).toEqual(identity);
      observations.push({ phase, domain: domainEvidence(domain) });
      await page.getByRole('link', { name: '查看域名独立检查', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(identity.hostname);
    }

    phase = 'unbind-confirmation';
    await page.getByRole('button', { name: '复制完整域名', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '完整域名已复制。' })).toBeVisible();
    const unbind = page.getByRole('button', { name: '解绑审查', exact: true });
    await unbind.click();
    const dialog = page.getByRole('dialog', { name: '解绑域名与清理资源', exact: true });
    const confirmation = dialog.getByLabel('输入完整域名确认', { exact: true });
    const submit = dialog.getByRole('button', { name: '提交解绑请求', exact: true });
    await confirmation.fill(domain.hostname.split('.')[0]!);
    await expect(submit).toBeDisabled();
    const beforeCancel = writes.length;
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(unbind).toBeFocused();
    expect(writes).toHaveLength(beforeCancel);
    await unbind.click();
    await confirmation.fill(domain.hostname);
    await expect(submit).toBeEnabled();
    confirmationReachability = await submit.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        withinViewport:
          rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        pointerAtCenter: hit === element || (hit !== null && element.contains(hit)),
        notifications: document.querySelectorAll('.toast').length,
      };
    });
    expect(confirmationReachability.notifications).toBeGreaterThan(0);
    expect(confirmationReachability.withinViewport).toBe(true);
    expect(confirmationReachability.pointerAtCenter).toBe(true);
    samples.push(await sample(page, info, 'unbind-390-dark'));
    const removal = await accepted(page, `/domains/${domain.id}`, 'DELETE', () => submit.click());
    remember(removal);
    expect(removal.kind).toBe('domain_unbind');
    expect(domainInput(removal).hostname).toBe(identity.hostname);
    await expect(page).toHaveURL(`${origin}/operations/${removal.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('解绑域名');
    remember(await completed(page, removal));
    expect((await page.request.get(`/api/domains/${domain.id}`)).status()).toBe(404);
    unbound = true;
    await expect(page.locator('[data-domain-operation-context]')).toContainText(identity.hostname);
    await expect(page.locator('[data-domain-operation-context]')).toContainText(
      '本次解绑已完成，固定目标与任务记录保留。',
    );
    samples.push(await sample(page, info, 'retained-unbind-operation-390-dark'));
    await page.getByRole('link', { name: '返回域名列表', exact: true }).click();
    await page.getByLabel('搜索域名或服务', { exact: true }).fill(identity.hostname);
    await expect(page.locator('[data-domain-id]')).toHaveCount(0);
    await page.goto(servicePath);
    await expect(page.locator('[data-domain-allocation]')).toBeVisible();
    expect(serviceConfiguration(await get<Service>(page, `/services/${service.id}`))).toEqual(
      before,
    );

    phase = 'verify-write-scope';
    await Promise.all(headerReads);
    expect(headerReadFailures).toBe(0);
    expect(writes.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: `/api/services/${service.id}/domains` },
      { method: 'POST', path: `/api/domains/${domain.id}/sync` },
      { method: 'POST', path: `/api/domains/${domain.id}/reconcile` },
      { method: 'DELETE', path: `/api/domains/${domain.id}` },
    ]);
    for (const entry of writes)
      expect(entry).toMatchObject({
        origin,
        hasCsrfToken: true,
        hasIdempotencyKey: true,
        status: 202,
      });
    expect(pageErrorCount).toBe(0);
    passed = true;
    phase = 'completed';
  } finally {
    await Promise.all(headerReads);
    const path = info.outputPath('real-networking-evidence.json');
    await writeFile(
      path,
      JSON.stringify(
        {
          source: 'real API, real Worker and dedicated S4 local clusters; no API interception',
          passed,
          phase,
          authenticated,
          scope,
          serviceConfiguration: before,
          remainingDomainId: unbound ? null : allocatedDomainId,
          unbound,
          operations,
          observations,
          writes,
          samples,
          confirmationReachability,
          pageErrorCount,
          headerReadFailures,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await info.attach('real-networking-evidence', { path, contentType: 'application/json' });
  }
});
