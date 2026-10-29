import { test, expect } from '@playwright/test';
import { api, login } from './helpers';

test('真实诊断受理后，轮询独立执行器完成与日志', async ({ page }) => {
  await login(page, '/operations');
  await page.getByRole('button', { name: '运行诊断', exact: true }).first().click();
  await expect(page).toHaveURL(/\/operations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: '控制面诊断', exact: true })).toBeVisible();
  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('heading', { name: '诊断结果', exact: true })).toBeVisible();
  await expect(page.locator('.result-json')).toContainText('database-roundtrip');
  await expect(page.locator('.log-line').first()).toBeVisible();
  const path = new URL(page.url()).pathname;
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByText('已完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '请求取消', exact: true })).toHaveCount(0);
});

test('诊断取消由执行器确认，界面保持实际终态', async ({ page }) => {
  await login(page);
  const operation = await api(page.request, '/operations/diagnostics', 'POST', {
    durationMs: 5000,
  });
  await page.goto(`/operations/${operation.id}`);
  await page.getByRole('button', { name: '请求取消', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '请求取消', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: '请求取消', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  const result = await api(page.request, `/operations/${operation.id}`);
  expect(result.status).toBe('cancelled');
});
