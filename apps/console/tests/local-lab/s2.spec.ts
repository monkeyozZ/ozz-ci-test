import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { api, login } from '../e2e/helpers';

const clusterAId = process.env.S2_E2E_CLUSTER_A;
const clusterBId = process.env.S2_E2E_CLUSTER_B;
const projectAId = process.env.S2_E2E_PROJECT_A;
const serverCId = process.env.S2_E2E_SERVER_C;

type ThemeContrastSample = { dark: boolean; contrast: number };
type ThemeProbeWindow = Window & {
  ozzThemeContrast?: Promise<ThemeContrastSample[]>;
};

test.beforeAll(() => {
  if (!clusterAId || !clusterBId || clusterAId === clusterBId)
    throw new Error(
      'S2_E2E_CLUSTER_A and S2_E2E_CLUSTER_B must name the two existing isolated local lab registrations. These probes do not create clusters.',
    );
});

async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function observeThemeContrast(page: Page) {
  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('.bg-destructive');
    if (!target) throw new Error('The theme probe requires the existing destructive control.');
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The theme probe requires a canvas color conversion context.');
    const luminance = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    (window as ThemeProbeWindow).ozzThemeContrast = new Promise((resolve) => {
      const started = performance.now();
      const samples: ThemeContrastSample[] = [];
      function frame() {
        const style = getComputedStyle(target!);
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        samples.push({
          dark: document.documentElement.classList.contains('dark'),
          contrast:
            (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        });
        if (performance.now() - started < 400) requestAnimationFrame(frame);
        else resolve(samples);
      }
      frame();
    });
  });
}

test('两套真实集群的同名节点使用独立 UID，浅深色与窄屏保持可读', async ({ page }, testInfo) => {
  await login(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const clusterA = await api(page.request, `/clusters/${clusterAId}`);
  const clusterB = await api(page.request, `/clusters/${clusterBId}`);
  const nodesA = await api(page.request, `/clusters/${clusterAId}/nodes`);
  const nodesB = await api(page.request, `/clusters/${clusterBId}/nodes`);
  expect(clusterA.identity.kubeSystemUid).not.toBe(clusterB.identity.kubeSystemUid);
  const a = nodesA.find((node: { present: boolean }) => node.present);
  const b = nodesB.find((node: { present: boolean }) => node.present);
  expect(a.name).toBe(b.name);
  expect(a.uid).not.toBe(b.uid);
  for (const [cluster, node] of [
    [clusterA, a],
    [clusterB, b],
  ]) {
    await page.goto(`/clusters/${cluster.id}`);
    await expect(
      page.getByRole('heading', { name: cluster.name, level: 1, exact: true }),
    ).toBeVisible();
    const inventory = page.locator('[data-node-inventory]');
    await expect(inventory.getByText(node.name, { exact: true })).toBeVisible();
    await inventory.getByText('节点身份与时间', { exact: true }).first().click();
    await expect(inventory.getByText(node.uid, { exact: true })).toBeVisible();
    await expect(page.locator('[data-workload-observation]')).toBeVisible();
    for (const [theme, width] of [
      ['light', 1440],
      ['dark', 390],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
      await observeThemeContrast(page);
      await page
        .getByRole('menuitemradio', { name: theme === 'dark' ? '深色' : '浅色', exact: true })
        .click();
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
      else await expect(page.locator('html')).not.toHaveClass(/dark/);
      const contrastSamples = await page.evaluate(
        () => (window as ThemeProbeWindow).ozzThemeContrast,
      );
      expect(contrastSamples!.some((sample) => sample.dark === (theme === 'dark'))).toBe(true);
      // Inspect the actual foreground/background color pair throughout the
      // switch, including the formerly low-contrast interpolated frames. The
      // disabled control's separate opacity is not treated as an AA violation.
      expect(Math.min(...contrastSamples!.map((sample) => sample.contrast))).toBeGreaterThanOrEqual(
        4.5,
      );
      await expect(page.locator('[data-node-inventory]')).toBeVisible();
      await settleLayout(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        accessibility.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.map((entry) => ({
            target: entry.target,
            summary: entry.failureSummary,
          })),
        })),
      ).toEqual([]);
      // Full-page capture keeps fixed UI at the current scroll position. Return
      // to the actual page entry before recording the visual evidence.
      await page.getByRole('button', { name: '选择外观主题', exact: true }).focus();
      await page.evaluate(() => window.scrollTo(0, 0));
      await settleLayout(page);
      await page.screenshot({
        path: testInfo.outputPath(`cluster-${cluster.id}-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  expect(errors).toEqual([]);
});

test('项目页的集群状态随观察过期更新，无需离开页面或改变后端状态', async ({ page }) => {
  if (!projectAId) throw new Error('S2_E2E_PROJECT_A is required for the existing local project.');
  await page.clock.install({ time: new Date() });
  await login(page, `/projects/${projectAId}`);
  const badge = page.locator('.page-head .badge');
  await expect(badge).toHaveText('已连接');
  await page.clock.fastForward(106_000);
  await expect(badge).toHaveText('观察已过期');
  expect((await api(page.request, `/clusters/${clusterAId}`)).connectionStatus).toBe('connected');
});

test('已初始化主机显示同一个集群入口，保留任务结果且不能再次初始化', async ({ page }) => {
  if (!serverCId)
    throw new Error('S2_E2E_SERVER_C is required for the existing initialized local server.');
  await login(page, `/servers/${serverCId}`);
  const server = await api(page.request, `/servers/${serverCId}`);
  const nodes = await api(page.request, `/servers/${serverCId}/nodes`);
  const linked = nodes.find((node: { present: boolean }) => node.present);
  expect(linked).toBeTruthy();
  await expect(page.getByRole('heading', { name: server.name, level: 1 })).toBeVisible();
  await expect(page.locator('.cluster-association')).toHaveAttribute(
    'href',
    `/clusters/${linked.clusterId}`,
  );
  await expect(page.getByRole('button', { name: '确认初始化配置', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-infrastructure-task]')).toContainText('已完成');
});

test('候选连接预览真实显示另一集群的 CA，确认前不能提交且保留原连接', async ({ page }) => {
  await login(page);
  const a = await api(page.request, `/clusters/${clusterAId}`);
  const b = await api(page.request, `/clusters/${clusterBId}`);
  await page.goto(`/clusters/${a.id}`);
  await page.getByRole('button', { name: '更新连接凭证或地址', exact: true }).click();
  const editor = page.locator('.connection-editor');
  await editor.getByLabel('凭证来源', { exact: true }).selectOption('saved');
  for (
    let pageIndex = 0;
    pageIndex < 20 && !(await editor.locator(`option[value="${b.credentialRefId}"]`).count());
    pageIndex++
  ) {
    const more = editor.getByRole('button', { name: '载入更多凭证', exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await expect(more).toBeEnabled();
  }
  await editor.getByLabel('候选 kubeconfig 凭证', { exact: true }).selectOption(b.credentialRefId);
  await editor.getByLabel('候选 API 地址', { exact: false }).fill(b.apiEndpoint);
  await editor.getByRole('button', { name: '预览候选连接', exact: true }).click();
  const preview = page.locator('#connection-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByText(a.identity.caFingerprint, { exact: true })).toBeVisible();
  await expect(preview.getByText(b.identity.caFingerprint, { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: '开始验证并连接', exact: true })).toBeDisabled();
  const latest = await api(page.request, `/clusters/${a.id}`);
  expect(latest.credentialRefId).toBe(a.credentialRefId);
  expect(latest.identity).toEqual(a.identity);
  await editor.getByRole('button', { name: '取消并清空输入', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '清空输入并关闭', exact: true })
    .click();
  await expect(editor).toHaveCount(0);
});

test('真实同步任务在刷新与完整任务页保持相同的集群目标', async ({ page }) => {
  await login(page, `/clusters/${clusterBId}`);
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/clusters/${clusterBId}/sync`),
  );
  await page.getByRole('button', { name: '重新检查与同步', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const operation = (await response.json()).data;
  expect(operation.clusterId).toBe(clusterBId);
  const task = page.locator('[data-infrastructure-task]');
  await expect(task).toContainText(operation.id);
  await page.reload();
  await expect(task).toContainText(operation.id);
  await expect(task.getByText('已完成', { exact: true })).toBeVisible({ timeout: 90_000 });
  await task.getByRole('link', { name: '完整任务记录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/operations/${operation.id}$`));
  await expect(page.getByRole('heading', { name: '集群观察同步', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: clusterBId!, exact: true })).toBeVisible();
});
