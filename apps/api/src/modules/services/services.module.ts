import { Global, Module } from '@nestjs/common';
import { ServicesController } from './services.controller.js';
import { ServicesService } from './services.service.js';
import { ServiceLogsService } from './logs.service.js';

@Global()
@Module({
  controllers: [ServicesController],
  providers: [ServicesService, ServiceLogsService],
  exports: [ServicesService],
})
export class ServicesModule {}
