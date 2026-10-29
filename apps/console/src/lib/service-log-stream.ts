export const serviceLogEndMessages = {
  eof: '本次日志读取完成。',
  duration_limit: '本次连接已达到 60 秒上限，可重新读取或跟随。',
  byte_limit: '本次日志已达到容量上限，可缩小尾部范围后继续。',
  source_error: '日志源连接中断，可查看实例状态后重试。',
  access_changed: '会话或访问范围已变化，当前日志连接已关闭。',
};

export type ServiceLogEvent =
  | { type: 'log'; text: string }
  | { type: 'end'; reason: keyof typeof serviceLogEndMessages; message: string };

/** Owns only bounded SSE framing; connection and view lifetimes stay with the caller. */
export class ServiceLogDecoder {
  private decoder = new TextDecoder();
  private buffer = '';
  private bytes = 0;
  private ended = false;

  push(chunk: Uint8Array): ServiceLogEvent[] {
    if (this.ended) return [];
    this.bytes += chunk.byteLength;
    if (this.bytes > 2 * 1024 * 1024) throw new Error('日志协议输出超过本地接收上限，已关闭连接。');
    this.buffer = (this.buffer + this.decoder.decode(chunk, { stream: true })).replaceAll(
      '\r\n',
      '\n',
    );
    if (this.buffer.length > 1_100_000) throw new Error('日志事件超过允许大小。');
    const events: ServiceLogEvent[] = [];
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const lines = this.buffer.slice(0, boundary).split('\n');
      this.buffer = this.buffer.slice(boundary + 2);
      const type = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      if (type !== 'log' && type !== 'end') continue;
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error('日志源返回了无法识别的事件。');
      }
      if (!payload || typeof payload !== 'object') throw new Error('日志源返回了无法识别的事件。');
      if (type === 'log' && 'text' in payload && typeof payload.text === 'string') {
        events.push({ type, text: payload.text });
      } else if (
        type === 'end' &&
        'reason' in payload &&
        typeof payload.reason === 'string' &&
        Object.hasOwn(serviceLogEndMessages, payload.reason)
      ) {
        const reason = payload.reason as keyof typeof serviceLogEndMessages;
        events.push({
          type,
          reason,
          message:
            'message' in payload && typeof payload.message === 'string'
              ? payload.message
              : serviceLogEndMessages[reason],
        });
        this.ended = true;
        this.buffer = '';
        break;
      } else throw new Error('日志源返回了无法识别的事件。');
    }
    return events;
  }
}

export const serviceLogViewLimits = { characters: 200_000, lines: 10_000 };

export function appendServiceLog(
  current: string,
  value: string,
  limit = serviceLogViewLimits.characters,
  lineLimit = serviceLogViewLimits.lines,
) {
  const combined = current + value;
  let start = Math.max(0, combined.length - limit);
  let boundary = combined.length;
  for (let lines = 0; lines < lineLimit; lines++) {
    if (boundary <= start) break;
    boundary = combined.lastIndexOf('\n', boundary - 1);
    if (boundary < start) break;
    if (lines === lineLimit - 1) start = boundary + 1;
  }
  // Do not turn a character at the clipped boundary into an unpaired surrogate.
  if (
    start > 0 &&
    combined.charCodeAt(start) >= 0xdc00 &&
    combined.charCodeAt(start) <= 0xdfff &&
    combined.charCodeAt(start - 1) >= 0xd800 &&
    combined.charCodeAt(start - 1) <= 0xdbff
  )
    start++;
  return {
    text: start ? combined.slice(start) : combined,
    clipped: start > 0,
  };
}
