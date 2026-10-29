import { Global, Module } from '@nestjs/common';
import { StorageController } from './storage.controller.js';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
