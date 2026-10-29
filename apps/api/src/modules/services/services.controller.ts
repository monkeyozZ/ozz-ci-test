import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../auth/auth.types.js';
import { ServiceLogsQueryDto } from './logs.dto.js';
import { ServiceLogsService } from './logs.service.js';
import { ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';
import { OperationEnvelopeDto } from '../operations/operation.dto.js';
import { DeploymentEnvelopeDto } from '../deployments/deployment.dto.js';
import { ServiceMetricsEnvelopeDto, ServicePodsEnvelopeDto } from './observation.dto.js';
import {
  CreateServiceDto,
  DeployServiceDto,
  EnvironmentImportEnvelopeDto,
  ParseEnvironmentDto,
  ServiceEnvelopeDto,
  ServiceListDto,
  ServiceQueryDto,
  UpdateServiceDto,
} from './service.dto.js';
import { ServicesService } from './services.service.js';

@ApiTags('services')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 409, description: '资源版本、固定目标或当前变更状态冲突' })
@ApiResponse({ status: 422, description: '配置或分页输入无效' })
@ApiResponse({ status: 503, description: '恢复核对期间只允许读取' })
@Controller('services')
export class ServicesController {
  constructor(
    private readonly service: ServicesService,
    private readonly logsService: ServiceLogsService,
  ) {}
  @Get()
  @ApiOperation({ operationId: 'listServices' })
  @ApiOkResponse({ type: ServiceListDto })
  list(@Query() query: ServiceQueryDto) {
    return this.service.list(query);
  }
  @Post()
  @ApiOperation({ operationId: 'createService' })
  @ApiHeader({
    name: 'idempotency-key',
    required: false,
    description: '模板创建必填；镜像和 Git 创建可使用同一键重试，重复请求返回原创建结果',
  })
  @ApiCreatedResponse({ type: ServiceEnvelopeDto })
  create(
    @Body() input: CreateServiceDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.create(input, infrastructureActor(request), key);
  }
  @Post('parse-env')
  @HttpCode(200)
  @ApiOperation({ operationId: 'parseServiceEnvironment' })
  @ApiOkResponse({ type: EnvironmentImportEnvelopeDto })
  parse(@Body() input: ParseEnvironmentDto): Promise<EnvironmentImportEnvelopeDto> {
    return this.service.parseEnvironment(input.text);
  }
  @Get(':id')
  @ApiOperation({ operationId: 'getService' })
  @ApiOkResponse({ type: ServiceEnvelopeDto })
  get(@Param() params: ResourceParamsDto) {
    return this.service.get(params.id);
  }
  @Patch(':id')
  @ApiOperation({ operationId: 'updateService' })
  @ApiOkResponse({ type: ServiceEnvelopeDto })
  update(@Param() params: ResourceParamsDto, @Body() input: UpdateServiceDto) {
    return this.service.update(params.id, input);
  }
  @Post(':id/deployments')
  @HttpCode(202)
  @ApiOperation({ operationId: 'deployService' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: DeploymentEnvelopeDto })
  deploy(
    @Param() params: ResourceParamsDto,
    @Body() input: DeployServiceDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.deploy(params.id, input, infrastructureActor(request), key);
  }
  @Post(':id/restart')
  @HttpCode(202)
  @ApiOperation({ operationId: 'restartService' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  restart(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.action(params.id, 'restart', input, infrastructureActor(request), key);
  }
  @Post(':id/stop')
  @HttpCode(202)
  @ApiOperation({ operationId: 'stopService' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  stop(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.action(params.id, 'stop', input, infrastructureActor(request), key);
  }
  @Post(':id/resume')
  @HttpCode(202)
  @ApiOperation({ operationId: 'resumeService' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  resume(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.action(params.id, 'resume', input, infrastructureActor(request), key);
  }
  @Delete(':id')
  @HttpCode(202)
  @ApiOperation({ operationId: 'deleteService' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  delete(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.action(params.id, 'delete', input, infrastructureActor(request), key);
  }
  @Get(':id/pods')
  @ApiOperation({ operationId: 'getServicePods' })
  @ApiOkResponse({ type: ServicePodsEnvelopeDto })
  pods(@Param() params: ResourceParamsDto) {
    return this.service.pods(params.id);
  }
  @Get(':id/metrics')
  @ApiOperation({ operationId: 'getServiceMetrics' })
  @ApiOkResponse({ type: ServiceMetricsEnvelopeDto })
  metrics(@Param() params: ResourceParamsDto) {
    return this.service.metrics(params.id);
  }
  @Get(':id/logs')
  @ApiOperation({
    operationId: 'getServiceLogs',
    description:
      '有界 SSE：log 事件含 {text}，end 事件含 {reason,message}；1 MiB / 60 秒，断开关闭上游。',
  })
  @ApiOkResponse({ content: { 'text/event-stream': { schema: { type: 'string' } } } })
  @ApiResponse({ status: 429, description: '当前账号已有 4 个日志连接' })
  logs(
    @Param() params: ResourceParamsDto,
    @Query() query: ServiceLogsQueryDto,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.logsService.stream(params.id, query, request, reply);
  }
}
