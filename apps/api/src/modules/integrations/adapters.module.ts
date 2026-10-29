import { Module, type DynamicModule } from '@nestjs/common';
import { GitHubAdapter, type GitHubClient } from '@ozz/infrastructure/github';

export const GITHUB_CLIENT = Symbol('ozz.github.client');
@Module({})
export class IntegrationAdaptersModule {
  /** Trusted application composition; no origin or authentication bypass is accepted by HTTP DTOs. */
  static register(github: GitHubClient = new GitHubAdapter()): DynamicModule {
    return {
      module: IntegrationAdaptersModule,
      global: true,
      providers: [{ provide: GITHUB_CLIENT, useValue: github }],
      exports: [GITHUB_CLIENT],
    };
  }
}
