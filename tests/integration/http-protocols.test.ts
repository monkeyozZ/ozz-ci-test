import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProtocolProbe } from '../probes/http-protocols.mjs';

let probe: Awaited<ReturnType<typeof createProtocolProbe>>;
const deadline = () => AbortSignal.timeout(3000);

async function eventually(check: () => boolean) {
  const until = Date.now() + 2500;
  while (!check() && Date.now() < until) await delay(10);
  expect(check(), 'The owned producer/subscription did not release on disconnect').toBe(true);
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
) {
  const decoder = new TextDecoder();
  let text = '';
  while (!done(text)) {
    const result = await reader.read();
    if (result.done)
      throw new Error('Stream ended before receiving the expected incremental frames');
    text += decoder.decode(result.value, { stream: true });
    if (text.length > 16384) throw new Error('Probe output exceeded its fixed read budget');
  }
  return text;
}

beforeAll(async () => {
  probe = await createProtocolProbe();
});

afterAll(async () => {
  await probe?.close();
  if (probe) {
    await eventually(() => {
      const metrics = probe.metrics();
      return metrics.sse.active + metrics.stream.active + metrics.websocket.active === 0;
    });
    expect(probe.metrics()).toMatchObject({ activeTimers: 0, activeDisposers: 0 });
  }
});

describe('B01: real Nest/Fastify loopback protocol probe', () => {
  it('uses the locked runtime and actual HTTP adapter versions', () => {
    expect(probe.versions).toEqual({
      node: 'v24.22.1',
      nest: '11.2.8',
      fastify: '5.12.7',
      websocket: '11.3.4',
    });
  });

  it('verifies the exact raw bytes and rejects semantically equal reserialization or tampering', async () => {
    const raw = Buffer.from('{ "event": "probe", "text": "协议测试", "count": 1 }\n');
    const signature = probe.signSyntheticBody(raw);
    const send = (body: Uint8Array, header = signature) =>
      fetch(probe.origin + '/__protocol_probe/signed', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-probe-signature': header },
        body,
        signal: deadline(),
      });
    const valid = await send(raw);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      verified: true,
      rawBytes: raw.length,
      parsed: JSON.parse(raw.toString()),
    });
    const reserialized = await send(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))));
    expect(reserialized.status).toBe(401);
    await reserialized.arrayBuffer();
    const changed = await send(Buffer.from(raw.toString().replace('"count": 1', '"count": 2')));
    expect(changed.status).toBe(401);
    await changed.arrayBuffer();
    const malformed = await send(raw, 'sha256=short');
    expect(malformed.status).toBe(401);
    await malformed.arrayBuffer();
  });

  it('streams SSE frames incrementally and reclaims subscriptions and timers after repeated client aborts', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cancellation = new AbortController();
      const response = await fetch(probe.origin + '/__protocol_probe/events', {
        signal: AbortSignal.any([cancellation.signal, deadline()]),
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      try {
        const text = await readUntil(
          reader,
          (value) => (value.match(/event: probe/g) ?? []).length >= 2,
        );
        expect(text).toContain('id: 1');
        expect(text).toContain('data: {"sequence":1}');
        expect(probe.metrics().sse.active).toBe(1);
      } finally {
        cancellation.abort();
        await reader.cancel().catch(() => undefined);
      }
      await eventually(
        () => probe.metrics().sse.active === 0 && probe.metrics().activeTimers === 0,
      );
    }
    expect(probe.metrics().sse).toEqual({ opened: 3, active: 0, closed: 3 });
  });

  it('streams HTTP chunks and propagates downstream abort into the upstream async producer', async () => {
    const cancellation = new AbortController();
    const response = await fetch(probe.origin + '/__protocol_probe/stream', {
      signal: AbortSignal.any([cancellation.signal, deadline()]),
    });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const reader = response.body!.getReader();
    try {
      const text = await readUntil(reader, (value) => value.split('\n').length >= 4);
      const chunks = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(chunks.slice(0, 3).map((chunk) => chunk.sequence)).toEqual([1, 2, 3]);
      expect(probe.metrics().stream.active).toBe(1);
    } finally {
      cancellation.abort();
      await reader.cancel().catch(() => undefined);
    }
    await eventually(() => probe.metrics().stream.active === 0);
    expect(probe.metrics().stream).toEqual({ opened: 1, active: 0, closed: 1, upstreamAborts: 1 });
  });

  it('round-trips a WebSocket message with the native client and clears heartbeat work on close', async () => {
    const socket = new WebSocket(probe.origin.replace('http:', 'ws:') + '/__protocol_probe/socket');
    try {
      await once(socket, 'open', { signal: deadline() });
      const received = once(socket, 'message', { signal: deadline() });
      socket.send('native client: 协议测试');
      expect((await received)[0].data).toBe('native client: 协议测试');
      const closed = once(socket, 'close', { signal: deadline() });
      socket.close(1000, 'probe complete');
      expect((await closed)[0].code).toBe(1000);
      await eventually(
        () => probe.metrics().websocket.active === 0 && probe.metrics().activeTimers === 0,
      );
    } finally {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
  });

  it('propagates an abrupt upgraded TCP disconnect to the WebSocket owner and releases its timer', async () => {
    const request = httpRequest(probe.origin + '/__protocol_probe/socket', {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    });
    const upgraded = once(request, 'upgrade', { signal: deadline() });
    request.end();
    const [response, socket] = await upgraded;
    expect(response.statusCode).toBe(101);
    socket.destroy();
    await eventually(
      () => probe.metrics().websocket.active === 0 && probe.metrics().activeTimers === 0,
    );
    expect(probe.metrics().websocket).toMatchObject({ opened: 2, closed: 2, abnormalCloses: 1 });
  });
});
