import {
  BuildCoordinator,
  BuildReconciler,
  type BuildCoordinatorOptions,
} from '@ozz/control-plane/builds';
import { GitWebhookDispatcher } from '@ozz/control-plane/git';
import { IntegrationExecutor } from '@ozz/control-plane/integrations';
import type { SecretCipher } from '@ozz/control-plane/secrets';
import type { TaskRepository } from '@ozz/control-plane/tasks';
import { GitHubAdapter } from '@ozz/infrastructure/github';
import {
  RegistryProbe,
  type RegistryImageResolver,
  type RegistryPermissionProbe,
} from '@ozz/infrastructure/registry';

/** Worker composition seam for controlled HTTPS protocol fixtures. No public request can set it. */
export type WorkerGitExecutionOptions = BuildCoordinatorOptions & {
  registryProbe?: RegistryPermissionProbe;
};
export function createWorkerGitExecution(
  repository: TaskRepository,
  cipher: SecretCipher,
  registry: RegistryImageResolver,
  options: WorkerGitExecutionOptions = {},
) {
  const github = options.github ?? new GitHubAdapter();
  return {
    builds: new BuildCoordinator(repository, cipher, registry, { ...options, github }),
    buildReconciler: new BuildReconciler(repository, cipher, options.clientFactory),
    // Dispatcher admission only uses fixed persisted receipts; Git network access happens in checkout.
    gitDispatcher: new GitWebhookDispatcher(repository, cipher),
    integrations: new IntegrationExecutor(
      repository,
      cipher,
      github,
      options.registryProbe ?? new RegistryProbe(),
    ),
  };
}
