import { Module } from '@nestjs/common';
import { DatabasesController } from './databases.controller.js';
import { DatabasesService } from './databases.service.js';
@Module({
  controllers: [DatabasesController],
  providers: [DatabasesService],
  exports: [DatabasesService],
})
export class DatabasesModule {}
