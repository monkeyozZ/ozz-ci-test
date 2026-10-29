import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installCreationFixture } from './creation-v3-fixture';
import { installImageWorkspaceFixture } from './service-workspace-v3-fixture';
import { s5Ids } from '../fixtures/s5-data';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function viewportMetrics(page: Page) {
  return page.evaluate(() => ({
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    visualViewportScale: window.visualViewport?.scale,
    visualViewportWidth: window.visualViewport?.width,
    visualViewportHeight: window.visualViewport?.height,
    htmlZoom: getComputedStyle(document.documentElement).zoom,
    bodyZoom: getComputedStyle(document.body).zoom,
    documentWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
}

async function expectUsableControl(control: Locator, page: Page) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox();
  const viewport = await viewportMetrics(page);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.innerWidth + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.innerHeight + 1);
  await control.click({ trial: true });
}

test('原生 200% 页面缩放保留服务设置、创建复核、长文本和普通键盘操作', async ({
  playwright,
}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'ozz-native-zoom-'));
  const zoomFactor = 2;
  const zoomLevel = Math.log(zoomFactor) / Math.log(1.2);
  const channel = process.env.CI ? 'chromium' : 'chrome';
  const checkpoints: Array<{ name: string; metrics: Awaited<ReturnType<typeof viewportMetrics>> }> =
    [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  let context: BrowserContext | undefined;
  let browserVersion: string | undefined;
  let nativeWindow: unknown;
  let screenshotSize: { width: number; height: number } | undefined;
  try {
    await mkdir(join(profile, 'Default'));
    // ChromeZoomLevelPrefs uses "x" for the default storage partition. This is
    // the browser's native page-zoom preference, not CSS zoom or CDP emulation.
    // https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc
    await writeFile(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ partition: { default_zoom_level: { x: zoomLevel } } }),
    );
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel,
      headless: true,
      viewport: null,
      baseURL: testInfo.project.use.baseURL ?? 'http://127.0.0.1:5199',
      serviceWorkers: 'block',
      args: ['--window-size=1440,1000', '--force-device-scale-factor=1'],
    });
    browserVersion = context.browser()?.version();
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (error) => errors.push(error.message));
    const checkpoint = async (name: string) => {
      const metrics = await viewportMetrics(page);
      checkpoints.push({ name, metrics });
      // Force device scale 1 + a 1440px native window must yield ~720 CSS pixels
      // and DPR 2. A small viewport, CSS zoom, or pinch zoom cannot pass this set.
      expect(metrics.outerWidth, name).toBe(1440);
      expect(metrics.innerWidth, name).toBeGreaterThanOrEqual(719);
      expect(metrics.innerWidth, name).toBeLessThanOrEqual(721);
      expect(metrics.devicePixelRatio, name).toBeCloseTo(2, 5);
      expect(metrics.visualViewportScale, name).toBe(1);
      expect(metrics.htmlZoom, name).toBe('1');
      expect(metrics.bodyZoom, name).toBe('1');
      expect(metrics.documentScrollWidth, `${name}：页面没有横向溢出`).toBeLessThanOrEqual(
        metrics.innerWidth + 1,
      );
    };

    await test.step('服务设置：长名称不撑破页面，保存与六个页面入口可达', async () => {
      const state = await installImageWorkspaceFixture(page);
      state.service.name = `200-percent-zoom-long-service-name-${'x'.repeat(70)}`;
      await page.goto(state.pathFor('configuration'));
      const name = page.getByLabel('服务名称', { exact: true });
      await expect(name).toHaveValue(state.service.name);
      const session = await context!.newCDPSession(page);
      nativeWindow = await session.send('Browser.getWindowForTarget');
      await session.detach();
      await checkpoint('service-settings-long-name');
      await expectUsableControl(name, page);
      await name.focus();
      await page.keyboard.press('End');
      await page.keyboard.type('-edited');
      const save = page.getByRole('button', { name: '保存草稿', exact: true });
      await expectUsableControl(save, page);
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(save).toBeDisabled();
      expect(state.writes.filter((write) => write.method === 'PATCH')).toHaveLength(1);
      expect(state.service.name.endsWith('-edited')).toBe(true);

      const tabs = page.getByRole('navigation', { name: '服务页面', exact: true });
      const links = tabs.getByRole('link');
      await expect(links).toHaveCount(6);
      for (const link of await links.all()) {
        await expectUsableControl(link, page);
        await link.focus();
        await expect(link).toBeFocused();
      }
      await checkpoint('service-settings-saved');
      unexpected.push(...state.unexpected);
    });

    // Detach the live fixture page before changing interception. No API request
    // can escape to a backend between the two sets of controlled responses.
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });

    await test.step('创建：方向键选来源，Tab 编辑，Escape 返回，复核与配置往返', async () => {
      const state = await installCreationFixture(page);
      await page.goto(`/projects/${s5Ids.project}?environment=staging&createService=1`);
      const dialog = page.getByRole('dialog', { name: '添加服务', exact: true });
      await expect(dialog.locator('.source-option').first()).toBeFocused();
      await checkpoint('creation-source');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const name = dialog.getByLabel('服务名称', { exact: true });
      const image = dialog.getByLabel('镜像地址', { exact: true });
      const longName = `创建流程放大后的长名称-${'跨团队共享服务'.repeat(9)}`;
      await expect(name).toBeFocused();
      await name.fill(longName);
      await page.keyboard.press('Tab');
      await expect(image).toBeFocused();
      await image.fill('nginx:1.28.0-alpine');
      await page.keyboard.press('Shift+Tab');
      await expect(name).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog.getByRole('link', { name: /部署 Docker 镜像/ })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(name).toBeFocused();
      await expect(name).toHaveValue(longName);
      await expect(image).toHaveValue('nginx:1.28.0-alpine');
      await checkpoint('creation-configuration-long-name');
      await expectUsableControl(image, page);
      const review = dialog.getByRole('button', { name: '核对部署配置', exact: true });
      await expectUsableControl(review, page);
      await review.focus();
      await page.keyboard.press('Enter');
      await expect(dialog.locator('[data-deployment-review]')).toBeVisible();
      await expect(
        dialog.getByRole('heading', { name: '核对部署配置', exact: true }),
      ).toBeFocused();
      await checkpoint('creation-review-long-name');
      const back = dialog.getByRole('button', { name: '返回配置', exact: true });
      await expectUsableControl(back, page);
      // Playwright's viewport screenshot derives a CSS-pixel clip when viewport
      // is null. Native page zoom needs the complete browser surface, without a
      // clip, to avoid capturing only its upper-left quarter.
      const screenshotSession = await context!.newCDPSession(page);
      const screenshot = await screenshotSession.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await screenshotSession.detach();
      const png = Buffer.from(screenshot.data, 'base64');
      screenshotSize = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      const metrics = await viewportMetrics(page);
      expect(screenshotSize.width).toBe(metrics.innerWidth * metrics.devicePixelRatio);
      // innerHeight is integral even when the native surface is an odd number
      // of pixels tall (for example 913 device pixels at 200% page zoom).
      expect(
        Math.abs(screenshotSize.height - metrics.innerHeight * metrics.devicePixelRatio),
      ).toBeLessThanOrEqual(1);
      const screenshotPath = testInfo.outputPath('native-200-percent-creation.png');
      await mkdir(dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, png);
      await back.focus();
      await page.keyboard.press('Enter');
      await expect(name).toBeFocused();
      await expect(name).toHaveValue(longName);
      expect(state.core.writes.filter((write) => write.path === '/services')).toHaveLength(1);
      expect(state.core.writes.filter((write) => write.path.endsWith('/deployments'))).toEqual([]);
      unexpected.push(...state.core.unexpected);
    });
    expect(errors, '浏览器脚本错误').toEqual([]);
    expect(unexpected, '未声明的 API 请求').toEqual([]);
  } finally {
    await context?.close();
    // Only this test's new temporary profile is removed; no user profile is read.
    await rm(profile, { recursive: true, force: true });
    const evidencePath = testInfo.outputPath('native-zoom-evidence.json');
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          channel,
          browserVersion,
          zoomFactor,
          zoomLevel,
          mechanism: 'temporary-profile partition.default_zoom_level.x',
          viewport: null,
          forcedDeviceScaleFactor: 1,
          nativeWindow,
          screenshotSize,
          checkpoints,
          errors,
          unexpected,
        },
        null,
        2,
      ),
    );
    await testInfo.attach('native-zoom-evidence', {
      path: evidencePath,
      contentType: 'application/json',
    });
  }
});
