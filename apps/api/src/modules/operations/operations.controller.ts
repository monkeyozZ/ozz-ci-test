import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { OperationActor } from '@ozz/control-plane/tasks';
import { Problem } from '../../common/problem.js';
import {
  DiagnosticRequestDto,
  OperationEnvelopeDto,
  OperationListDto,
  OperationLogQueryDto,
  OperationLogsDto,
  OperationQueryDto,
  WorkerStatusEnvelopeDto,
} from './operation.dto.js';
import { OperationsService } from './operations.service.js';

interface AuthenticatedRequest {
  user?: { id: string };
  id?: string;
}

function actor(request: AuthenticatedRequest): OperationActor {
  if (!request.user) throw new Problem(401, 'AUTH_REQUIRED', '需要有效的管理员会话。');
  return { id: request.user.id, requestId: request.id };
}

@ApiTags('operations')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 409, description: '幂等冲突或任务状态不允许此操作' })
@ApiResponse({ status: 422, description: '任务参数或分页输入无效' })
@ApiResponse({ status: 429, description: '待执行任务已达到上限' })
@ApiResponse({ status: 503, description: '恢复核对期间只允许读取' })
@Controller('operations')
export class OperationsController {
  constructor(private readonly service: OperationsService) {}

  @Get()
  @ApiOperation({ operationId: 'listOperations' })
  @ApiOkResponse({ type: OperationListDto })
  list(@Query() query: OperationQueryDto) {
    return this.service.list(query);
  }

  @Get('worker-status')
  @ApiOperation({ operationId: 'getWorkerStatus' })
  @ApiOkResponse({ type: WorkerStatusEnvelopeDto })
  workerStatus() {
    return this.service.workerStatus();
  }

  @Post('diagnostics')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'createDiagnosticOperation',
    summary: '创建无远端副作用的持久队列诊断',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8–128字符；同一请求重试必须复用此值',
  })
  @ApiAcceptedResponse({
    type: OperationEnvelopeDto,
    description: '任务与 Outbox 已持久化；受理不代表执行成功',
  })
  create(
    @Body() input: DiagnosticRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.create(input, actor(request), key);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getOperation' })
  @ApiOkResponse({ type: OperationEnvelopeDto })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Get(':id/logs')
  @ApiOperation({ operationId: 'getOperationLogs' })
  @ApiOkResponse({ type: OperationLogsDto })
  logs(@Param('id') id: string, @Query() query: OperationLogQueryDto) {
    return this.service.logs(id, query);
  }

  @Post(':id/retry')
  @HttpCode(202)
  @ApiOperation({ operationId: 'retryOperation' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  retry(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.retry(id, actor(request), key);
  }

  @Post(':id/cancel')
  @HttpCode(202)
  @ApiOperation({ operationId: 'cancelOperation' })
  @ApiAcceptedResponse({
    type: OperationEnvelopeDto,
    description: '记录取消意图，运行中任务须等待 Worker 确认停止',
  })
  cancel(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.service.cancel(id, actor(request));
  }
}
