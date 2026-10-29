import { Injectable } from '@nestjs/common';
import { loadConfig } from '@ozz/config';
import { PrismaService } from '@ozz/database';
import { ControlPlaneReadOnlyError } from '@ozz/control-plane/recovery';
import {
  OperationRequestError,
  TaskRepository,
  type OperationActor,
} from '@ozz/control-plane/tasks';
import { Problem } from '../../common/problem.js';
import { InfrastructureService } from '../infrastructure/infrastructure.service.js';
import { ServicesService } from '../services/services.service.js';
import { NetworkingService } from '../networking/networking.service.js';
import { StorageService } from '../storage/storage.service.js';
import { DiagnosticRequestDto, OperationLogQueryDto, OperationQueryDto } from './operation.dto.js';

@Injectable()
export class OperationsService {
  private readonly repository: TaskRepository;

  constructor(
    database: PrismaService,
    private readonly infrastructure: InfrastructureService,
    private readonly services: ServicesService,
    private readonly networking: NetworkingService,
    private readonly storage: StorageService,
  ) {
    const config = loadConfig();
    this.repository = new TaskRepository(database, {
      logRetentionMs: config.taskLogRetentionDays * 86_400_000,
      logMaxBytes: config.taskLogMaxBytes,
    });
  }

  private async request<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OperationRequestError)
        throw new Problem(error.status, error.code, error.message);
      if (error instanceof ControlPlaneReadOnlyError)
        throw new Problem(503, error.code, error.message);
      throw error;
    }
  }

  list(query: OperationQueryDto) {
    return this.request(() => this.repository.list(query));
  }
  get(id: string) {
    return this.request(async () => ({ data: await this.repository.get(id) }));
  }
  logs(id: string, query: OperationLogQueryDto) {
    return this.request(() => this.repository.logs(id, query));
  }
  workerStatus() {
    return this.request(async () => ({ data: await this.repository.workerStatus() }));
  }
  create(input: DiagnosticRequestDto, actor: OperationActor, key: unknown) {
    return this.request(async () => ({
      data: await this.repository.createDiagnostic(actor, key, input),
    }));
  }
  async retry(id: string, actor: OperationActor, key: unknown) {
    const operation = await this.request(() => this.repository.get(id));
    if (operation.kind.startsWith('volume_'))
      return this.storage.request(async (commands) => ({
        data: await commands.retry(id, actor, key),
      }));
    if (
      operation.kind.startsWith('domain_') ||
      ['cluster_network_check', 'cluster_cert_manager_install'].includes(operation.kind)
    )
      return this.networking.request(async (commands) => ({
        data: await commands.retryOperation(id, actor, key),
      }));
    if (operation.kind.startsWith('service_'))
      return this.services.request(async () => ({
        data: await this.services.commands.retryOperation(id, actor, key),
      }));
    return this.infrastructure.request(async (commands) => ({
      data: await commands.retry(id, actor, key),
    }));
  }
  cancel(id: string, actor: OperationActor) {
    return this.request(async () => ({ data: await this.repository.cancel(id, actor) }));
  }
}
