import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, eventStream, onUnauthorized, request, setCsrfToken } from '../../src/lib/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
  onUnauthorized(() => undefined);
});

describe('response body session isolation', () => {
  it.each([
    new SyntaxError('Incomplete JSON'),
    new TypeError('Body stream closed'),
    new DOMException('Body timed out', 'TimeoutError'),
  ])('keeps an accepted mutation unresolved when reading its body fails: %s', async (error) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.reject(error) }),
    );
    await expect(
      api.create('/services', { name: 'accepted-service' }, 'original-key'),
    ).rejects.toMatchObject({ status: 0, problem: { code: 'RESPONSE_UNCONFIRMED' } });
  });

  it.each([{}, null])('rejects an incomplete success envelope: %s', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => body }),
    );
    await expect(
      api.create('/projects', { name: 'accepted-project' }, 'original-key'),
    ).rejects.toMatchObject({ status: 0 });
  });

  it('retains a known rejection status when its problem body is unreadable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.reject(new TypeError('Body closed')),
      }),
    );
    await expect(api.create('/services', {}, 'original-key')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('still fences a broken success body from an expired session', async () => {
    setCsrfToken('old-test-session');
    const body = deferred<unknown>();
    const json = vi.fn(() =>
      body.promise.then(() => {
        throw new TypeError('Body closed');
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201, json }));
    const outcome = api.create('/services', {}).catch((error) => error);
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    setCsrfToken(null);
    body.resolve(null);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  });

  it('drops an old successful mutation body after logout and a new login', async () => {
    setCsrfToken('old-test-session');
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201, json }));
    const outcome = request('/servers', {
      method: 'POST',
      body: { name: 'old-test-resource' },
    }).catch((error) => error);
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    setCsrfToken(null);
    setCsrfToken('new-test-session');
    body.resolve({ data: { id: 'old-test-resource' } });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  });

  it('does not let an old 401 body expire the newly authenticated session', async () => {
    setCsrfToken('old-test-session');
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    const unauthorized = vi.fn();
    onUnauthorized(unauthorized);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json }));
    const outcome = request('/projects').catch((error) => error);
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    setCsrfToken('new-test-session');
    body.resolve({ detail: 'Previous session expired' });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('also guards a late auth/me response before a store can establish the session', async () => {
    setCsrfToken(null);
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json }));
    const outcome = request('/auth/me', { auth: false }).catch((error) => error);
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    setCsrfToken(null);
    body.resolve({ data: { user: { id: 'old-user' }, csrfToken: 'old-test-session' } });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  });
});

describe('service log connection lifecycle', () => {
  it('aborts an open log request when the session changes', async () => {
    setCsrfToken('stream-session');
    const fetcher = vi.fn().mockResolvedValue(
      new Response('event: end\ndata: {"reason":"eof"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const owner = new AbortController();
    await eventStream('/services/service-id/logs', owner.signal);
    const suppliedSignal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    expect(suppliedSignal.aborted).toBe(false);
    setCsrfToken('another-session');
    expect(suppliedSignal.aborted).toBe(true);
  });

  it('keeps view cancellation attached to the upstream request', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    const owner = new AbortController();
    await eventStream('/services/service-id/logs', owner.signal);
    owner.abort();
    expect((fetcher.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
  });

  it('cancels an unexpected response body instead of treating HTML as logs', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/html' } })),
    );
    await expect(
      eventStream('/services/service-id/logs', new AbortController().signal),
    ).rejects.toMatchObject({ status: 502 });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
