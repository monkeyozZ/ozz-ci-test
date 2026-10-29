import { Injectable } from '@nestjs/common';
import { loadConfig } from '@ozz/config';
import { PrismaService } from '@ozz/database';
import { NetworkingCommands, NetworkingConflictError } from '@ozz/control-plane/networking';
import { ServiceOperationActiveError } from '@ozz/control-plane/services';
import { ControlPlaneReadOnlyError } from '@ozz/control-plane/recovery';
import {
  OperationRequestError,
  TaskExecutionError,
  TaskRepository,
} from '@ozz/control-plane/tasks';
import { Problem } from '../../common/problem.js';

@Injectable()
export class NetworkingService {
  readonly commands: NetworkingCommands;
  constructor(database: PrismaService) {
    const config = loadConfig();
    this.commands = new NetworkingCommands(
      new TaskRepository(database, {
        logRetentionMs: config.taskLogRetentionDays * 86_400_000,
        logMaxBytes: config.taskLogMaxBytes,
      }),
    );
  }
  async request<T>(work: (commands: NetworkingCommands) => Promise<T>): Promise<T> {
    try {
      return await work(this.commands);
    } catch (error) {
      if (error instanceof ServiceOperationActiveError) {
        const ref = error.activeTask;
        throw new Problem(error.status, error.code, error.message, {
          activeTask: [`/${ref.type === 'deployment' ? 'deployments' : 'operations'}/${ref.id}`],
        });
      }
      if (error instanceof NetworkingConflictError)
        throw new Problem(
          error.status,
          error.code,
          error.message,
          error.affectedDomains.length ? { domains: error.affectedDomains } : undefined,
        );
      if (error instanceof OperationRequestError)
        throw new Problem(error.status, error.code, error.message);
      if (error instanceof ControlPlaneReadOnlyError)
        throw new Problem(503, error.code, error.message);
      if (error instanceof TaskExecutionError) throw new Problem(409, error.code, error.message);
      throw error;
    }
  }
}
