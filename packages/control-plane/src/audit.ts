import { AsyncLocalStorage } from 'node:async_hooks';

/** Only non-sensitive request identity enters the shared mutation context. */
export interface AuditContext {
  actorId?: string;
  requestId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
}

export const requestAuditContext = new AsyncLocalStorage<AuditContext>();
