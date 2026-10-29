import 'reflect-metadata';
import { constants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '@ozz/database';
import { loadConfig } from '@ozz/config';
import { SecretCipher, readMasterKeys } from '@ozz/control-plane/secrets';
import {
  BuildRecovery,
  BuildRecoveryBlocked,
  BUILD_RECOVERY_MANIFEST_MAX_BYTES,
  BUILD_RECOVERY_TRANSACTION_TIMEOUT_MS,
} from '@ozz/control-plane/builds';
import { TaskRepository } from '@ozz/control-plane/tasks';
import * as argon2 from 'argon2';
import { PASSWORD_OPTIONS } from './auth/auth.service';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const config = loadConfig();
  const db = new PrismaClient();
  await db.$connect();
  try {
    if (command === 'admin:init') {
      const username = option('--username')?.toLowerCase();
      const passwordFile = option('--password-file');
      if (!username || !/^[a-z0-9._-]{3,64}$/.test(username) || !passwordFile) {
        throw new Error(
          'Usage: pnpm admin:init --username <name> --password-file <protected-file>',
        );
      }
      const file = resolve(passwordFile);
      const info = await stat(file);
      if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0)
        throw new Error('Password file must be a small regular file with permissions 0600');
      const password = (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
      if (password.length < 12 || password.length > 256)
        throw new Error('Password must contain 12–256 characters');
      if (await db.admin.count())
        throw new Error('Administrator is already initialized; no account was overwritten');
      const passwordHash = await argon2.hash(password, PASSWORD_OPTIONS);
      await db.admin.create({ data: { username, passwordHash } });
      console.log(
        `Administrator ${username} initialized. Keep the password file private or remove it after storing the password in your password manager.`,
      );
    } else if (
      command &&
      ['recovery:lock', 'recovery:unlock', 'recovery:inspect', 'recovery:accept'].includes(command)
    ) {
      const lock = command === 'recovery:lock';
      if (command === 'recovery:unlock' && !args.includes('--reconciled'))
        throw new Error(
          'Unlock requires --reconciled after checking the restored database, matching master key and independently retained Builder deployment inventory, including instances absent from this backup. See docs/control-plane-recovery.md.',
        );
      const cipher = new SecretCipher(readMasterKeys(config.masterKeyFile));
      for (const item of await db.keyVerification.findMany())
        cipher.decrypt({ ...item, kind: 'key-verification' });
      for (const item of await db.secretReference.findMany({ distinct: ['keyVersion'] }))
        cipher.decrypt(item);
      const builds = lock ? null : new BuildRecovery(new TaskRepository(db), cipher);
      if (command === 'recovery:inspect') {
        const output = option('--output');
        if (!output || args.length !== 2 || args[0] !== '--output')
          throw new Error('Usage: recovery:inspect --output <new-private-manifest.json>');
        const manifest = await builds!.inspect();
        const content = JSON.stringify(manifest, null, 2) + '\n';
        if (Buffer.byteLength(content) > BUILD_RECOVERY_MANIFEST_MAX_BYTES)
          throw new Error('Recovery manifest exceeds the 16 MiB file limit');
        const file = await open(resolve(output), 'wx', 0o600);
        try {
          await file.writeFile(content);
          await file.sync();
        } finally {
          await file.close();
        }
        console.log(
          JSON.stringify({
            manifestId: manifest.id,
            output: resolve(output),
            unknownRuns: manifest.unknownRuns.length,
            generation: manifest.scope.generation,
            restoreLocked: true,
            readOnly: true,
          }),
        );
        return;
      }
      if (command === 'recovery:accept') {
        const path = option('--manifest');
        if (
          !path ||
          args.length !== 3 ||
          args[0] !== '--manifest' ||
          args[2] !== '--acknowledge-missing-history'
        )
          throw new Error(
            'Usage: recovery:accept --manifest <reviewed-private-manifest.json> --acknowledge-missing-history',
          );
        const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
        let raw: unknown;
        try {
          const info = await file.stat();
          if (
            !info.isFile() ||
            info.size > BUILD_RECOVERY_MANIFEST_MAX_BYTES ||
            (info.mode & 0o077) !== 0
          )
            throw new Error(
              'Recovery manifest must be a regular file no larger than 16 MiB with permissions 0600',
            );
          try {
            raw = JSON.parse(await file.readFile('utf8'));
          } catch {
            throw new Error('Recovery manifest is not valid JSON');
          }
        } finally {
          await file.close();
        }
        const accepted = await builds!.accept(raw, { acknowledgeMissingHistory: true });
        console.log(
          JSON.stringify({ ...accepted, restoreLocked: true, historyMetadataRestored: false }),
        );
        return;
      }
      const plan = builds ? await builds.prepare() : null;
      await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "ControlPlaneState" WHERE "id" = 'control-plane' FOR UPDATE`;
          const state = await tx.controlPlaneState.findUniqueOrThrow({
            where: { id: 'control-plane' },
          });
          let generation = state.generation;
          if (builds && plan) {
            await builds.verifyUnchanged(plan);
            generation = (await builds.apply(tx, plan)).generation;
          } else if (lock && !state.restoreLocked) generation++;
          const updated = await tx.controlPlaneState.update({
            where: { id: state.id },
            data: {
              restoreLocked: lock,
              generation,
            },
          });
          await tx.auditEvent.create({
            data: {
              action: command,
              resourceType: 'control-plane',
              resourceId: 'control-plane',
              outcome: 'succeeded',
              metadata: {
                generation,
                ...(lock ? { lockedAt: updated.updatedAt.toISOString() } : {}),
                ...(plan
                  ? {
                      builderInventoryVerified: true,
                      ...(plan.historyAcceptanceId
                        ? {
                            historyAcceptanceId: plan.historyAcceptanceId,
                            acceptedUnknownRunCount: plan.acceptedUnknownRunCount,
                          }
                        : {}),
                    }
                  : {}),
              },
            },
          });
        },
        { timeout: BUILD_RECOVERY_TRANSACTION_TIMEOUT_MS },
      );
      console.log(
        lock
          ? 'Recovery lock enabled. Mutations and dispatch are paused.'
          : 'Recovery lock released. Old generation tasks remain fenced. RESTORE_MODE must also be false before writes resume.',
      );
    } else
      throw new Error(
        'Unknown command. Use admin:init, recovery:lock, recovery:inspect, recovery:accept, or recovery:unlock.',
      );
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof BuildRecoveryBlocked) {
    console.error(
      JSON.stringify({
        code: error.code,
        message: error.message,
        issues: error.issues.slice(0, 50),
        omittedIssues: Math.max(0, error.issues.length - 50),
      }),
    );
    process.exitCode = 1;
    return;
  }
  // Only intentionally bounded operator errors are displayed; driver details may contain a DSN.
  const known = error instanceof Error && !error.name.startsWith('Prisma');
  console.error(
    known ? error.message : 'Database operation failed. Verify local configuration and migrations.',
  );
  process.exitCode = 1;
});
