import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable, type Subscription } from 'rxjs';
import { requestAuditContext } from '@ozz/control-plane/audit';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const route = request.routeOptions.url ?? '/api/unknown';
    const resourceType = route.split('/')[2] ?? 'unknown';
    const params = request.params as Record<string, unknown> | undefined;
    return new Observable((subscriber) => {
      let subscription: Subscription | undefined;
      requestAuditContext.run(
        {
          actorId: request.user?.id,
          requestId: request.id,
          action: `${request.method.toLowerCase()}:${route}`,
          resourceType,
          resourceId: typeof params?.id === 'string' ? params.id : undefined,
        },
        () => {
          subscription = next.handle().subscribe(subscriber);
        },
      );
      return () => subscription?.unsubscribe();
    });
  }
}
