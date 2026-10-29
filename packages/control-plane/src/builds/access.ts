import type { Prisma } from '@ozz/database';
import {
  HttpBuilderClient,
  HttpsBuilderTransport,
  BuilderError,
  type BuilderClient,
  type BuilderTlsConnection,
} from '@ozz/infrastructure/build';
import type { GitSourceRevision } from '../git/contracts.js';
import {
  currentRegistryCredential,
  integrationCredential,
  parseBuilderCredential,
  auditCredentialUse,
} from '../integrations/persistence.js';
import type { SecretCipher } from '../secrets.js';

export async function fixedRegistryCredential(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  destination: GitSourceRevision['destination'],
  phase: 'pull' | 'push',
) {
  const resolved = await currentRegistryCredential(
    tx,
    cipher,
    destination.registryConnectionId,
    phase,
  );
  if (
    resolved.connection.authority !== destination.authority ||
    (destination.repository !== resolved.connection.namespace &&
      !destination.repository.startsWith(`${resolved.connection.namespace}/`))
  )
    throw new BuilderError('BUILD_IDENTITY_MISMATCH');
  return resolved;
}
export async function fixedRegistryAccess(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  destination: GitSourceRevision['destination'],
) {
  return (await fixedRegistryCredential(tx, cipher, destination, 'pull')).access;
}
export async function currentBuilderAccess(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  builderId: string,
  instanceId: string,
  factory: (connection: BuilderTlsConnection) => BuilderClient = (connection) =>
    new HttpBuilderClient(new HttpsBuilderTransport(connection)),
) {
  const builder = await tx.builder.findUniqueOrThrow({ where: { id: builderId } });
  if (builder.instanceId !== instanceId) throw new BuilderError('BUILD_IDENTITY_MISMATCH');
  const credential = await integrationCredential(tx, cipher, builder.credentialRefId, 'builder');
  await auditCredentialUse(tx, 'builder_control', builder.id, credential.id);
  return {
    builder,
    client: factory({ origin: builder.endpoint, ...parseBuilderCredential(credential.payload) }),
  };
}
