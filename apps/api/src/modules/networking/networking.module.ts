import { Global, Module } from '@nestjs/common';
import { NetworkingController } from './networking.controller.js';
import { NetworkingService } from './networking.service.js';

@Global()
@Module({
  controllers: [NetworkingController],
  providers: [NetworkingService],
  exports: [NetworkingService],
})
export class NetworkingModule {}
