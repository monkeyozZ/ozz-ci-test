import { createLogger, loadConfig } from '../../packages/config/dist/index.js';
import { createApp } from '../../apps/api/dist/app.js';
import { createProductGitHubAdapter } from './support/s6-github-product.mjs';

// The fixture replaces only GitHub transport. All public API/domain paths are production code.
async function main() {
  const config = loadConfig();
  if (config.host !== '127.0.0.1') throw new Error('S6_PRODUCT_REQUIRES_LOOPBACK_HOST');
  const githubAdapter = await createProductGitHubAdapter();
  const app = await createApp({ githubAdapter });
  try {
    await app.listen(config.port, config.host);
  } catch (error) {
    await app.close();
    throw error;
  }
  createLogger('api').info({ port: config.port, githubFixture: true }, 'API ready');
}

void main().catch(() => {
  createLogger('api').fatal(
    { code: 'S6_PRODUCT_API_STARTUP_FAILED' },
    'API could not start; check the private fixture configuration and product dependencies',
  );
  process.exitCode = 1;
});
