import { createHash, randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaService } from '@ozz/database';
import { loadConfig } from '@ozz/config';
import { readRecoveryState } from '@ozz/control-plane/recovery';
import * as argon2 from 'argon2';
import { Problem } from '../common/problem';
import type { LoginDto } from './auth.dto';
import type { AuthUser } from './auth.types';

export const SESSION_COOKIE = 'ozz_session';
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const csrfForToken = (value: string) =>
  createHash('sha256').update(`ozz.csrf.v1:${value}`).digest('base64url');
export const PASSWORD_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly config = loadConfig();
  private dummyHash!: string;
  private verifyingPassword = false;

  constructor(private readonly db: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Complete the one startup hash before listening so it cannot overlap with
    // request verification or leave an unobserved rejection behind.
    this.dummyHash = await argon2.hash(randomBytes(32), PASSWORD_OPTIONS);
  }

  async login(input: LoginDto, ip: string, requestId: string, previousToken?: string) {
    const username = input.username.toLowerCase();
    await this.consumeLoginAttempt(`ip:${ip}`);
    await this.consumeLoginAttempt(`username:${username}`);
    const { admin, valid } = await this.checkPassword(username, input.password);
    if (!admin || !valid) {
      await this.db.auditEvent.create({
        data: {
          requestId,
          action: 'auth.login',
          resourceType: 'session',
          outcome: 'denied',
        },
      });
      throw new Problem(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
    const session = await this.db.$transaction(async (tx) => {
      if (previousToken) {
        await tx.session.updateMany({
          where: { tokenHash: hashToken(previousToken), revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      const created = await tx.session.create({
        data: { adminId: admin.id, tokenHash: hashToken(token), expiresAt },
      });
      await tx.auditEvent.create({
        data: {
          actorId: admin.id,
          requestId,
          action: 'auth.login',
          resourceType: 'session',
          resourceId: created.id,
          outcome: 'succeeded',
        },
      });
      return created;
    });
    return {
      token,
      sessionId: session.id,
      ...(await this.describe({ id: admin.id, username: admin.username }, token, expiresAt)),
    };
  }

  async authenticate(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Problem(401, 'UNAUTHENTICATED', '请先登录。');
    const session = await this.db.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { admin: { select: { id: true, username: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new Problem(401, 'SESSION_EXPIRED', '登录已失效，请重新登录。');
    }
    return {
      user: session.admin,
      sessionId: session.id,
      csrfToken: csrfForToken(token),
      sessionExpiresAt: session.expiresAt,
    };
  }

  async describe(user: AuthUser, token: string, expiresAt: Date) {
    const recovery = await readRecoveryState(this.db);
    return {
      data: {
        user,
        csrfToken: csrfForToken(token),
        expiresAt,
        restoreMode: recovery.restoreLocked || this.config.restoreMode,
      },
    };
  }

  async logout(sessionId: string, userId: string, requestId: string) {
    await this.db.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          actorId: userId,
          requestId,
          action: 'auth.logout',
          resourceType: 'session',
          resourceId: sessionId,
          outcome: 'succeeded',
        },
      });
    });
  }

  private async checkPassword(username: string, password: string) {
    // Each Argon2id operation reserves 64 MiB. A single administrator does not
    // need an unbounded CPU/memory queue; allow one check per API process and
    // reject excess work before looking up whether the username exists.
    if (this.verifyingPassword) {
      throw new Problem(503, 'AUTH_BUSY', '登录验证暂时繁忙，请稍后重试。');
    }
    this.verifyingPassword = true;
    try {
      const admin = await this.db.admin.findUnique({ where: { username } });
      let valid = false;
      try {
        valid = await argon2.verify(admin?.passwordHash ?? this.dummyHash, password);
      } catch {
        valid = false;
      }
      return { admin, valid };
    } finally {
      this.verifyingPassword = false;
    }
  }

  private async consumeLoginAttempt(scope: string) {
    const key = hashToken(scope);
    const [row] = await this.db.$queryRaw<{ attempts: number }[]>(Prisma.sql`
      INSERT INTO "LoginAttempt" ("key", "windowStart", "attempts", "updatedAt")
      VALUES (${key}, NOW(), 1, NOW())
      ON CONFLICT ("key") DO UPDATE SET
        "attempts" = CASE WHEN "LoginAttempt"."windowStart" < NOW() - INTERVAL '15 minutes' THEN 1 ELSE "LoginAttempt"."attempts" + 1 END,
        "windowStart" = CASE WHEN "LoginAttempt"."windowStart" < NOW() - INTERVAL '15 minutes' THEN NOW() ELSE "LoginAttempt"."windowStart" END,
        "updatedAt" = NOW()
      RETURNING "attempts"
    `);
    if (!row || row.attempts > 10)
      throw new Problem(429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请在 15 分钟后重试。');
  }
}
