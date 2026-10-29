import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { DatabasesService } from './databases.service.js';
import {
  DatabaseBindingCollectionDto,
  DatabaseBindingInputDto,
  DatabaseBindingParamsDto,
  DatabaseBindingPreviewEnvelopeDto,
  DatabaseEnvelopeDto,
  DatabaseListDto,
  DatabaseQueryDto,
  ServiceDeletionPreviewEnvelopeDto,
} from './database.dto.js';

@ApiTags('databases')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效管理员会话' })
@ApiResponse({ status: 409, description: '数据库身份、提供方就绪状态、活动任务或资源版本冲突' })
@ApiResponse({ status: 422, description: '连接映射、资源归属或分页参数无效' })
@ApiResponse({ status: 503, description: '恢复核对期间只允许读取' })
@Controller()
export class DatabasesController {
  constructor(private readonly service: DatabasesService) {}
  @Get('databases')
  @ApiOperation({ operationId: 'listDatabases' })
  @ApiOkResponse({ type: DatabaseListDto })
  list(@Query() query: DatabaseQueryDto) {
    return this.service.request((commands) => commands.list(query));
  }
  @Get('databases/:id')
  @ApiOperation({ operationId: 'getDatabase' })
  @ApiOkResponse({ type: DatabaseEnvelopeDto })
  get(@Param() params: ResourceParamsDto) {
    return this.service.request(async (commands) => ({ data: await commands.get(params.id) }));
  }
  @Get('services/:id/database')
  @ApiOperation({ operationId: 'getServiceDatabase' })
  @ApiOkResponse({ type: DatabaseEnvelopeDto })
  forService(@Param() params: ResourceParamsDto) {
    return this.service.request(async (commands) => ({
      data: await commands.forService(params.id),
    }));
  }
  @Get('services/:id/database-bindings')
  @ApiOperation({ operationId: 'getServiceDatabaseBindings' })
  @ApiOkResponse({ type: DatabaseBindingCollectionDto })
  bindings(@Param() params: ResourceParamsDto) {
    return this.service.request((commands) => commands.bindings(params.id));
  }
  @Post('services/:id/database-bindings/preview')
  @HttpCode(200)
  @ApiOperation({ operationId: 'previewServiceDatabaseBinding' })
  @ApiOkResponse({ type: DatabaseBindingPreviewEnvelopeDto })
  preview(@Param() params: ResourceParamsDto, @Body() input: DatabaseBindingInputDto) {
    return this.service.request(async (commands) => ({
      data: await commands.preview(params.id, input),
    }));
  }
  @Post('services/:id/database-bindings')
  @HttpCode(200)
  @ApiOperation({ operationId: 'saveServiceDatabaseBinding' })
  @ApiOkResponse({ type: DatabaseBindingCollectionDto })
  save(@Param() params: ResourceParamsDto, @Body() input: DatabaseBindingInputDto) {
    return this.service.request((commands) => commands.save(params.id, input));
  }
  @Delete('services/:id/database-bindings/:bindingId')
  @HttpCode(200)
  @ApiOperation({ operationId: 'deleteServiceDatabaseBinding' })
  @ApiOkResponse({ type: DatabaseBindingCollectionDto })
  remove(@Param() params: DatabaseBindingParamsDto, @Body() input: RevisionDto) {
    return this.service.request((commands) =>
      commands.remove(params.id, params.bindingId, input.revision),
    );
  }
  @Post('services/:id/deletion-preview')
  @HttpCode(200)
  @ApiOperation({ operationId: 'previewServiceDeletion' })
  @ApiOkResponse({ type: ServiceDeletionPreviewEnvelopeDto })
  deletionPreview(@Param() params: ResourceParamsDto, @Body() input: RevisionDto) {
    return this.service.request(async (commands) => ({
      data: await commands.deletionPreview(params.id, input.revision),
    }));
  }
}
