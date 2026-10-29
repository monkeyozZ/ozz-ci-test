import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ozz/database';
import { CommonModule } from '../../common/common.module.js';
import { SecretsController } from './secrets.controller.js';
import { SecretsService } from './secrets.service.js';

@Module({
  imports: [DatabaseModule, CommonModule],
  controllers: [SecretsController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
