import { Global, Module } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service.js';

@Global()
@Module({ providers: [InfrastructureService], exports: [InfrastructureService] })
export class InfrastructureModule {}
