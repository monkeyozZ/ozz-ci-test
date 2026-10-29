import { describe, expect, it } from 'vitest';
import { appendServiceLog, ServiceLogDecoder } from '../../src/lib/service-log-stream';

const encode = (value: string) => new TextEncoder().encode(value);
describe('有界的服务日志协议', () => {
  it('任意字节分片与 CRLF 保留中文、换行和日志原文', () => {
    const decoder = new ServiceLogDecoder();
    const wire = encode(
      `: heartbeat\r\n\r\nevent: log\r\ndata: ${JSON.stringify({ text: '中文 <script>\n下一行' })}\r\n\r\nevent: end\r\ndata: {"reason":"eof","message":"完成"}\r\n\r\n`,
    );
    const events = Array.from(wire, (byte) => decoder.push(new Uint8Array([byte]))).flat();
    expect(events).toEqual([
      { type: 'log', text: '中文 <script>\n下一行' },
      { type: 'end', reason: 'eof', message: '完成' },
    ]);
  });

  it('结束事件关闭当前输出，后续字节不能混入日志', () => {
    const decoder = new ServiceLogDecoder();
    const events = decoder.push(
      encode(
        'event: end\ndata: {"reason":"duration_limit"}\n\nevent: log\ndata: {"text":"late"}\n\n',
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'end', reason: 'duration_limit' });
    expect(decoder.push(encode('event: log\ndata: {"text":"later"}\n\n'))).toEqual([]);
  });

  it('损坏或未知的受支持事件会报告协议错误', () => {
    for (const data of ['not-json', '{"text":23}', '{"reason":"new_unknown_reason"}']) {
      expect(() =>
        new ServiceLogDecoder().push(
          encode(`event: ${data.includes('reason') ? 'end' : 'log'}\ndata: ${data}\n\n`),
        ),
      ).toThrow('无法识别');
    }
  });

  it('未闭合事件和累计数据都有上限', () => {
    expect(() =>
      new ServiceLogDecoder().push(encode(`event: log\ndata: ${'x'.repeat(1_100_000)}`)),
    ).toThrow('大小');
    const decoder = new ServiceLogDecoder();
    const chunk = encode(`event: log\ndata: ${JSON.stringify({ text: 'x'.repeat(500_000) })}\n\n`);
    for (let i = 0; i < 4; i++) decoder.push(chunk);
    expect(() => decoder.push(chunk)).toThrow('接收上限');
  });

  it('暂停滚动期间反复追加也只保留最近的有界输出', () => {
    let current = '';
    for (let i = 0; i < 50; i++)
      current = appendServiceLog(current, `${i}:` + 'x'.repeat(10_000)).text;
    expect(current.length).toBe(200_000);
    expect(current.endsWith('49:' + 'x'.repeat(10_000))).toBe(true);
    expect(appendServiceLog(current, 'latest')).toMatchObject({ clipped: true });
  });

  it('大量短行和空行也不能越过一万行边界', () => {
    expect(appendServiceLog('', '\n中文\n')).toEqual({ text: '\n中文\n', clipped: false });
    const output = appendServiceLog('', '\n'.repeat(12_000) + '最近的中文行');
    expect(output.clipped).toBe(true);
    expect(output.text.split('\n')).toHaveLength(10_000);
    expect(output.text.endsWith('最近的中文行')).toBe(true);
    expect(appendServiceLog(output.text, '\n新的行').text.split('\n')).toHaveLength(10_000);
  });

  it('字符上限先到时仍保留完整 Unicode 字符', () => {
    expect(appendServiceLog('旧行\n', '😀ab', 3)).toEqual({ text: 'ab', clipped: true });
    expect(appendServiceLog('旧行\n', '😀ab', 4)).toEqual({ text: '😀ab', clipped: true });
  });
});
