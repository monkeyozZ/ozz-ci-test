import { createLogger, loadConfig } from '../../packages/config/dist/index.js';
import { startWorker } from '../../apps/worker/dist/main.js';
import { createProductGitHubAdapter } from './support/s6-github-product.mjs';

// Full production lifecycle: durable tasks, execution, reconciliation and all observers.
async function main() {
  if (loadConfig().host !== '127.0.0.1') throw new Error('S6_PRODUCT_REQUIRES_LOOPBACK_HOST');
  const github = await createProductGitHubAdapter();
  await startWorker({ github });
}

void main().catch(() => {
  const logger = createLogger('worker');
  logger.fatal(
    { code: 'S6_PRODUCT_WORKER_STARTUP_FAILED' },
    'Worker could not start; check the private fixture configuration and product dependencies',
  );
  logger.flush();
  process.exit(1);
});
