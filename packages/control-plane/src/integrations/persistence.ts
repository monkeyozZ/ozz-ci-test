import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import type { Prisma } from '@ozz/database';
import { parseGitHubToken } from '@ozz/infrastructure/github';
import { parseRegistryAccess } from '@ozz/infrastructure/registry';
import type { BuilderTlsConnection } from '@ozz/infrastructure/build';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError } from '../tasks/contracts.js';

export function parseWebhookSecret(payload: unknown): string {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => key !== 'secret') ||
    typeof (payload as { secret?: unknown }).secret !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test((payload as { secret: string }).secret)
  )
    throw new OperationRequestError(
      422,
      'WEBHOOK_SECRET_INVALID',
      'Webhook 凭证须为独立随机 secret，至少 32 个 base64url 字符。',
    );
  return (payload as { secret: string }).secret;
}

export function parseBuilderCredential(payload: unknown): Omit<BuilderTlsConnection, 'origin'> {
  const invalid = () =>
    new OperationRequestError(
      422,
      'BUILDER_CREDENTIAL_INVALID',
      'Builder 凭证须包含有效 CA、客户端证书及匹配的私钥。',
    );
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  const value = payload as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['caCertificate', 'clientCertificate', 'clientPrivateKey'].includes(key),
    ) ||
    ['caCertificate', 'clientCertificate', 'clientPrivateKey'].some(
      (key) => typeof value[key] !== 'string' || Buffer.byteLength(value[key] as string) > 32768,
    )
  )
    throw invalid();
  try {
    const ca = new X509Certificate(value.caCertificate as string),
      cert = new X509Certificate(value.clientCertificate as string);
    const key = createPrivateKey(value.clientPrivateKey as string);
    if (!ca.ca || !cert.publicKey.equals(createPublicKey(key))) throw invalid();
    createSecureContext({
      ca: value.caCertificate as string,
      cert: value.clientCertificate as string,
      key: value.clientPrivateKey as string,
    });
    return {
      caCertificate: value.caCertificate as string,
      clientCertificate: value.clientCertificate as string,
      clientPrivateKey: value.clientPrivateKey as string,
    };
  } catch {
    throw invalid();
  }
}

export function validateIntegrationSecretPayload(kind: string, payload: unknown): void {
  if (kind === 'git') parseGitHubToken(payload);
  if (kind === 'registry') parseRegistryAccess(payload);
  if (kind === 'webhook') parseWebhookSecret(payload);
  if (kind === 'builder') parseBuilderCredential(payload);
}

export async function integrationCredential(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  id: string,
  kind: 'git' | 'registry' | 'builder' | 'webhook',
) {
  const secret = await tx.secretReference.findUnique({ where: { id } });
  if (!secret || secret.kind !== kind)
    throw new OperationRequestError(422, 'CREDENTIAL_KIND_MISMATCH', '集成凭证类型与用途不匹配。');
  if (secret.expiresAt && secret.expiresAt <= new Date())
    throw new OperationRequestError(
      422,
      'CREDENTIAL_EXPIRED',
      '集成凭证已过期，请选择新的有效凭证。',
    );
  const payload = cipher.decrypt(secret);
  validateIntegrationSecretPayload(kind, payload);
  return { id: secret.id, contentRevision: secret.contentRevision, payload };
}

export async function auditCredentialUse(
  tx: Prisma.TransactionClient,
  purpose: string,
  resourceId: string,
  credentialRefId: string,
) {
  await tx.auditEvent.create({
    data: {
      action: 'integration.credential_used',
      resourceType: 'integration',
      resourceId,
      outcome: 'succeeded',
      metadata: { purpose, credentialRefId },
    },
  });
}

export async function currentGitCredential(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  githubConnectionId: string,
  purpose = 'github_read',
) {
  const connection = await tx.gitHubConnection.findUnique({ where: { id: githubConnectionId } });
  if (!connection)
    throw new OperationRequestError(404, 'GITHUB_CONNECTION_NOT_FOUND', 'GitHub 连接不存在。');
  const credential = await integrationCredential(tx, cipher, connection.credentialRefId, 'git');
  await auditCredentialUse(tx, purpose, connection.id, credential.id);
  return {
    connection,
    credentialRefId: credential.id,
    token: parseGitHubToken(credential.payload),
  };
}

export async function currentRegistryCredential(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  registryConnectionId: string,
  phase: 'push' | 'pull',
) {
  const connection = await tx.registryConnection.findUnique({
    where: { id: registryConnectionId },
  });
  if (!connection)
    throw new OperationRequestError(
      404,
      'REGISTRY_CONNECTION_NOT_FOUND',
      '原固定镜像仓库连接不存在。',
    );
  const credential = await integrationCredential(
    tx,
    cipher,
    phase === 'push' ? connection.pushCredentialRefId : connection.pullCredentialRefId,
    'registry',
  );
  const access = parseRegistryAccess(credential.payload);
  if (access.registry !== connection.authority)
    throw new OperationRequestError(
      422,
      'REGISTRY_ACCESS_MISMATCH',
      '当前凭证不属于原固定镜像仓库。',
    );
  await auditCredentialUse(tx, `registry_${phase}`, connection.id, credential.id);
  return { connection, credentialRefId: credential.id, access, payload: credential.payload };
}
