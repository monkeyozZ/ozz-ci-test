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
import { ConnectClusterDto, ConnectionPreviewRequestDto } from '../infrastructure/request.dto.js';
import { ConnectionPreviewEnvelopeDto, NodeListDto } from '../infrastructure/observation.dto.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';
import { OperationEnvelopeDto } from '../operations/operation.dto.js';
import {
  CreateClusterDto,
  ClusterEnvelopeDto,
  ClusterListDto,
  UpdateClusterDto,
} from './cluster.dto.js';
import { ClustersService } from './clusters.service.js';

@ApiTags('clusters')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 422, description: '输入校验失败，响应为 application/problem+json' })
@Controller('clusters')
export class ClustersController {
  constructor(
    private readonly service: ClustersService,
    private readonly infrastructure: InfrastructureService,
  ) {}

  @Post(':id/connection-preview')
  @HttpCode(200)
  @ApiOperation({ operationId: 'previewClusterConnection' })
  @ApiOkResponse({ type: ConnectionPreviewEnvelopeDto })
  preview(@Param() params: ResourceParamsDto, @Body() input: ConnectionPreviewRequestDto) {
    return this.infrastructure.request(async (commands) => ({
      data: await commands.previewConnection(params.id, input),
    }));
  }

  @Post(':id/connect')
  @HttpCode(202)
  @ApiOperation({ operationId: 'connectCluster' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  connect(
    @Param() params: ResourceParamsDto,
    @Body() input: ConnectClusterDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: InfrastructureRequest,
  ) {
    return this.infrastructure.request(async (commands) => ({
      data: await commands.connect(params.id, input, infrastructureActor(request), key),
    }));
  }

  @Post(':id/sync')
  @HttpCode(202)
  @ApiOperation({ operationId: 'synchronizeCluster' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  sync(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: InfrastructureRequest,
  ) {
    return this.infrastructure.request(async (commands) => ({
      data: await commands.synchronize(
        params.id,
        input.revision,
        infrastructureActor(request),
        key,
      ),
    }));
  }

  @Get(':id/nodes')
  @ApiOperation({ operationId: 'listClusterNodes' })
  @ApiOkResponse({ type: NodeListDto })
  nodes(@Param() params: ResourceParamsDto, @Query() query: PageQueryDto) {
    return this.infrastructure.nodes({ clusterId: params.id }, query);
  }

  @Get()
  @ApiOperation({ operationId: 'listClusters' })
  @ApiOkResponse({ type: ClusterListDto })
  list(@Query() query: PageQueryDto): Promise<ClusterListDto> {
    return this.service.list(query);
  }

  @Post()
  @ApiOperation({ operationId: 'createCluster' })
  @ApiCreatedResponse({ type: ClusterEnvelopeDto })
  create(@Body() input: CreateClusterDto): Promise<ClusterEnvelopeDto> {
    return this.service.create(input);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getCluster' })
  @ApiOkResponse({ type: ClusterEnvelopeDto })
  get(@Param() params: ResourceParamsDto): Promise<ClusterEnvelopeDto> {
    return this.service.get(params.id);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'updateCluster' })
  @ApiOkResponse({ type: ClusterEnvelopeDto })
  @ApiResponse({ status: 409, description: '资源 revision 已变化或当前状态不允许修改' })
  update(
    @Param() params: ResourceParamsDto,
    @Body() input: UpdateClusterDto,
  ): Promise<ClusterEnvelopeDto> {
    return this.service.update(params.id, input);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'deleteCluster' })
  @ApiNoContentResponse()
  @ApiResponse({ status: 409, description: '资源仍被引用或受默认环境保护' })
  async delete(
    @Param() params: ResourceParamsDto,
    @Query() query: DeleteRevisionDto,
  ): Promise<void> {
    await this.service.delete(params.id, query.revision);
  }
}
