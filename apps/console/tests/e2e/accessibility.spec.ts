import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('主要页面的自动无障碍检查覆盖明暗主题与窄屏', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await login(page);
  const reports = [];
  for (const mode of ['light', 'dark']) {
    await page.getByRole('button', { name: '选择外观主题', exact: true }).click();
    await page
      .getByRole('menuitemradio', { name: mode === 'dark' ? '深色' : '浅色', exact: true })
      .click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of [
        '/projects',
        '/projects/new',
        '/servers/new',
        '/clusters/new',
        '/settings',
        '/operations',
      ]) {
        await page.goto(path);
        await page.locator('h1').waitFor();
        await expect(page.locator('html')).toHaveCSS('color-scheme', mode);
        await page.locator('.skeleton').first().waitFor({ state: 'hidden' });
        const result = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        reports.push({ path, mode, width, violations: result.violations });
        expect.soft(result.violations, `${mode} ${width} ${path}`).toEqual([]);
      }
    }
  }
  await testInfo.attach('accessibility-results', {
    body: JSON.stringify(reports, null, 2),
    contentType: 'application/json',
  });
});
