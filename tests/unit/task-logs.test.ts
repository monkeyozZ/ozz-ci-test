import { describe, expect, it } from 'vitest';
import {
  appendOperationLog,
  MAX_OPERATION_LOG_BYTES,
  MAX_OPERATION_LOG_ENTRIES,
  type TaskLogLine,
} from '../../packages/control-plane/dist/tasks/index.js';

describe('bounded diagnostic logs', () => {
  it('caps UTF-8 bytes and entries with a visible truncation marker', () => {
    let lines: TaskLogLine[] = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      lines = appendOperationLog(lines, 'warn', '正在恢复诊断任务。'.repeat(60), attempt);
    }
    expect(Buffer.byteLength(JSON.stringify(lines), 'utf8')).toBeLessThanOrEqual(
      MAX_OPERATION_LOG_BYTES,
    );
    expect(lines.length).toBeLessThanOrEqual(MAX_OPERATION_LOG_ENTRIES);
    expect(lines.at(-1)?.code).toBe('LOG_LIMIT_REACHED');
    expect(appendOperationLog(lines, 'info', '后续内容', 301)).toEqual(lines);
  });

  it('honors a reduced byte cap even when older content is already truncated', () => {
    let lines: TaskLogLine[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      lines = appendOperationLog(lines, 'warn', '恢复任务。'.repeat(60), attempt);
    }
    expect(Buffer.byteLength(JSON.stringify(lines), 'utf8')).toBeGreaterThan(1024);
    const reduced = appendOperationLog(lines, 'info', '完成', 100, undefined, 1024);
    expect(Buffer.byteLength(JSON.stringify(reduced), 'utf8')).toBeLessThanOrEqual(1024);
    expect(reduced.at(-1)?.code).toBe('LOG_LIMIT_REACHED');
    expect(new Set(reduced.map((line) => line.sequence)).size).toBe(reduced.length);
  });
});
