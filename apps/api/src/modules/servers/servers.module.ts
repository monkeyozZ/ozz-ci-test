import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ozz/database';
import { SecretsModule } from '../secrets/secrets.module.js';
import { ServersController } from './servers.controller.js';
import { ServersService } from './servers.service.js';

@Module({
  imports: [DatabaseModule, SecretsModule],
  controllers: [ServersController],
  providers: [ServersService],
  exports: [ServersService],
})
export class ServersModule {}
