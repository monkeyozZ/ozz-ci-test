import { Writable, type Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceLogsService } from '../../apps/api/src/modules/services/logs.service.js';
import type {
  ServiceLogReader,
  ServiceLogSession,
} from '../../packages/control-plane/src/services/logs.js';

const responses: Writable[] = [];

// A write callback held below the socket's high-water mark models an HTTP
// response whose producer has ended while its last bytes still cannot drain.
// The real API wrapper is exercised; domain authorization and TLS are separate tests.
function fixture(options: { holdSource?: boolean } = {}) {
  let blocked = true;
  let pendingWrite: (() => void) | undefined;
  let output: Readable | undefined;
  let signal: AbortSignal | undefined;
  let producerFinished = false;
  let sourceClosed = false;
  let releaseSource!: () => void;
  const sourceReleased = new Promise<void>((resolve) => {
    releaseSource = resolve;
  });
  const raw = new Writable({
    highWaterMark: 64 * 1024,
    autoDestroy: false,
    write(_chunk, _encoding, callback) {
      if (blocked) pendingWrite = callback;
      else callback();
    },
  });
  responses.push(raw);
  const session: ServiceLogSession = {
    close: vi.fn(() => {
      sourceClosed = true;
      releaseSource();
    }),
    events: (async function* () {
      yield { type: 'log' as const, data: { text: 'x'.repeat(40 * 1024) } };
      if (options.holdSource) await sourceReleased;
      if (!sourceClosed)
        yield { type: 'end' as const, data: { reason: 'eof' as const, message: 'done' } };
      producerFinished = true;
    })(),
  };
  const reader = {
    open: vi.fn<ServiceLogReader['open']>(async (_id, _input, _principal, clientSignal) => {
      signal = clientSignal;
      return session;
    }),
    close: vi.fn(),
  };
  const services = {
    repository: {},
    request: async <T>(work: () => T | Promise<T>) => work(),
  };
  const api = new ServiceLogsService(
    services as unknown as ConstructorParameters<typeof ServiceLogsService>[0],
    {} as ConstructorParameters<typeof ServiceLogsService>[1],
  );
  Object.defineProperty(api, 'reader', { value: reader });
  const reply = {
    raw,
    type() {
      return this;
    },
    header() {
      return this;
    },
    send(stream: Readable) {
      output = stream;
      stream.pipe(raw);
      return this;
    },
  };
  const send = vi.spyOn(reply, 'send');
  const open = () =>
    api.stream(
      '11111111-1111-4111-8111-111111111111',
      {
        podUid: '22222222-2222-4222-8222-222222222222',
        container: 'app',
        previous: false,
        follow: false,
        tailLines: 200,
      },
      {
        user: { id: '33333333-3333-4333-8333-333333333333' },
        sessionId: '44444444-4444-4444-8444-444444444444',
      } as Parameters<ServiceLogsService['stream']>[2],
      reply as unknown as Parameters<ServiceLogsService['stream']>[3],
    );
  return {
    raw,
    session,
    reader,
    send,
    open,
    state: () => ({ output, signal, producerFinished, sourceClosed }),
    drain: () => {
      blocked = false;
      pendingWrite?.();
      pendingWrite = undefined;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  for (const raw of responses.splice(0)) raw.destroy();
  await nextTurn();
  vi.useRealTimers();
});

describe('service log HTTP response lifecycle', () => {
  it('keeps the hard deadline after producer completion while the response is still blocked', async () => {
    const f = fixture();
    await f.open();
    await nextTurn();
    expect(f.state().producerFinished).toBe(true);
    expect(f.state().sourceClosed).toBe(true);
    expect(f.raw.writableFinished).toBe(false);
    expect(f.raw.writableLength).toBeGreaterThan(40 * 1024);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(64_999);
    expect(f.raw.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.raw.destroyed).toBe(true);
    expect(f.state().signal?.aborted).toBe(true);
    expect(f.session.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the hard deadline when the HTTP response finishes draining', async () => {
    const f = fixture();
    await f.open();
    await nextTurn();
    expect(f.raw.writableFinished).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    f.drain();
    await nextTurn();
    expect(f.raw.writableFinished).toBe(true);
    expect(f.state().sourceClosed).toBe(true);
    expect(f.raw.listenerCount('finish')).toBe(0);
    expect(f.raw.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.raw.destroyed).toBe(false);
  });

  it('aborts and closes a still-active source when the downstream disconnects', async () => {
    const f = fixture({ holdSource: true });
    await f.open();
    await nextTurn();
    expect(f.state().producerFinished).toBe(false);

    f.raw.destroy();
    await nextTurn();
    expect(f.state().signal?.aborted).toBe(true);
    expect(f.state().sourceClosed).toBe(true);
    expect(f.state().output?.destroyed).toBe(true);
    expect(f.raw.listenerCount('finish')).toBe(0);
    expect(f.raw.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears response timers and listeners when opening fails before a stream is sent', async () => {
    const f = fixture();
    const error = new Error('synthetic open failure');
    f.reader.open.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.raw.listenerCount('finish')).toBe(0);
    expect(f.raw.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
