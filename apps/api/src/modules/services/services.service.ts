import { Inject, Injectable } from '@nestjs/common';
import { loadConfig } from '@ozz/config';
import { PrismaService } from '@ozz/database';
import { ControlPlaneReadOnlyError } from '@ozz/control-plane/recovery';
import {
  ServiceCommands,
  ServiceOperationActiveError,
  parseEnvironmentFile,
} from '@ozz/control-plane/services';
import {
  OperationRequestError,
  TaskExecutionError,
  TaskRepository,
  type OperationActor,
} from '@ozz/control-plane/tasks';
import { Problem } from '../../common/problem.js';
import { SecretCipherService } from '../../common/secret-cipher.service.js';
import type {
  CreateServiceDto,
  DeployServiceDto,
  EnvironmentImportEnvelopeDto,
  ServiceQueryDto,
  UpdateServiceDto,
} from './service.dto.js';
import { presentDeployment } from '../deployments/presentation.js';
import { GitCommands } from '@ozz/control-plane/git';
import { GitHubError, type GitHubClient } from '@ozz/infrastructure/github';
import { BuilderError } from '@ozz/infrastructure/build';
import { RegistryAdapterError } from '@ozz/infrastructure/registry';
import { GITHUB_CLIENT } from '../integrations/adapters.module.js';

@Injectable()
export class ServicesService {
  readonly repository: TaskRepository;
  readonly commands: ServiceCommands;
  readonly git: GitCommands;

  constructor(
    database: PrismaService,
    cipher: SecretCipherService,
    @Inject(GITHUB_CLIENT) github: GitHubClient,
  ) {
    const config = loadConfig();
    this.repository = new TaskRepository(database, {
      logRetentionMs: config.taskLogRetentionDays * 86_400_000,
      logMaxBytes: config.taskLogMaxBytes,
    });
    this.commands = new ServiceCommands(this.repository, cipher);
    this.git = new GitCommands(this.repository, cipher, github, this.commands);
  }

  async request<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GitHubError)
        throw new Problem(
          error.retryable ? 503 : 422,
          error.code,
          'GitHub 授权、仓库身份或固定来源检查失败，请核对配置后重试。',
        );
      if (error instanceof BuilderError)
        throw new Problem(
          error.retryable ? 503 : 422,
          error.code,
          'Builder 身份、隔离能力或固定配置检查失败。',
        );
      if (error instanceof RegistryAdapterError)
        throw new Problem(error.retryable ? 503 : 422, error.code, error.message);
      if (error instanceof ServiceOperationActiveError) {
        const { type, id } = error.activeTask;
        throw new Problem(error.status, error.code, error.message, {
          activeTask: [`/${type === 'deployment' ? 'deployments' : 'operations'}/${id}`],
        });
      }
      if (error instanceof OperationRequestError)
        throw new Problem(error.status, error.code, error.message);
      if (error instanceof ControlPlaneReadOnlyError)
        throw new Problem(503, error.code, error.message);
      if (error instanceof TaskExecutionError) throw new Problem(409, error.code, error.message);
      throw error;
    }
  }
  list(query: ServiceQueryDto) {
    return this.request(() => this.commands.list(query));
  }
  get(id: string) {
    return this.request(async () => ({ data: await this.commands.get(id) }));
  }
  create(input: CreateServiceDto, actor: OperationActor, key: unknown) {
    return this.request(async () => ({ data: await this.commands.create(input, actor, key) }));
  }
  update(id: string, input: UpdateServiceDto) {
    return this.request(async () => ({ data: await this.commands.update(id, input) }));
  }
  parseEnvironment(text: string): Promise<EnvironmentImportEnvelopeDto> {
    return this.request(() => ({ data: parseEnvironmentFile(text) }));
  }
  deploy(id: string, input: DeployServiceDto, actor: OperationActor, key: unknown) {
    return this.request(async () => ({
      data: presentDeployment(
        input.previewId
          ? await this.git.deploy(id, { ...input, previewId: input.previewId }, actor, key)
          : await this.commands.deploy(id, input, actor, key),
      ),
    }));
  }
  action(
    id: string,
    action: 'restart' | 'stop' | 'resume' | 'delete',
    input: { revision: number },
    actor: OperationActor,
    key: unknown,
  ) {
    return this.request(async () => ({
      data: await this.commands.action(id, action, input, actor, key),
    }));
  }
  async pods(id: string) {
    return this.request(async () => {
      const service = await this.commands.get(id);
      return {
        data: {
          pods: service.observation?.pods ?? [],
          observedAt: service.lastObservedAt,
          stale: service.observationStale,
          truncated: service.observation?.podsTruncated ?? false,
        },
      };
    });
  }
  async metrics(id: string) {
    return this.request(async () => {
      const service = await this.commands.get(id);
      return {
        data: {
          ...(service.observation?.metrics ?? {
            state: 'unknown',
            cpuCores: null,
            memoryBytes: null,
            observedAt: null,
            windowSeconds: null,
          }),
          stale: service.observationStale,
        },
      };
    });
  }
}
