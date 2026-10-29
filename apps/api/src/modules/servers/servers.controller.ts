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
  ApiCookieAuth,
  ApiAcceptedResponse,
  ApiHeader,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PageQueryDto } from '../../common/pagination.js';
import { DeleteRevisionDto, ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { InfrastructureService } from '../infrastructure/infrastructure.service.js';
import { InitializeServerDto, TrustHostKeyDto } from '../infrastructure/request.dto.js';
import { NodeListDto } from '../infrastructure/observation.dto.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';
import { OperationEnvelopeDto } from '../operations/operation.dto.js';
import {
  CreateServerDto,
  ServerEnvelopeDto,
  ServerListDto,
  UpdateServerDto,
} from './server.dto.js';
import { ServersService } from './servers.service.js';

@ApiTags('servers')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 422, description: '输入校验失败，响应为 application/problem+json' })
@Controller('servers')
export class ServersController {
  constructor(
    private readonly service: ServersService,
    private readonly infrastructure: InfrastructureService,
  ) {}

  @Post(':id/discover-host-key')
  @HttpCode(202)
  @ApiOperation({ operationId: 'discoverServerHostKey' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  discover(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: InfrastructureRequest,
  ) {
    return this.infrastructure.request(async (commands) => ({
      data: await commands.serverOperation(
        'ssh_discover',
        params.id,
        input.revision,
        infrastructureActor(request),
        key,
      ),
    }));
  }

  @Post(':id/trust-host-key')
  @HttpCode(200)
  @ApiOperation({ operationId: 'trustServerHostKey' })
  @ApiOkResponse({ type: ServerEnvelopeDto })
  async trust(
    @Param() params: ResourceParamsDto,
    @Body() input: TrustHostKeyDto,
    @Req() request: InfrastructureRequest,
  ) {
    await this.infrastructure.request((commands) =>
      commands.trustHostKey(params.id, input, infrastructureActor(request)),
    );
    return this.service.get(params.id);
  }

  @Post(':id/preflight')
  @HttpCode(202)
  @ApiOperation({ operationId: 'preflightServer' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  preflight(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: InfrastructureRequest,
  ) {
    return this.infrastructure.request(async (commands) => ({
      data: await commands.serverOperation(
        'server_preflight',
        params.id,
        input.revision,
        infrastructureActor(request),
        key,
      ),
    }));
  }

  @Post(':id/initialize')
  @HttpCode(202)
  @ApiOperation({ operationId: 'initializeServer' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  initialize(
    @Param() params: ResourceParamsDto,
    @Body() input: InitializeServerDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: InfrastructureRequest,
  ) {
    return this.infrastructure.request(async (commands) => ({
      data: await commands.initialize(params.id, input, infrastructureActor(request), key),
    }));
  }

  @Get(':id/nodes')
  @ApiOperation({ operationId: 'listServerNodes' })
  @ApiOkResponse({ type: NodeListDto })
  nodes(@Param() params: ResourceParamsDto, @Query() query: PageQueryDto) {
    return this.infrastructure.nodes({ serverId: params.id }, query);
  }

  @Get()
  @ApiOperation({ operationId: 'listServers' })
  @ApiOkResponse({ type: ServerListDto })
  list(@Query() query: PageQueryDto): Promise<ServerListDto> {
    return this.service.list(query);
  }

  @Post()
  @ApiOperation({ operationId: 'createServer' })
  @ApiCreatedResponse({ type: ServerEnvelopeDto })
  create(@Body() input: CreateServerDto): Promise<ServerEnvelopeDto> {
    return this.service.create(input);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getServer' })
  @ApiOkResponse({ type: ServerEnvelopeDto })
  get(@Param() params: ResourceParamsDto): Promise<ServerEnvelopeDto> {
    return this.service.get(params.id);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'updateServer' })
  @ApiOkResponse({ type: ServerEnvelopeDto })
  @ApiResponse({ status: 409, description: '资源 revision 已变化或当前状态不允许修改' })
  update(
    @Param() params: ResourceParamsDto,
    @Body() input: UpdateServerDto,
  ): Promise<ServerEnvelopeDto> {
    return this.service.update(params.id, input);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'deleteServer' })
  @ApiNoContentResponse()
  @ApiResponse({ status: 409, description: '资源仍被引用或受默认环境保护' })
  async delete(
    @Param() params: ResourceParamsDto,
    @Query() query: DeleteRevisionDto,
  ): Promise<void> {
    await this.service.delete(params.id, query.revision);
  }
}
