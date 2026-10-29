import { createServer } from 'node:http';

// Deliberately controlled browser pressure, never a database or backend capacity fixture.
// Only the templates come from real read-only API responses; no fixture is persisted.
export function buildFrontendFixtures(seed) {
  const serviceId = (index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  const deploymentId = (index) => `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  const services = Array.from({ length: 100 }, (_, index) => ({
    ...seed.service,
    id: serviceId(index),
    name: `前端性能样本 ${String(index + 1).padStart(3, '0')}`,
    description: '仅用于前端性能验证的受控样本，未执行真实部署。',
    slug: `frontend-performance-${index + 1}`,
    activeTask: null,
    published: seed.service.published
      ? { ...seed.service.published, deploymentId: deploymentId(index) }
      : null,
  }));
  const deployments = Array.from({ length: 10_000 }, (_, index) => {
    const service = services[index % services.length];
    const failed = (Math.floor(index / services.length) + 1) % 5 === 0;
    return {
      ...seed.deployment,
      id: deploymentId(index),
      serviceId: service.id,
      status: failed ? 'failed' : 'succeeded',
      phase: failed ? 'failed' : 'succeeded',
      errorCode: failed ? 'CONTROLLED_PERFORMANCE_SAMPLE' : null,
      errorMessage: failed ? '受控前端性能样本，未执行真实部署。' : null,
      result: failed ? null : seed.deployment.result,
      failureObservation: null,
      configRevision: Math.floor(index / services.length) + 1,
      snapshot: { ...seed.deployment.snapshot, serviceId: service.id, serviceName: service.name },
      createdAt: new Date(Date.UTC(2026, 9, 1) - index * 60_000).toISOString(),
      pollUrl: `/deployments/${deploymentId(index)}`,
    };
  });
  const stats = {
    requests: 0,
    current: 0,
    peakConcurrent: 0,
    unexpectedWrites: 0,
    unknownReads: [],
  };
  const freshService = (service) => {
    const now = new Date().toISOString();
    return {
      ...service,
      lastObservedAt: now,
      observationStale: false,
      observation: service.observation
        ? {
            ...service.observation,
            observedAt: now,
            metrics: { ...service.observation.metrics, observedAt: now },
          }
        : null,
    };
  };
  function paginate(items, url) {
    const offset = Number(url.searchParams.get('cursor') || '0');
    const limit = Math.min(100, Number(url.searchParams.get('limit') || '50'));
    const next = offset + limit;
    return {
      data: items.slice(offset, next),
      page: { hasMore: next < items.length, nextCursor: next < items.length ? String(next) : null },
    };
  }
  async function request(path, method = 'GET') {
    stats.requests++;
    stats.current++;
    stats.peakConcurrent = Math.max(stats.peakConcurrent, stats.current);
    try {
      // A known 5ms controlled delay makes concurrent requests observable, without a real server.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (method !== 'GET') {
        stats.unexpectedWrites++;
        return {
          status: 405,
          body: { error: { code: 'PERFORMANCE_READ_ONLY', message: '性能样本只允许读取。' } },
        };
      }
      const url = new URL(path, 'http://fixture.invalid');
      const resource = url.pathname.replace(/^\/api/, '');
      if (resource === '/auth/me')
        return {
          status: 200,
          body: { data: { ...seed.session.data, csrfToken: 'controlled-frontend-read-only' } },
        };
      if (resource === '/services') {
        const search = url.searchParams.get('search')?.toLowerCase();
        const items = services.filter(
          (service) => !search || `${service.name} ${service.slug}`.toLowerCase().includes(search),
        );
        return { status: 200, body: paginate(items.map(freshService), url) };
      }
      if (resource.startsWith('/services/')) {
        const service = services.find((item) => item.id === resource.slice('/services/'.length));
        if (service) return { status: 200, body: { data: freshService(service) } };
      }
      if (resource === '/deployments') {
        const service = url.searchParams.get('serviceId');
        const status = url.searchParams.get('status');
        const items = deployments.filter(
          (item) => (!service || item.serviceId === service) && (!status || item.status === status),
        );
        return { status: 200, body: paginate(items, url) };
      }
      if (/^\/deployments\/[^/]+\/logs$/.test(resource)) {
        return {
          status: 200,
          body: {
            data: seed.logs.data,
            page: { hasMore: false, nextCursor: null },
            truncated: false,
            unavailableReason: null,
          },
        };
      }
      if (resource.startsWith('/deployments/')) {
        const deployment = deployments.find(
          (item) => item.id === resource.slice('/deployments/'.length),
        );
        if (deployment) return { status: 200, body: { data: deployment } };
      }
      if (resource === `/projects/${seed.project.data.id}`)
        return { status: 200, body: seed.project };
      if (resource === '/projects')
        return { status: 200, body: paginate([seed.project.data], url) };
      if (resource === '/clusters') return { status: 200, body: paginate(seed.clusters.data, url) };
      if (resource === '/environments')
        return { status: 200, body: paginate(seed.environments.data, url) };
      if (['/secrets', '/operations', '/servers'].includes(resource))
        return { status: 200, body: paginate([], url) };
      if (!stats.unknownReads.includes(resource)) stats.unknownReads.push(resource);
      return {
        status: 404,
        body: { error: { code: 'FIXTURE_ROUTE_MISSING', message: '受控数据集不包含此页面。' } },
      };
    } finally {
      stats.current--;
    }
  }
  return { services, deployments, stats, request };
}

export async function serveFrontendFixtures(fixtures, browserOrigin) {
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', browserOrigin);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET');
      response.end();
      return;
    }
    const result = await fixtures.request(request.url, request.method);
    response.statusCode = result.status;
    response.end(JSON.stringify(result.body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Install before the production bundle. Static assets remain native fetches, preserving HTTP
// cache measurement; only /api is controlled. No cookies, tokens or log text enter the report.
export function installControlledSource({ shortServiceId, metadataOrigin }) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const source = {
    active: 0,
    activeTimers: 0,
    generatedLines: 0,
    generatedBytes: 0,
    connections: [],
    management: { batches: 0, responses: 0, errors: 0, active: 0 },
  };
  globalThis.__s3PerformanceSource = source;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      input instanceof globalThis.Request ? input.url : String(input),
      globalThis.location.href,
    );
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    if (!/^\/api\/services\/[^/]+\/logs$/.test(url.pathname)) {
      return nativeFetch(new URL(url.pathname + url.search, metadataOrigin), {
        method: init?.method ?? 'GET',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal,
      });
    }
    const short = url.pathname.includes(shortServiceId);
    const record = {
      startedAt: globalThis.performance.now(),
      endedAt: null,
      reason: null,
      bytes: 0,
      lines: 0,
      chunks: 0,
      mode: short ? 'short-lines' : 'long-lines',
    };
    source.connections.push(record);
    source.active++;
    const encoder = new globalThis.TextEncoder();
    let interval;
    let deadline;
    let close;
    const body = new globalThis.ReadableStream({
      start(controller) {
        const finish = (reason, sendEnd = true) => {
          if (record.endedAt !== null) return;
          record.endedAt = globalThis.performance.now();
          record.reason = reason;
          source.active--;
          globalThis.clearInterval(interval);
          globalThis.clearTimeout(deadline);
          source.activeTimers -= 2;
          signal?.removeEventListener('abort', aborted);
          if (sendEnd) {
            controller.enqueue(
              encoder.encode(
                `event: end\ndata: ${JSON.stringify({ reason, message: '受控前端压力源已达到本次读取上限，可重新跟随。' })}\n\n`,
              ),
            );
            controller.close();
          }
        };
        const aborted = () => finish('aborted', false);
        close = () => finish('consumer_closed', false);
        signal?.addEventListener('abort', aborted, { once: true });
        const tick = () => {
          const lines = short ? 30 : 2;
          const text = short
            ? 'x\n'.repeat(lines)
            : Array.from(
                { length: lines },
                (_, index) =>
                  `序号=${record.lines + index} 中文日志 空格与原文 ${'x'.repeat(360)}\n`,
              ).join('');
          const bytes = encoder.encode(text).byteLength;
          if (record.bytes + bytes > 1024 * 1024) return finish('byte_limit');
          record.bytes += bytes;
          record.lines += lines;
          record.chunks++;
          source.generatedBytes += bytes;
          source.generatedLines += lines;
          controller.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify({ text })}\n\n`));
        };
        interval = globalThis.setInterval(tick, 100);
        deadline = globalThis.setTimeout(() => finish('duration_limit'), 55_000);
        source.activeTimers += 2;
        tick();
      },
      cancel() {
        close();
      },
    });
    return new globalThis.Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}
