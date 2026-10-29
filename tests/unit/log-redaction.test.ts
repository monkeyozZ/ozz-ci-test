import { describe, expect, it } from 'vitest';
import { LogRedactor } from '../../packages/control-plane/dist/services/log-redaction.js';

describe('runtime log redaction', () => {
  it('redacts a secret across every possible transport chunk split', () => {
    const secret = '专用-secret.[literal]$-值';
    const input = `before ${secret} after\n`;
    for (let split = 0; split <= input.length; split++) {
      const redactor = new LogRedactor([secret]);
      const result =
        redactor.push(input.slice(0, split)) +
        redactor.push(input.slice(split)) +
        redactor.push('', true);
      expect(result).toBe('before [REDACTED] after\n');
    }
  });

  it('matches the longest overlapping value and treats regex syntax literally', () => {
    const redactor = new LogRedactor(['abc', 'abc-long', 'x.*y']);
    const text = 'abc-long / abc / x.*y / xANYy';
    let output = '';
    for (const character of text) output += redactor.push(character);
    output += redactor.push('', true);
    expect(output).toBe('[REDACTED] / [REDACTED] / [REDACTED] / xANYy');
  });

  it('drops an unfinished secret prefix at a bounded or cancelled ending', () => {
    const redactor = new LogRedactor(['sensitive-value']);
    expect(redactor.push('safe line\nsensitive-val')).not.toContain('sensitive');
    redactor.clear();
    expect(redactor.push('', true)).toBe('');
  });

  it('preserves non-secret text, multiline values and zero-length input', () => {
    const redactor = new LogRedactor(['', 'a\nb']);
    expect(redactor.push('a\n') + redactor.push('b\n日志') + redactor.push('', true)).toBe(
      '[REDACTED]\n日志',
    );
    expect(new LogRedactor([]).push('')).toBe('');
  });
});
