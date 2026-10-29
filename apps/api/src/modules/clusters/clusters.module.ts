import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ozz/database';
import { SecretsModule } from '../secrets/secrets.module.js';
import { ClustersController } from './clusters.controller.js';
import { ClustersService } from './clusters.service.js';

@Module({
  imports: [DatabaseModule, SecretsModule],
  controllers: [ClustersController],
  providers: [ClustersService],
  exports: [ClustersService],
})
export class ClustersModule {}
