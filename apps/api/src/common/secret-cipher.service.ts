import { Injectable, type OnModuleInit } from '@nestjs/common';
import { loadConfig } from '@ozz/config';
import { PrismaService } from '@ozz/database';
import { SecretCipher, readMasterKeys } from '@ozz/control-plane/secrets';

@Injectable()
export class SecretCipherService extends SecretCipher implements OnModuleInit {
  constructor(private readonly db: PrismaService) {
    super(readMasterKeys(loadConfig().masterKeyFile));
  }

  async onModuleInit(): Promise<void> {
    const checks = await this.db.keyVerification.findMany();
    for (const check of checks) {
      const value = this.decrypt({ ...check, kind: 'key-verification' });
      if (value.purpose !== 'ozz-key-verification-v1')
        throw new Error('Master key verification failed');
    }
    // Also verify retained credential versions, including restored pre-canary data.
    const versions = await this.db.secretReference.findMany({ distinct: ['keyVersion'] });
    for (const secret of versions) this.decrypt(secret);
    const check = this.encrypt('key-verification', { purpose: 'ozz-key-verification-v1' });
    if (!checks.some((c) => c.keyVersion === check.keyVersion)) {
      await this.db.keyVerification.upsert({
        where: { keyVersion: check.keyVersion },
        create: check,
        update: {},
      });
    }
  }
}
