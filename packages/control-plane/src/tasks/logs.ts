import type { TaskLogLevel, TaskLogLine } from './contracts.js';

// Task events contain bounded platform messages, never secrets or raw error stacks.
// Operation and Deployment events share this limit; raw Build/Pod logs use their own stream.
export const MAX_OPERATION_LOG_ENTRIES = 64;
export const MAX_OPERATION_LOG_BYTES = 16 * 1024;

export function readOperationLogs(value: unknown): TaskLogLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is TaskLogLine => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as Record<string, unknown>;
      return (
        Number.isInteger(record.sequence) &&
        typeof record.timestamp === 'string' &&
        ['info', 'warn', 'error'].includes(String(record.level)) &&
        typeof record.message === 'string' &&
        Number.isInteger(record.attempt)
      );
    })
    .slice(0, MAX_OPERATION_LOG_ENTRIES);
}

export function appendOperationLog(
  value: unknown,
  level: TaskLogLevel,
  message: string,
  attempt: number,
  code?: string,
  maxBytes = MAX_OPERATION_LOG_BYTES,
): TaskLogLine[] {
  const byteLimit = Math.max(512, Math.min(maxBytes, MAX_OPERATION_LOG_BYTES));
  const entries = readOperationLogs(value);
  const marker = entries.find((entry) => entry.code === 'LOG_LIMIT_REACHED');
  if (marker && Buffer.byteLength(JSON.stringify(entries), 'utf8') <= byteLimit) return entries;
  const next: TaskLogLine = {
    sequence: (entries.at(-1)?.sequence ?? 0) + 1,
    timestamp: new Date().toISOString(),
    level,
    message: message.slice(0, 512),
    attempt,
    ...(code ? { code } : {}),
  };
  const candidate = [...entries, next];
  if (
    !marker &&
    candidate.length < MAX_OPERATION_LOG_ENTRIES &&
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') < byteLimit - 256
  ) {
    return candidate;
  }
  const bounded = [
    ...entries
      .filter((entry) => entry.code !== 'LOG_LIMIT_REACHED')
      .slice(0, MAX_OPERATION_LOG_ENTRIES - 1),
    {
      ...(marker ?? next),
      level: 'warn' as const,
      message: '操作日志达到保留上限，后续内容已省略。',
      code: 'LOG_LIMIT_REACHED',
    },
  ];
  while (bounded.length > 1 && Buffer.byteLength(JSON.stringify(bounded), 'utf8') > byteLimit) {
    bounded.splice(bounded.length - 2, 1);
  }
  return bounded;
}
