import { Injectable } from '@nestjs/common';
import { PrismaService } from '@ozz/database';
import type { OperationActor } from '@ozz/control-plane/tasks';
import { ServicesService } from '../services/services.service.js';
import type { DeployServiceDto } from '../services/service.dto.js';
import type { OperationLogQueryDto } from '../operations/operation.dto.js';
import type { DeploymentQueryDto } from './deployment.dto.js';
import { presentDeployment } from './presentation.js';
import { BuildQueries } from '@ozz/control-plane/builds';
import type { BuildLogQueryDto } from './build.dto.js';

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly services: ServicesService,
    private readonly database: PrismaService,
  ) {}
  list(query: DeploymentQueryDto) {
    return this.services.request(async () => {
      const page = await this.services.repository.listDeployments(query);
      return { ...page, data: page.data.map(presentDeployment) };
    });
  }
  get(id: string) {
    return this.services.request(async () => {
      const deployment = presentDeployment(await this.services.repository.getDeployment(id));
      const stages = await this.database.deploymentStage.findMany({
        where: { deploymentId: id },
        orderBy: [{ attempt: 'asc' }, { startedAt: 'asc' }],
      });
      const build =
        deployment.kind === 'git_deploy' ? await new BuildQueries(this.database).detail(id) : null;
      return {
        data: {
          ...deployment,
          build,
          stages: stages.map((stage) => ({
            ...stage,
            startedAt: stage.startedAt?.toISOString() ?? null,
            finishedAt: stage.finishedAt?.toISOString() ?? null,
          })),
        },
      };
    });
  }
  logs(id: string, query: OperationLogQueryDto) {
    return this.services.request(() => this.services.repository.deploymentLogs(id, query));
  }
  buildLogs(id: string, query: BuildLogQueryDto) {
    return this.services.request(() => new BuildQueries(this.database).logs(id, query));
  }
  cancel(id: string, actor: OperationActor) {
    return this.services.request(async () => ({
      data: presentDeployment(await this.services.repository.cancelDeployment(id, actor)),
    }));
  }
  retry(id: string, input: DeployServiceDto, actor: OperationActor, key: unknown) {
    return this.services.request(async () => ({
      data: presentDeployment(await this.services.commands.retryDeployment(id, input, actor, key)),
    }));
  }
}
