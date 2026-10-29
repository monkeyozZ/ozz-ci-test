import { expect, type Page, type APIRequestContext, type BrowserContext } from '@playwright/test';

export const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
export const username = process.env.E2E_USERNAME;
export const password = process.env.E2E_PASSWORD;
// Keep a real authenticated session only in this test worker's memory. Never weaken login
// limits or write cookies to disk; revoked sessions force another real UI login.
let sessionCookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;
export function requireCredentials() {
  if (!username || !password)
    throw new Error(
      'Set E2E_USERNAME and E2E_PASSWORD for an isolated local administrator before running console E2E tests.',
    );
}
export async function login(page: Page, returnTo = '/projects') {
  requireCredentials();
  if (sessionCookies) {
    await page.context().addCookies(sessionCookies);
    const session = await page.request.get('/api/auth/me');
    if (session.ok()) {
      await page.goto(returnTo);
      await expect(page).toHaveURL(new URL(returnTo, baseURL).toString());
      return;
    }
    sessionCookies = undefined;
  }
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel('管理员账号', { exact: true }).fill(username!);
  await page.getByLabel('密码', { exact: true }).fill(password!);
  await page.getByRole('button', { name: '登录工作台', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${returnTo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  // The session is intentionally scoped to /api, so querying cookies for / would miss it.
  sessionCookies = await page.context().cookies(new URL('/api/auth/me', baseURL).toString());
  expect(
    sessionCookies.some((cookie) => cookie.httpOnly),
    '登录应设置 API 范围的 HttpOnly 会话',
  ).toBe(true);
}
export async function api(
  request: APIRequestContext,
  path: string,
  method = 'GET',
  data?: unknown,
) {
  const me = await request.get('/api/auth/me');
  expect(me.ok()).toBeTruthy();
  const session = (await me.json()).data;
  const response = await request.fetch(`/api${path}`, {
    method,
    headers: {
      Origin: baseURL,
      'X-CSRF-Token': session.csrfToken,
      'Idempotency-Key': crypto.randomUUID(),
    },
    data,
  });
  if (!response.ok())
    throw new Error(`API ${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? undefined : (await response.json()).data;
}
export function suffix() {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
export async function removeIfPresent(request: APIRequestContext, collection: string, id?: string) {
  if (!id) return;
  const current = await request.get(`/api/${collection}/${id}`);
  if (current.status() === 404) return;
  const resource = (await current.json()).data;
  await api(request, `/${collection}/${id}?revision=${resource.revision}`, 'DELETE');
}
