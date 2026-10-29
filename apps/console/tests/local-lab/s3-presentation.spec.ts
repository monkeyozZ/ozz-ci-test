import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { components } from '@ozz/api-client';
import { login, api } from '../e2e/helpers';

type Service = components['schemas']['ServiceResponseDto'];
type Deployment = components['schemas']['DeploymentDetailDto'];
const failureId = process.env.S3_FAILURE_DEPLOYMENT_ID;

async function setTheme(page: Page, dark: boolean) {
  await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: dark ? '深色' : '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', dark ? 'dark' : 'light');
}

test('真实运行事件、非零 CPU、日志换行与删除后的失败证据', async ({ page, context }, info) => {
  test.skip(
    !failureId,
    'Set S3_FAILURE_DEPLOYMENT_ID to a retained real failed deployment with captured observation.',
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  const lab = JSON.parse(
    await readFile(
      new URL('../../../../.local/local-lab/service-product-state.json', import.meta.url),
      'utf8',
    ),
  ) as { services: { a: string } };
  const service: Service = await api(page.request, `/services/${lab.services.a}`);
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
    )
      writes.push(request.method());
  });
  await page.goto(
    `/projects/${service.projectId}/services/${service.id}?environment=${service.environment.slug}`,
  );
  const runtime = page.locator('[data-service-runtime]');
  const eventCount = service.observation?.events.length ?? 0;
  if (eventCount)
    await expect(runtime.locator('.event-list li')).toHaveCount(Math.min(5, eventCount));
  if (eventCount > 5) {
    const toggle = runtime.getByRole('button', { name: /展开其余|只显示最近/ });
    await toggle.click();
    await expect(runtime.locator('.event-list li')).toHaveCount(eventCount);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(runtime.locator('.event-list li')).toHaveCount(5);
    await expect(toggle).toBeFocused();
  }
  const cpu = await runtime
    .locator('.runtime-summary > div')
    .filter({ has: page.getByText('当前 CPU', { exact: true }) })
    .locator('dd')
    .innerText();
  if ((service.observation?.metrics.cpuCores ?? 0) > 0 && cpu !== '未知')
    expect(cpu).not.toBe('0 核');
  await page
    .getByRole('navigation', { name: '服务页面' })
    .getByRole('link', { name: '容器日志', exact: true })
    .click();
  await page.getByRole('button', { name: '读取日志尾部', exact: true }).click();
  await expect(page.locator('[data-log-end-reason="eof"]')).toBeVisible();
  const log = page.locator('.runtime-log-output pre');
  await page.getByRole('button', { name: '复制缓冲日志', exact: true }).click();
  const rawText = await page.evaluate(() => navigator.clipboard.readText());
  expect(rawText).toBeTruthy();
  await expect(log).toHaveCSS('white-space', 'pre');
  await page.getByRole('checkbox', { name: '长行换行', exact: true }).check();
  await expect(log).toHaveCSS('white-space', 'pre-wrap');
  await page.getByRole('button', { name: '复制缓冲日志', exact: true }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())) === rawText).toBe(true);

  const failure: Deployment = await api(page.request, `/deployments/${failureId}`);
  expect(failure.status).toBe('failed');
  expect(failure.failureObservation).not.toBeNull();
  await page.goto(`/deployments/${failureId}`);
  const diagnostic = page.locator('[data-deployment-failure-observation]');
  await expect(diagnostic).toBeVisible();
  await expect(diagnostic).not.toHaveAttribute('open');
  const evidence = failure.failureObservation!;
  await diagnostic.locator('summary').click();
  await expect(diagnostic).toHaveAttribute('open', '');
  await expect(diagnostic).toContainText(`第 ${evidence.attempt} 次尝试失败时保留的观察`);
  await expect(diagnostic).toContainText(evidence.errorCode);
  await expect(diagnostic).toContainText('证据采集于');
  await expect(diagnostic).toContainText('运行采样于');
  if (failure.serviceId === null) {
    await expect(page.getByRole('link', { name: '返回服务', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '审阅原部署重试', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '面包屑', exact: true })).toContainText(
      '历史部署',
    );
  }
  const deploymentLog = page.locator('[data-deployment-logs]');
  if (await deploymentLog.getByRole('checkbox', { name: '长行换行', exact: true }).isVisible()) {
    await deploymentLog.getByRole('checkbox', { name: '长行换行', exact: true }).uncheck();
    await expect(deploymentLog.locator('.log-message').first()).toHaveCSS('white-space', 'pre');
    await deploymentLog.getByRole('checkbox', { name: '长行换行', exact: true }).check();
    await expect(deploymentLog.locator('.log-message').first()).toHaveCSS(
      'white-space',
      'pre-wrap',
    );
  }
  const samples = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const dark of [false, true]) {
      await setTheme(page, dark);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(overflow.document).toBeLessThanOrEqual(width + 1);
      expect(overflow.body).toBeLessThanOrEqual(width + 1);
      const scan = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(scan.violations).toEqual([]);
      const name = `retained-failure-${width}-${dark ? 'dark' : 'light'}`;
      const path = info.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await info.attach(name, { path, contentType: 'image/png' });
      samples.push({ width, dark, overflow, axeViolations: scan.violations.length });
    }
  }
  const after: Deployment = await api(page.request, `/deployments/${failureId}`);
  expect(after.failureObservation).toEqual(evidence);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
  const path = info.outputPath('presentation-evidence.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        serviceId: service.id,
        eventCount,
        cpuLabel: cpu,
        logTextPreserved: true,
        failureId,
        historicalServiceDeleted: failure.serviceId === null,
        attempt: evidence.attempt,
        errorCode: evidence.errorCode,
        capturedAt: evidence.capturedAt,
        observedAt: evidence.observedAt,
        samples,
      },
      null,
      2,
    ),
  );
  await info.attach('presentation-evidence', { path, contentType: 'application/json' });
});
