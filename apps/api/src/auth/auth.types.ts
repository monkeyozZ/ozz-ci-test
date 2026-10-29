import type { FastifyRequest } from 'fastify';

export interface AuthUser {
  id: string;
  username: string;
}
export interface AuthenticatedRequest extends FastifyRequest {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
  sessionExpiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    sessionId?: string;
    csrfToken?: string;
    sessionExpiresAt?: Date;
  }
}
