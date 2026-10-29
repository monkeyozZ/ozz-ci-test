import { Module } from '@nestjs/common';
import { DeploymentsController } from './deployments.controller.js';
import { DeploymentsService } from './deployments.service.js';

@Module({ controllers: [DeploymentsController], providers: [DeploymentsService] })
export class DeploymentsModule {}
