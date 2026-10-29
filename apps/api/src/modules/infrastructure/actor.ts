import type { OperationActor } from '@ozz/control-plane/tasks';
import { Problem } from '../../common/problem.js';

export interface InfrastructureRequest {
  user?: { id: string };
  id?: string;
}

export function infrastructureActor(request: InfrastructureRequest): OperationActor {
  if (!request.user) throw new Problem(401, 'AUTH_REQUIRED', '需要有效的管理员会话。');
  return { id: request.user.id, requestId: request.id };
}
