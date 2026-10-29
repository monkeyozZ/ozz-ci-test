import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { PrismaService } from '@ozz/database';
import { loadConfig } from '@ozz/config';
import { readRecoveryState, ControlPlaneReadOnlyError } from '@ozz/control-plane/recovery';
import type { FastifyRequest } from 'fastify';

@Injectable()
export class RestoreGuard implements CanActivate {
  constructor(private readonly db: PrismaService) {}
  async canActivate(ctx: ExecutionContext) {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.url.startsWith('/api/auth/'))
      return true;
    const state = await readRecoveryState(this.db);
    if (state.restoreLocked || loadConfig().restoreMode) throw new ControlPlaneReadOnlyError();
    return true;
  }
}
