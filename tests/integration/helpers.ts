import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { createApp } from '../../apps/api/dist/app.js';
import type { PrismaClient } from '../../packages/database/dist/index.js';

export async function createTestSession(
  app: Awaited<ReturnType<typeof createApp>>,
  db: PrismaClient,
) {
  // Fixtures use an unguessable session; no default password is installed.
  let admin = await db.admin.findFirst();
  let ownsAdmin = false;
  if (!admin) {
    admin = await db.admin.create({
      data: {
        username: `test-${randomUUID().slice(0, 8)}`,
        passwordHash: 'test-fixture-login-disabled',
      },
    });
    ownsAdmin = true;
  }
  const token = randomBytes(32).toString('base64url');
  const session = await db.session.create({
    data: {
      adminId: admin.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const cookie = `ozz_session=${token}`;
  const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  if (response.statusCode !== 200)
    throw new Error(`Test session initialization failed: ${response.statusCode}`);
  const { data } = response.json<{ data: { csrfToken: string } }>();
  return {
    adminId: admin.id,
    sessionId: session.id,
    token,
    headers: { cookie, origin: process.env.APP_ORIGIN!, 'x-csrf-token': data.csrfToken },
    async cleanup() {
      await db.session.deleteMany({ where: { id: session.id } });
      if (ownsAdmin) {
        const references = await Promise.all([
          db.operation.count({ where: { createdById: admin.id } }),
          db.deployment.count({ where: { createdById: admin.id } }),
        ]);
        if (!references.some(Boolean)) await db.admin.delete({ where: { id: admin.id } });
      }
    },
  };
}
