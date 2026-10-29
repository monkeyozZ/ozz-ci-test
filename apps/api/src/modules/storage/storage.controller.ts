import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
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
import { ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';
import { OperationEnvelopeDto } from '../operations/operation.dto.js';
import {
  ClusterStorageEnvelopeDto,
  CreateManualDataRecordDto,
  CreateVolumeDto,
  DestroyVolumeDto,
  EnterVolumeMaintenanceDto,
  ExitVolumeMaintenanceDto,
  ManualDataRecordEnvelopeDto,
  ManualDataRecordListDto,
  ManualDataRecordQueryDto,
  SaveVolumeMountDto,
  VolumeCreationEnvelopeDto,
  VolumeDeletionPreviewEnvelopeDto,
  VolumeEnvelopeDto,
  VolumeListDto,
  VolumeMountCollectionDto,
  VolumeMountParamsDto,
  VolumeQueryDto,
} from './storage.dto.js';
import { StorageService } from './storage.service.js';

@ApiTags('storage')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效管理员会话' })
@ApiResponse({ status: 409, description: '固定目标、数据身份、挂载占用、维护状态或版本冲突' })
@ApiResponse({ status: 422, description: '存储输入或分页参数无效' })
@ApiResponse({ status: 503, description: '恢复核对期间只允许读取' })
@Controller()
export class StorageController {
  constructor(private readonly service: StorageService) {}
  @Get('clusters/:id/storage')
  @ApiOperation({ operationId: 'getClusterStorage' })
  @ApiOkResponse({ type: ClusterStorageEnvelopeDto })
  cluster(@Param() params: ResourceParamsDto) {
    return this.service.request(async (commands) => ({
      data: await commands.clusterStorage(params.id),
    }));
  }
  @Get('volumes')
  @ApiOperation({ operationId: 'listVolumes' })
  @ApiOkResponse({ type: VolumeListDto })
  list(@Query() query: VolumeQueryDto) {
    return this.service.request((commands) => commands.list(query));
  }
  @Get('volumes/:id')
  @ApiOperation({ operationId: 'getVolume' })
  @ApiOkResponse({ type: VolumeEnvelopeDto })
  get(@Param() params: ResourceParamsDto) {
    return this.service.request(async (commands) => ({ data: await commands.get(params.id) }));
  }
  @Post('volumes')
  @HttpCode(202)
  @ApiOperation({ operationId: 'createVolume' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: VolumeCreationEnvelopeDto })
  create(
    @Body() input: CreateVolumeDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.create(input, infrastructureActor(request), key),
    }));
  }
  @Post('volumes/:id/sync')
  @HttpCode(202)
  @ApiOperation({ operationId: 'syncVolume' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  sync(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(
        params.id,
        'volume_sync',
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Post('volumes/:id/deletion-preview')
  @HttpCode(200)
  @ApiOperation({ operationId: 'previewVolumeDeletion' })
  @ApiOkResponse({ type: VolumeDeletionPreviewEnvelopeDto })
  preview(@Param() params: ResourceParamsDto, @Body() input: RevisionDto) {
    return this.service.request(async (commands) => ({
      data: await commands.deletionPreview(params.id, input),
    }));
  }
  @Delete('volumes/:id')
  @HttpCode(202)
  @ApiOperation({ operationId: 'destroyVolume' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  destroy(
    @Param() params: ResourceParamsDto,
    @Body() input: DestroyVolumeDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(
        params.id,
        'volume_destroy',
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Post('volumes/:id/maintenance/enter')
  @HttpCode(202)
  @ApiOperation({ operationId: 'enterVolumeMaintenance' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  enter(
    @Param() params: ResourceParamsDto,
    @Body() input: EnterVolumeMaintenanceDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(
        params.id,
        'volume_maintenance_enter',
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Post('volumes/:id/maintenance/exit')
  @HttpCode(202)
  @ApiOperation({ operationId: 'exitVolumeMaintenance' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  exit(
    @Param() params: ResourceParamsDto,
    @Body() input: ExitVolumeMaintenanceDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.action(
        params.id,
        'volume_maintenance_exit',
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Get('services/:id/volume-mounts')
  @ApiOperation({ operationId: 'getServiceVolumeMounts' })
  @ApiOkResponse({ type: VolumeMountCollectionDto })
  mounts(@Param() params: ResourceParamsDto) {
    return this.service.request((commands) => commands.mounts(params.id));
  }
  @Post('services/:id/volume-mounts')
  @HttpCode(200)
  @ApiOperation({ operationId: 'saveServiceVolumeMount' })
  @ApiOkResponse({ type: VolumeMountCollectionDto })
  mount(@Param() params: ResourceParamsDto, @Body() input: SaveVolumeMountDto) {
    return this.service.request((commands) => commands.saveMount(params.id, input));
  }
  @Delete('services/:id/volume-mounts/:mountId')
  @HttpCode(200)
  @ApiOperation({ operationId: 'deleteServiceVolumeMount' })
  @ApiOkResponse({ type: VolumeMountCollectionDto })
  unmount(@Param() params: VolumeMountParamsDto, @Body() input: RevisionDto) {
    return this.service.request((commands) =>
      commands.removeMount(params.id, params.mountId, input),
    );
  }
  @Get('volumes/:id/manual-data-records')
  @ApiOperation({ operationId: 'listManualDataRecords' })
  @ApiOkResponse({ type: ManualDataRecordListDto })
  records(@Param() params: ResourceParamsDto, @Query() query: ManualDataRecordQueryDto) {
    return this.service.request((commands) => commands.manualRecords(params.id, query));
  }
  @Post('volumes/:id/manual-data-records')
  @HttpCode(201)
  @ApiOperation({ operationId: 'createManualDataRecord' })
  @ApiCreatedResponse({ type: ManualDataRecordEnvelopeDto })
  record(
    @Param() params: ResourceParamsDto,
    @Body() input: CreateManualDataRecordDto,
    @Req() request: InfrastructureRequest,
  ) {
    return this.service.request(async (commands) => ({
      data: await commands.createManualRecord(params.id, input, infrastructureActor(request)),
    }));
  }
}
