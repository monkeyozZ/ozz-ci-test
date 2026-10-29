import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@ozz/database';
import { ControlPlaneReadOnlyError } from '@ozz/control-plane/recovery';
import { createLogger } from '@ozz/config';

const titles: Record<number, string> = {
  400: '请求格式错误',
  401: '需要登录',
  403: '请求被拒绝',
  404: '资源不存在',
  409: '资源状态冲突',
  413: '请求内容过大',
  415: '不支持的内容类型',
  422: '字段校验失败',
  429: '请求过于频繁',
  500: '服务暂时异常',
  502: '外部服务异常',
  503: '服务暂不可用',
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger;
  constructor(silent = false) {
    this.logger = createLogger('api-errors', {
      level: silent ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
    });
  }

  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const res = host.switchToHttp().getResponse<FastifyReply>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let detail = '操作暂时无法完成，请凭请求编号联系管理员。';
    let errors: Record<string, string[]> | undefined;
    if (error instanceof HttpException) {
      status = error.getStatus();
      // Nest may wrap a Fastify parser error in HttpException and retain only
      // its status/message. Never echo that message (it can include input).
      const defaults: Record<number, string> = {
        400: 'MALFORMED_REQUEST',
        413: 'PAYLOAD_TOO_LARGE',
        415: 'UNSUPPORTED_MEDIA_TYPE',
      };
      code = defaults[status] ?? `HTTP_${status}`;
      const value = error.getResponse();
      if (typeof value === 'object' && value !== null) {
        const publicError = value as {
          code?: string;
          detail?: string;
          errors?: Record<string, string[]>;
        };
        code = publicError.code ?? code;
        detail = publicError.detail ?? titles[status] ?? '请求无法完成。';
        errors = publicError.errors;
      } else detail = titles[status] ?? '请求无法完成。';
    } else if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      'statusCode' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('FST_ERR_') &&
      [400, 413, 415].includes(Number(error.statusCode))
    ) {
      status = Number(error.statusCode);
      code =
        status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status === 415
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : 'MALFORMED_REQUEST';
      detail = status === 413 ? '请求内容超过允许大小。' : '请求格式或内容类型不正确。';
    } else if (error instanceof ControlPlaneReadOnlyError) {
      status = 503;
      code = error.code;
      detail = error.message;
    } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const mapping: Record<string, [number, string, string]> = {
        P2002: [409, 'ALREADY_EXISTS', '相同标识的资源已存在。'],
        P2003: [409, 'RESOURCE_IN_USE', '关联资源仍被使用或已发生变化，请刷新后重试。'],
        P2025: [404, 'NOT_FOUND', '资源不存在或已被删除。'],
        P2023: [422, 'INVALID_REFERENCE', '资源标识格式不正确。'],
        P2034: [409, 'REVISION_CONFLICT', '资源已被其他操作修改，请刷新后重试。'],
        P2024: [503, 'DATABASE_BUSY', '数据库繁忙，请稍后重试。'],
      };
      [status, code, detail] = mapping[error.code] ?? [
        500,
        'DATABASE_ERROR',
        '数据操作暂时无法完成。',
      ];
    }
    if (status >= 500)
      this.logger.error(
        {
          requestId: req.id,
          code,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'request failed',
      );
    if (status === 429) res.header('Retry-After', '900');
    return res
      .status(status)
      .type('application/problem+json')
      .send({
        type: `urn:ozz:problem:${code.toLowerCase().replaceAll('_', '-')}`,
        title: titles[status] ?? '请求失败',
        status,
        detail,
        instance: req.url.split('?')[0],
        code,
        requestId: req.id,
        ...(errors ? { errors } : {}),
      });
  }
}
