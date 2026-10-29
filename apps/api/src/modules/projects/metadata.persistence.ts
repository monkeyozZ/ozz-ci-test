import { isIP } from 'node:net';
import { Prisma } from '@ozz/database';
import { OperationRequestError } from '@ozz/control-plane/tasks';
import { decodeCursor, pageResult } from '../../common/pagination.js';
import { Problem } from '../../common/problem.js';

export const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

export function cursorWhere(value?: string) {
  const cursor = decodeCursor(value);
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}

export function mappedPage<T extends { id: string; createdAt: Date }, R>(
  rows: T[],
  limit: number,
  present: (row: T) => R,
) {
  const result = pageResult(rows, limit);
  return { data: result.data.map(present), page: result.page };
}

export function requireRecord<T>(value: T | null, label: string): T {
  if (!value) throw new Problem(404, 'RESOURCE_NOT_FOUND', label + '不存在。');
  return value;
}

export function requireRevision(record: { revision: number }, revision: number): void {
  if (record.revision !== revision) revisionConflict();
}

export function revisionConflict(): never {
  throw new Problem(409, 'REVISION_CONFLICT', '资源已被修改，请刷新并核对最新内容后重试。');
}

export function requireChanges(input: object, fields: readonly string[]): void {
  if (!fields.some((field) => (input as Record<string, unknown>)[field] !== undefined)) {
    throw new Problem(422, 'EMPTY_UPDATE', '请至少提交一个可编辑字段。');
  }
}

/** Keep unique/FK races as safe domain errors; never expose Prisma's input or SQL. */
export async function metadataMutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OperationRequestError)
      throw new Problem(error.status, error.code, error.message);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new Problem(409, 'SLUG_CONFLICT', '该标识已被使用，请选择其他标识。');
      }
      if (error.code === 'P2003') {
        throw new Problem(409, 'RESOURCE_IN_USE', '资源仍被引用，或关联资源已变化，请刷新后重试。');
      }
      if (error.code === 'P2004') {
        throw new Problem(
          409,
          'DATA_IDENTITY_PROTECTED',
          '数据保护约束拒绝此操作，请刷新并核对仍在使用或保留的数据。',
        );
      }
      if (error.code === 'P2025') {
        throw new Problem(404, 'RESOURCE_NOT_FOUND', '资源不存在或已被移除。');
      }
      if (error.code === 'P2034') revisionConflict();
    }
    throw error;
  }
}

export function validateHost(host: string): void {
  if (isIP(host)) return;
  const labels = host.split('.');
  const valid =
    host.length <= 253 &&
    !/^[0-9.]+$/.test(host) &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!valid) {
    throw new Problem(422, 'INVALID_HOST', '请输入有效的 IP 地址或主机名，不含协议、端口或凭证。', {
      host: ['请输入有效的 IP 地址或主机名。'],
    });
  }
}

export function validateApiEndpoint(endpoint: string | null | undefined): void {
  if (endpoint == null) return;
  try {
    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('invalid endpoint');
    }
  } catch {
    throw new Problem(
      422,
      'INVALID_API_ENDPOINT',
      '集群 API 地址必须使用 HTTPS，且不能包含凭证、查询参数或片段。',
      {
        apiEndpoint: ['请输入不含凭证、查询参数或片段的 HTTPS API 地址。'],
      },
    );
  }
}
