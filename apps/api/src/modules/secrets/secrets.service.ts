import { Injectable } from '@nestjs/common';
import { withWritableControlPlane } from '@ozz/control-plane/recovery';
import { assertResourceIdle } from '@ozz/control-plane/infrastructure';
import { assertDatabaseSecretMutation } from '@ozz/control-plane/databases';
import { OperationRequestError } from '@ozz/control-plane/tasks';
import { validateIntegrationSecretPayload } from '@ozz/control-plane/integrations';
import { GitHubError } from '@ozz/infrastructure/github';
import { RegistryAdapterError } from '@ozz/infrastructure/registry';
import { Prisma, PrismaService } from '@ozz/database';
import { Problem } from '../../common/problem.js';
import { SecretCipherService } from '../../common/secret-cipher.service.js';
import {
  cursorWhere,
  mappedPage,
  metadataMutation,
  NEWEST_FIRST,
  requireRecord,
  requireRevision,
  revisionConflict,
} from '../projects/metadata.persistence.js';
import {
  CreateSecretDto,
  type CredentialKind,
  SecretQueryDto,
  SecretResponseDto,
} from './secret.dto.js';

const METADATA_ONLY = {
  id: true,
  name: true,
  kind: true,
  keyVersion: true,
  revision: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
type SecretMetadata = Prisma.SecretReferenceGetPayload<{ select: typeof METADATA_ONLY }>;

function present(secret: SecretMetadata): SecretResponseDto {
  return {
    id: secret.id,
    name: secret.name,
    kind: secret.kind,
    keyVersion: secret.keyVersion,
    revision: secret.revision,
    expiresAt: secret.expiresAt?.toISOString() ?? null,
    createdAt: secret.createdAt.toISOString(),
    updatedAt: secret.updatedAt.toISOString(),
  };
}

@Injectable()
export class SecretsService {
  constructor(
    private readonly db: PrismaService,
    private readonly cipher: SecretCipherService,
  ) {}

  async list(query: SecretQueryDto) {
    const rows = await this.db.secretReference.findMany({
      where: {
        ...(query.kind ? { kind: query.kind } : {}),
        AND: [
          cursorWhere(query.cursor),
          query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {},
        ],
      },
      select: METADATA_ONLY,
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return mappedPage(rows, query.limit, present);
  }

  async get(id: string) {
    const secret = requireRecord(
      await this.db.secretReference.findUnique({ where: { id }, select: METADATA_ONLY }),
      '凭证',
    );
    return { data: present(secret) };
  }

  create(input: CreateSecretDto) {
    if (Buffer.byteLength(JSON.stringify(input.payload), 'utf8') > 64 * 1024) {
      throw new Problem(422, 'SECRET_TOO_LARGE', '凭证内容不能超过 64 KiB。');
    }
    try {
      validateIntegrationSecretPayload(input.kind, input.payload);
    } catch (error) {
      if (
        error instanceof OperationRequestError ||
        error instanceof GitHubError ||
        error instanceof RegistryAdapterError
      )
        throw new Problem(422, error.code, '凭证内容与所选集成类型不匹配，请检查字段。');
      throw error;
    }
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        const encrypted = this.cipher.encrypt(input.kind, input.payload);
        const secret = await tx.secretReference.create({
          data: {
            name: input.name,
            kind: input.kind,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            ...encrypted,
          },
          select: METADATA_ONLY,
        });
        return { data: present(secret) };
      }),
    );
  }

  async assertUsableReference(
    tx: Prisma.TransactionClient,
    id: string | null | undefined,
    kind: CredentialKind,
  ): Promise<void> {
    if (id == null) return;
    const reference = requireRecord(
      await tx.secretReference.findUnique({
        where: { id },
        select: { kind: true, expiresAt: true },
      }),
      '凭证引用',
    );
    if (reference.kind !== kind) {
      throw new Problem(422, 'CREDENTIAL_KIND_MISMATCH', '凭证类型与该资源不匹配。', {
        credentialRefId: ['请选择适用于该资源的凭证类型。'],
      });
    }
    if (reference.expiresAt && reference.expiresAt.getTime() <= Date.now()) {
      throw new Problem(422, 'CREDENTIAL_EXPIRED', '该凭证已过期，请先创建新的有效凭证。', {
        credentialRefId: ['凭证已过期。'],
      });
    }
  }

  delete(id: string, revision: number) {
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "SecretReference" WHERE "id" = ${id}::uuid FOR UPDATE`,
        );
        await assertResourceIdle(tx, { credentialRefId: id });
        const current = requireRecord(
          await tx.secretReference.findUnique({
            where: { id },
            select: { revision: true },
          }),
          '凭证',
        );
        requireRevision(current, revision);
        try {
          await assertDatabaseSecretMutation(tx, id, 'delete');
        } catch (error) {
          if (error instanceof OperationRequestError)
            throw new Problem(error.status, error.code, error.message);
          throw error;
        }
        const deleted = await tx.secretReference.deleteMany({ where: { id, revision } });
        if (deleted.count !== 1) revisionConflict();
      }),
    );
  }
}
