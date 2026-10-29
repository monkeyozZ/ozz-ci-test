import { Module, type DynamicModule } from '@nestjs/common';
import type { GitHubClient } from '@ozz/infrastructure/github';
import { IntegrationAdaptersModule } from './modules/integrations/adapters.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { GitModule } from './modules/git/git.module.js';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from '@ozz/database';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { CommonModule } from './common/common.module';
import { RestoreGuard } from './common/restore.guard';
import { AuditInterceptor } from './common/audit.interceptor';
import { HealthController } from './health/health.controller';
import { ProjectsModule } from './modules/projects/projects.module';
import { EnvironmentsModule } from './modules/environments/environments.module';
import { ServersModule } from './modules/servers/servers.module';
import { ClustersModule } from './modules/clusters/clusters.module';
import { SecretsModule } from './modules/secrets/secrets.module';
import { OperationsModule } from './modules/operations/operations.module';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module.js';
import { ServicesModule } from './modules/services/services.module.js';
import { DeploymentsModule } from './modules/deployments/deployments.module.js';
import { NetworkingModule } from './modules/networking/networking.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { DatabasesModule } from './modules/databases/databases.module.js';
import { TemplatesModule } from './modules/templates/templates.module.js';

@Module({})
export class AppModule {
  static register(githubAdapter?: GitHubClient): DynamicModule {
    return {
      module: AppModule,
      imports: [
        IntegrationAdaptersModule.register(githubAdapter),
        IntegrationsModule,
        GitModule,
        DatabaseModule,
        CommonModule,
        InfrastructureModule,
        ServicesModule,
        DeploymentsModule,
        NetworkingModule,
        StorageModule,
        DatabasesModule,
        TemplatesModule,
        AuthModule,
        ProjectsModule,
        EnvironmentsModule,
        ServersModule,
        ClustersModule,
        SecretsModule,
        OperationsModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RestoreGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
      ],
    };
  }
}
