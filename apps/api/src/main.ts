import { loadConfig, createLogger, ConfigurationError } from '@ozz/config';
import { MasterKeyError, SecretAuthenticationError } from '@ozz/control-plane/secrets';
import { createApp } from './app';

async function main() {
  const config = loadConfig();
  const app = await createApp();
  await app.listen(config.port, config.host);
  createLogger('api').info({ port: config.port }, 'API ready');
}

void main().catch((error: unknown) => {
  // Startup errors are deliberately bounded; configuration values and Prisma DSNs are never logged.
  const safeDetail =
    error instanceof ConfigurationError ||
    error instanceof MasterKeyError ||
    error instanceof SecretAuthenticationError
      ? error.message
      : undefined;
  createLogger('api').fatal(
    { errorName: error instanceof Error ? error.name : 'UnknownError', detail: safeDetail },
    'API startup failed; verify configuration, database migration and master key file',
  );
  process.exitCode = 1;
});
