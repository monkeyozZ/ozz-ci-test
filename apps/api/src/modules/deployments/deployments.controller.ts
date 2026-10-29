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
import { ResourceParamsDto } from '../projects/metadata.dto.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';
import { OperationLogQueryDto } from '../operations/operation.dto.js';
import { DeployServiceDto } from '../services/service.dto.js';
import {
  DeploymentDetailEnvelopeDto,
  DeploymentEnvelopeDto,
  DeploymentListDto,
  DeploymentLogsDto,
  DeploymentQueryDto,
} from './deployment.dto.js';
import { DeploymentsService } from './deployments.service.js';
import { BuildLogPageDto, BuildLogQueryDto } from './build.dto.js';

@ApiTags('deployments')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 409, description: '任务或目标状态不允许当前操作' })
@Controller('deployments')
export class DeploymentsController {
  constructor(private readonly service: DeploymentsService) {}
  @Get()
  @ApiOperation({ operationId: 'listDeployments' })
  @ApiOkResponse({ type: DeploymentListDto })
  list(@Query() query: DeploymentQueryDto) {
    return this.service.list(query);
  }
  @Get(':id')
  @ApiOperation({ operationId: 'getDeployment' })
  @ApiOkResponse({ type: DeploymentDetailEnvelopeDto })
  get(@Param() params: ResourceParamsDto) {
    return this.service.get(params.id);
  }
  @Get(':id/logs')
  @ApiOperation({ operationId: 'getDeploymentLogs' })
  @ApiOkResponse({ type: DeploymentLogsDto })
  logs(@Param() params: ResourceParamsDto, @Query() query: OperationLogQueryDto) {
    return this.service.logs(params.id, query);
  }
  @Get(':id/build-logs')
  @ApiOperation({ operationId: 'getDeploymentBuildLogs' })
  @ApiOkResponse({ type: BuildLogPageDto })
  buildLogs(@Param() params: ResourceParamsDto, @Query() query: BuildLogQueryDto) {
    return this.service.buildLogs(params.id, query);
  }
  @Post(':id/cancel')
  @HttpCode(202)
  @ApiOperation({ operationId: 'cancelDeployment' })
  @ApiAcceptedResponse({ type: DeploymentEnvelopeDto })
  cancel(@Param() params: ResourceParamsDto, @Req() request: InfrastructureRequest) {
    return this.service.cancel(params.id, infrastructureActor(request));
  }
  @Post(':id/retry')
  @HttpCode(202)
  @ApiOperation({ operationId: 'retryDeployment' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: DeploymentEnvelopeDto })
  retry(
    @Param() params: ResourceParamsDto,
    @Body() input: DeployServiceDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.retry(params.id, input, infrastructureActor(request), key);
  }
}
