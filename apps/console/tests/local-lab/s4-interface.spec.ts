import { writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ids, installS4Fixture, makeDomain, servicePath, setReadyObservations } from './s4-fixture';

async function theme(page: Page, dark: boolean) {
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: dark ? '深色' : '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', dark ? 'dark' : 'light');
}

test('受控契约：空设置入口、稳定已发布端口与异步默认域名分配', async ({ page }) => {
  const state = await installS4Fixture(page);
  state.platform = { revision: 0, appsDomainSuffix: null, acmeEmail: null, updatedAt: null };
  state.networking = {
    ...state.networking,
    revision: 0,
    subdomain: null,
    entryAddresses: [],
    domainSuffix: null,
    updatedAt: null,
  };
  await page.goto(servicePath);
  const allocation = page.locator('[data-domain-allocation]');
  await expect(
    allocation.getByRole('button', { name: '分配默认域名', exact: true }),
  ).toBeDisabled();
  await expect(allocation).toContainText('请先配置默认应用后缀');
  await allocation.getByRole('link', { name: '查看平台与集群入口设置' }).click();
  await expect(page).toHaveURL(new RegExp(`/settings\\?tab=network&clusterId=${ids.cluster}$`));
  await page.getByLabel('默认应用后缀', { exact: true }).fill('apps.example.test');
  await page.getByLabel('ACME 联系邮箱', { exact: true }).fill('acme@example.test');
  await page.getByRole('button', { name: '保存平台设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存平台设置', exact: true })).toBeDisabled();
  await page.getByLabel('稳定子后缀', { exact: true }).fill('fixture');
  await page.getByLabel('入口 IPv4 / IPv6', { exact: true }).fill('192.0.2.10\n2001:db8::10');
  await page.getByRole('button', { name: '保存集群入口', exact: true }).click();
  await expect(page.getByLabel('已保存的完整后缀', { exact: true })).toHaveValue(
    'fixture.apps.example.test',
  );
  await page.goto(servicePath);
  await expect(page.getByLabel('已发布 HTTP 端口', { exact: true })).toHaveValue(ids.port);
  await expect(
    page.getByLabel('已发布 HTTP 端口', { exact: true }).locator('option:checked'),
  ).toHaveText('web · 80 / HTTP · r7');
  await expect(allocation).not.toContainText('9999');
  await page.getByRole('checkbox', { name: '已核对目标集群、HTTP 端口和 DNS 记录归属。' }).check();
  await allocation.getByRole('button', { name: '分配默认域名', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/domains/${ids.domain}\\?operation=`));
  await expect(page.locator('[data-network-operation]')).toContainText('已排队');
  await expect(page.getByRole('link', { name: '打开 HTTPS', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-domain-observations]')).toContainText('尚未检查');
  const binding = state.writes.find((entry) => entry.path.endsWith('/domains'));
  expect(binding?.body).toEqual({ revision: 12, portId: ids.port });
  expect(binding?.key).toBeTruthy();
  expect(state.writes[0].body).toMatchObject({ revision: 0 });
  expect(state.unexpected).toEqual([]);
});

test('受控契约：staging 与生产申请分离，解绑使用完整域名和异步 DELETE', async ({
  page,
  context,
}) => {
  const state = await installS4Fixture(page);
  const domain = makeDomain();
  setReadyObservations(domain);
  state.domains.push(domain);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/domains/${ids.domain}`);
  await expect(page.locator('[data-network-state="certificate"]')).toContainText('测试证书就绪');
  await expect(page.getByRole('link', { name: '打开 HTTPS', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '复制完整域名', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(domain.hostname);
  await page.getByRole('button', { name: '申请正式证书', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '申请正式证书', exact: true }).click();
  await expect(page.locator('[data-network-operation]')).toContainText('已排队');
  await expect(page.locator('[data-network-state="certificate"]')).toContainText('测试证书就绪');
  await expect(page.getByRole('link', { name: '打开 HTTPS', exact: true })).toHaveCount(0);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: `/domains/${ids.domain}/production`,
    body: { revision: 1 },
  });
  domain.activeTask = null;
  state.operations[0].status = 'failed';
  state.operations[0].errorCode = 'FIXTURE_ACME_FAILED';
  state.operations[0].errorMessage = '受控签发失败样本。';
  await page.getByRole('button', { name: '刷新域名观察', exact: true }).click();
  const unbind = page.getByRole('button', { name: '解绑审查', exact: true });
  await unbind.click();
  const dialog = page.getByRole('dialog', { name: '解绑域名与清理资源', exact: true });
  const input = dialog.getByLabel('输入完整域名确认', { exact: true });
  await input.fill('wrong.example.test');
  await expect(dialog.getByRole('button', { name: '提交解绑请求', exact: true })).toBeDisabled();
  await input.fill(domain.hostname);
  await input.dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  expect(state.writes).toHaveLength(1);
  await input.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(unbind).toBeFocused();
  await unbind.click();
  await dialog.getByLabel('输入完整域名确认', { exact: true }).fill(domain.hostname);
  await dialog.getByRole('button', { name: '提交解绑请求', exact: true }).click();
  await expect(page).toHaveURL(/\/operations\//);
  await expect(
    page.getByRole('heading', { name: '解绑域名', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator('[data-domain-operation-context]')).toContainText(domain.hostname);
  expect(state.writes[1]).toMatchObject({
    method: 'DELETE',
    path: `/domains/${ids.domain}`,
    body: { revision: 1 },
  });
  expect(state.writes[1].key).toBeTruthy();
  expect(state.unexpected).toEqual([]);
});

test('受控契约：重新应用保留域名与证书环境，拒绝可重试，任务保留固定域名上下文', async ({
  page,
}) => {
  const state = await installS4Fixture(page);
  const domain = makeDomain();
  setReadyObservations(domain, 'production');
  domain.certificate!.authority = 'local_test';
  state.domains.push(domain);
  state.reconcileConflict = true;
  await page.goto(`/domains/${ids.domain}`);
  const reconcile = page.getByRole('button', { name: '重新应用绑定', exact: true });
  await expect(reconcile).toBeEnabled();
  await expect(page.locator('[data-network-state="certificate"]')).toContainText('本地测试证书');
  await expect(page.locator('[data-network-state="certificate"]')).toContainText(
    '浏览器默认不信任',
  );
  await expect(page.getByRole('link', { name: '打开 HTTPS', exact: true })).toHaveCount(0);
  await expect(reconcile).toHaveAccessibleDescription(
    '重新应用会保留完整域名与绑定端口，使用当前已发布的服务配置。证书环境保持不变。',
  );
  await reconcile.click();
  await expect(page.locator('[data-domain-actions] [data-mutation-error]')).toContainText(
    '当前已发布配置无法提供此绑定端口',
  );
  await expect(page).toHaveURL(new RegExp(`/domains/${ids.domain}$`));
  await expect(reconcile).toBeEnabled();
  expect(state.operations).toHaveLength(0);
  state.reconcileConflict = false;
  await reconcile.click();
  await expect(page.locator('[data-network-operation]')).toContainText('已排队');
  await expect(reconcile).toBeDisabled();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(domain.hostname);
  expect(state.writes).toHaveLength(2);
  expect(
    state.writes.every(
      (entry) => entry.method === 'POST' && entry.path === `/domains/${ids.domain}/reconcile`,
    ),
  ).toBe(true);
  expect(state.writes[0].body).toEqual({ revision: 1 });
  expect(state.writes[1].body).toEqual({ revision: 1 });
  expect(state.writes[0].key).toBeTruthy();
  expect(state.writes[1].key).toBe(state.writes[0].key);
  expect(domain.certificateEnvironment).toBe('production');
  expect(state.operations[0].kind).toBe('domain_reconcile');
  await page
    .locator('[data-network-operation]')
    .getByRole('link', { name: '查看本次任务', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '重新应用绑定', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-domain-operation-context]')).toContainText(domain.hostname);
  domain.activeTask = null;
  state.restoreMode = true;
  await page.goto(`/domains/${ids.domain}`);
  await expect(reconcile).toBeDisabled();
  state.restoreMode = false;
  domain.desiredState = 'deleting';
  await page.goto(`/domains/${ids.domain}`);
  await expect(reconcile).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
});

test('受控契约：版本冲突保留输入，离页后的保存响应不导航或弹出成功提示', async ({ page }) => {
  const state = await installS4Fixture(page);
  state.platformConflict = true;
  await page.goto('/settings?tab=network');
  const suffix = page.getByLabel('默认应用后缀', { exact: true });
  await suffix.fill('changed.example.test');
  await page.getByRole('button', { name: '保存平台设置', exact: true }).click();
  await expect(
    page.locator('[data-platform-networking-settings] [data-mutation-error]'),
  ).toContainText(makeDomain().hostname);
  await expect(suffix).toHaveValue('changed.example.test');
  const domainNav = page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '域名与网络', exact: true });
  await domainNav.click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(suffix).toHaveValue('changed.example.test');
  let release!: () => void;
  let accepted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  state.platformConflict = false;
  state.beforePlatformReply = () => {
    accepted();
    return gate;
  };
  const response = page.waitForResponse(
    (value) =>
      value.request().method() === 'PATCH' &&
      new URL(value.url()).pathname === '/api/platform-settings',
  );
  await page.getByRole('button', { name: '保存平台设置', exact: true }).click();
  await entered;
  await domainNav.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '放弃修改并离开', exact: true })
    .click();
  await expect(page).toHaveURL(/\/domains$/);
  release();
  await response;
  await expect(
    page.getByRole('heading', { name: '域名与网络', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '平台入口设置已保存。' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/domains$/);
  expect(state.unexpected).toEqual([]);
});

test('受控契约：域名搜索覆盖完整集合，游标每次只返回 50 行', async ({ page }) => {
  const state = await installS4Fixture(page);
  for (let index = 0; index < 61; index++) {
    const domain = makeDomain();
    domain.id = `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    domain.serviceId = `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    domain.hostname = `${index === 60 ? 'last-searchable' : `service-${index}`}.fixture.apps.example.test`;
    state.domains.push(domain);
  }
  await page.goto('/domains');
  await expect(page.locator('[data-domain-id]')).toHaveCount(50);
  await page.getByLabel('搜索域名或服务', { exact: true }).fill('last-searchable');
  await expect(page.locator('[data-domain-id]')).toHaveCount(1);
  await expect(page.locator('[data-domain-id]')).toContainText('last-searchable');
  await page.getByLabel('搜索域名或服务', { exact: true }).fill('');
  await expect(page.locator('[data-domain-id]')).toHaveCount(50);
  await page.getByRole('button', { name: '载入更多域名', exact: true }).click();
  await expect(page.locator('[data-domain-id]')).toHaveCount(61);
  expect(
    state.reads
      .filter((entry) => entry.path === '/domains')
      .every((entry) => entry.query.limit === '50'),
  ).toBe(true);
  expect(
    state.reads.some((entry) => entry.path === '/domains' && entry.query.cursor === '50'),
  ).toBe(true);
  expect(state.unexpected).toEqual([]);
});

test('受控界面：五个网络表面覆盖 1440/1024/390 与明暗主题', async ({ page }, info) => {
  const state = await installS4Fixture(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const samples: unknown[] = [];
  const domain = makeDomain();
  setReadyObservations(domain, 'production');
  domain.dns = {
    ...domain.dns!,
    state: 'mismatch',
    addresses: ['2001:db8::9999'],
    code: 'DNS_ADDRESS_MISMATCH',
    message: 'AAAA 记录与预期入口不一致，路由和证书仍分别显示各自的观察。',
  };
  domain.certificate!.notAfter = new Date(Date.now() - 3600_000).toISOString();
  domain.observationStale = true;
  state.networking.capabilities = {
    observedAt: new Date().toISOString(),
    ingressClass: 'ready',
    ingressClassName: 'traefik',
    traefikMiddleware: 'ready',
    certManager: 'missing',
    certManagerVersion: null,
    permissions: 'ready',
    issues: [{ code: 'CERT_MANAGER_MISSING', message: '目标集群尚未安装 cert-manager。' }],
  };
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const dark of [false, true]) {
      for (const surface of ['settings', 'allocation', 'collection', 'detail', 'unbind']) {
        state.domains = surface === 'allocation' ? [] : [domain];
        const path =
          surface === 'settings'
            ? '/settings?tab=network'
            : surface === 'allocation'
              ? servicePath
              : surface === 'collection'
                ? '/domains'
                : `/domains/${ids.domain}`;
        await page.goto(path);
        await expect(page.locator('h1')).toBeVisible();
        await expect(page.locator('.skeleton')).toHaveCount(0);
        await theme(page, dark);
        if (surface === 'unbind')
          await page.getByRole('button', { name: '解绑审查', exact: true }).click();
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => undefined)),
          );
        });
        if (surface !== 'unbind')
          await page.evaluate(() => {
            window.scrollTo(0, 0);
            document.getElementById('main-content')?.focus();
          });
        const overflow = await page.evaluate(() => ({
          width: innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        expect(overflow.document).toBeLessThanOrEqual(width + 1);
        expect(overflow.body).toBeLessThanOrEqual(width + 1);
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(axe.violations).toEqual([]);
        const name = `${surface}-${width}-${dark ? 'dark' : 'light'}`;
        const pathToScreenshot = info.outputPath(`${name}.png`);
        await page.screenshot({
          path: pathToScreenshot,
          fullPage: surface !== 'unbind',
          animations: 'disabled',
        });
        samples.push({
          surface,
          width,
          dark,
          overflow,
          axeViolations: axe.violations.length,
          screenshot: pathToScreenshot,
        });
      }
    }
  }
  expect(errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.writes).toEqual([]);
  const path = info.outputPath('interface-matrix.json');
  await writeFile(path, JSON.stringify({ source: state.source, samples, errors }, null, 2));
  await info.attach('controlled-interface-matrix', { path, contentType: 'application/json' });
});
