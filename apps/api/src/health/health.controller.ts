import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@ozz/database';
import { loadConfig } from '@ozz/config';
import { readRecoveryState } from '@ozz/control-plane/recovery';
import { Public } from '../auth/public.decorator';
import { Problem } from '../common/problem';

@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}

  @Get('live')
  @ApiOperation({ operationId: 'getLiveness' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ operationId: 'getReadiness' })
  async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      const state = await readRecoveryState(this.db);
      const worker = await this.db.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: 'desc' } });
      const connected =
        worker && worker.lastSeenAt.getTime() > Date.now() - 30000 && worker.queueConnected;
      return {
        status: 'ready',
        mode: state.restoreLocked || loadConfig().restoreMode ? 'read_only' : 'read_write',
        queue: connected ? 'ready' : 'degraded',
      };
    } catch {
      throw new Problem(503, 'DATABASE_UNAVAILABLE', '持久化服务暂不可用。');
    }
  }
}
