/** Keeps the longest possible secret prefix until the next chunk. The raw
 * pending text is discarded when a bounded/cancelled stream ends. */
export class LogRedactor {
  private pending = '';
  private readonly pattern: RegExp | null;
  private readonly overlap: number;

  constructor(values: readonly string[]) {
    const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
    this.overlap = Math.max(0, ...secrets.map((value) => value.length - 1));
    this.pattern = secrets.length
      ? new RegExp(
          secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'),
          'gu',
        )
      : null;
  }

  push(text: string, complete = false): string {
    if (!this.pattern) return text;
    this.pending += text;
    const boundary = complete
      ? this.pending.length
      : Math.max(0, this.pending.length - this.overlap);
    let cursor = 0;
    let result = '';
    this.pattern.lastIndex = 0;
    for (const match of this.pending.matchAll(this.pattern)) {
      if (match.index >= boundary) break;
      result += this.pending.slice(cursor, match.index) + '[REDACTED]';
      cursor = match.index + match[0].length;
    }
    const end = Math.max(cursor, boundary);
    result += this.pending.slice(cursor, end);
    this.pending = this.pending.slice(end);
    return result;
  }

  clear(): void {
    this.pending = '';
  }
}
