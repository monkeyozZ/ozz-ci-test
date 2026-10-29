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
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';
import { OperationEnvelopeDto } from '../operations/operation.dto.js';
import {
  ClusterNetworkingEnvelopeDto,
  CreateDomainDto,
  DomainEnvelopeDto,
  DomainListDto,
  DomainQueryDto,
  InitialNetworkingRevisionDto,
  PlatformSettingsEnvelopeDto,
  ServiceNetworkingEnvelopeDto,
  UpdateClusterNetworkingDto,
  UpdatePlatformSettingsDto,
} from './networking.dto.js';
import { NetworkingService } from './networking.service.js';

@ApiTags('networking')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效管理员会话' })
@ApiResponse({ status: 409, description: '版本、固定目标、绑定或任务状态冲突' })
@ApiResponse({ status: 422, description: '域名、端口、入口或分页输入无效' })
@ApiResponse({ status: 503, description: '恢复核对期间只允许读取' })
@Controller()
export class NetworkingController {
  constructor(private readonly service: NetworkingService) {}
  @Get('platform-settings')
  @ApiOperation({ operationId: 'getPlatformSettings' })
  @ApiOkResponse({ type: PlatformSettingsEnvelopeDto })
  settings() {
    return this.service.request(async (commands) => ({ data: await commands.platformSettings() }));
  }
  @Patch('platform-settings')
  @ApiOperation({ operationId: 'updatePlatformSettings' })
  @ApiOkResponse({ type: PlatformSettingsEnvelopeDto })
  updateSettings(@Body() input: UpdatePlatformSettingsDto) {
    return this.service.request(async (commands) => ({
      data: await commands.updatePlatformSettings(input),
    }));
  }
  @Get('clusters/:id/networking')
  @ApiOperation({ operationId: 'getClusterNetworking' })
  @ApiOkResponse({ type: ClusterNetworkingEnvelopeDto })
  cluster(@Param() params: ResourceParamsDto) {
    return this.service.request(async (commands) => ({
      data: await commands.clusterNetworking(params.id),
    }));
  }
  @Patch('clusters/:id/networking')
  @ApiOperation({ operationId: 'updateClusterNetworking' })
  @ApiOkResponse({ type: ClusterNetworkingEnvelopeDto })
  updateCluster(@Param() params: ResourceParamsDto, @Body() input: UpdateClusterNetworkingDto) {
    return this.service.request(async (commands) => ({
      data: await commands.updateClusterNetworking(params.id, input),
    }));
  }
  @Post('clusters/:id/networking/check')
  @HttpCode(202)
  @ApiOperation({ operationId: 'checkClusterNetworking' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  checkCluster(
    @Param() params: ResourceParamsDto,
    @Body() input: InitialNetworkingRevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.clusterAction(
        params.id,
        'cluster_network_check',
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Post('clusters/:id/networking/install-cert-manager')
  @HttpCode(202)
  @ApiOperation({ operationId: 'installClusterCertManager' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  install(
    @Param() params: ResourceParamsDto,
    @Body() input: InitialNetworkingRevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.clusterAction(
        params.id,
        'cluster_cert_manager_install',
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Get('services/:id/networking')
  @ApiOperation({ operationId: 'getServiceNetworking' })
  @ApiOkResponse({ type: ServiceNetworkingEnvelopeDto })
  serviceContext(@Param() params: ResourceParamsDto) {
    return this.service.request(async (commands) => ({
      data: await commands.serviceNetworking(params.id),
    }));
  }
  @Post('services/:id/domains')
  @HttpCode(202)
  @ApiOperation({ operationId: 'bindServiceDefaultDomain' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  bind(
    @Param() params: ResourceParamsDto,
    @Body() input: CreateDomainDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.bind(params.id, input, infrastructureActor(request), key),
    }));
  }
  @Get('domains')
  @ApiOperation({ operationId: 'listDomains' })
  @ApiOkResponse({ type: DomainListDto })
  list(@Query() query: DomainQueryDto) {
    return this.service.request((commands) => commands.list(query));
  }
  @Get('domains/:id')
  @ApiOperation({ operationId: 'getDomain' })
  @ApiOkResponse({ type: DomainEnvelopeDto })
  get(@Param() params: ResourceParamsDto) {
    return this.service.request(async (commands) => ({ data: await commands.get(params.id) }));
  }
  @Post('domains/:id/sync')
  @HttpCode(202)
  @ApiOperation({ operationId: 'syncDomain' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  sync(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(params.id, 'sync', input, infrastructureActor(request), key),
    }));
  }
  @Post('domains/:id/production')
  @HttpCode(202)
  @ApiOperation({ operationId: 'promoteDomainCertificate' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  production(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(
        params.id,
        'production',
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Post('domains/:id/reconcile')
  @HttpCode(202)
  @ApiOperation({ operationId: 'reconcileDomain' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  reconcile(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(params.id, 'reconcile', input, infrastructureActor(request), key),
    }));
  }
  @Delete('domains/:id')
  @HttpCode(202)
  @ApiOperation({ operationId: 'unbindDomain' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  unbind(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(params.id, 'unbind', input, infrastructureActor(request), key),
    }));
  }
}
