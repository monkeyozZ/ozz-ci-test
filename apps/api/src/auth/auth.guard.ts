import { timingSafeEqual } from 'node:crypto';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { loadConfig } from '@ozz/config';
import type { FastifyRequest } from 'fastify';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { IS_PUBLIC } from './public.decorator';
import { Problem } from '../common/problem';
import './auth.types';
import { IS_SIGNED_GITHUB_WEBHOOK } from './webhook.decorator.js';

export function assertOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (origin !== loadConfig().appOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new Problem(403, 'ORIGIN_REJECTED', '请求来源不受信任。');
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (
      this.reflector.getAllAndOverride<boolean>(IS_SIGNED_GITHUB_WEBHOOK, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertOrigin(request);
      return true;
    }
    const session = await this.auth.authenticate(request.cookies[SESSION_COOKIE]);
    Object.assign(request, session);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      assertOrigin(request);
      const csrf = request.headers['x-csrf-token'];
      const expected = Buffer.from(session.csrfToken);
      if (
        typeof csrf !== 'string' ||
        Buffer.byteLength(csrf) !== expected.length ||
        !timingSafeEqual(Buffer.from(csrf), expected)
      ) {
        throw new Problem(403, 'CSRF_REJECTED', '页面校验已失效，请刷新后重试。');
      }
    }
    return true;
  }
}
