import { Inject, Injectable } from '@nestjs/common';
import { loadConfig } from '@ozz/config';
import { IntegrationCommands } from '@ozz/control-plane/integrations';
import type { GitHubClient } from '@ozz/infrastructure/github';
import { SecretCipherService } from '../../common/secret-cipher.service.js';
import { ServicesService } from '../services/services.service.js';
import { GITHUB_CLIENT } from './adapters.module.js';

@Injectable()
export class IntegrationsService {
  readonly commands: IntegrationCommands;
  constructor(
    readonly services: ServicesService,
    cipher: SecretCipherService,
    @Inject(GITHUB_CLIENT) github: GitHubClient,
  ) {
    this.commands = new IntegrationCommands(
      services.repository,
      cipher,
      github,
      loadConfig().appOrigin,
    );
  }
  request<T>(work: () => T | Promise<T>) {
    return this.services.request(work);
  }
}
