import { Module } from '@nestjs/common';
import { GitController } from './git.controller.js';
import { GitService } from './git.service.js';
import { GitHubWebhookController, GitHubWebhookGuard } from './webhook.controller.js';
@Module({
  controllers: [GitController, GitHubWebhookController],
  providers: [GitService, GitHubWebhookGuard],
})
export class GitModule {}
