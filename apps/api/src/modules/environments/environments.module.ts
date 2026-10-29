import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ozz/database';
import { EnvironmentsController } from './environments.controller.js';
import { EnvironmentsService } from './environments.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
