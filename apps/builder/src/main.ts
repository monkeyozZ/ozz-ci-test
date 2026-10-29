import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { FileBuildLedger } from './ledger.js';
import { BuildManager } from './manager.js';
import { LinuxBuildDriver } from './linux-driver.js';
import { builderServer } from './server.js';
import { integer, uuid } from '@ozz/infrastructure/build';

async function privateFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 262144 || stat.mode & 0o037)
      throw new Error('BUILDER_FILE_PERMISSIONS');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('BUILDER_REQUIRES_SEPARATE_MANAGER_UID');
  const config = JSON.parse(await privateFile('/etc/ozz-builder/manager.json')) as {
    installationId: string;
    instanceId: string;
    initialGeneration: number;
    ledgerDirectory: string;
    signingKeyFile: string;
    certificateFile: string;
    privateKeyFile: string;
    clientCaFile: string;
    clientFingerprints: string[];
    trustedCloneOrigins: string[];
    host: string;
    port: number;
  };
  uuid(config.installationId);
  uuid(config.instanceId);
  if (
    !config.clientFingerprints.length ||
    config.clientFingerprints.some((value) => !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(value))
  )
    throw new Error('BUILDER_CLIENT_IDENTITY_REQUIRED');
  const manager = new BuildManager(
    new FileBuildLedger(config.ledgerDirectory),
    new LinuxBuildDriver(),
    {
      installationId: config.installationId,
      instanceId: config.instanceId,
      initialGeneration: integer(config.initialGeneration, 0),
      signingPrivateKey: await privateFile(config.signingKeyFile),
      trustedCloneOrigins: config.trustedCloneOrigins,
    },
  );
  await manager.start();
  const server = builderServer(
    manager,
    {
      cert: await privateFile(config.certificateFile),
      key: await privateFile(config.privateKeyFile),
      ca: await privateFile(config.clientCaFile),
    },
    config.clientFingerprints,
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void manager.stop().finally(() => {
      server.closeAllConnections();
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write('BUILDER_STARTUP_FAILED\n');
    process.exitCode = 1;
  });
