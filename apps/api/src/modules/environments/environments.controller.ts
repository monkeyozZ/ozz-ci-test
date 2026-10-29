import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DeleteRevisionDto, ResourceParamsDto } from '../projects/metadata.dto.js';
import {
  CreateEnvironmentDto,
  EnvironmentEnvelopeDto,
  EnvironmentListDto,
  EnvironmentQueryDto,
  UpdateEnvironmentDto,
} from './environment.dto.js';
import { EnvironmentsService } from './environments.service.js';

@ApiTags('environments')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 422, description: '输入校验失败，响应为 application/problem+json' })
@Controller('environments')
export class EnvironmentsController {
  constructor(private readonly service: EnvironmentsService) {}

  @Get()
  @ApiOperation({ operationId: 'listEnvironments' })
  @ApiOkResponse({ type: EnvironmentListDto })
  list(@Query() query: EnvironmentQueryDto): Promise<EnvironmentListDto> {
    return this.service.list(query);
  }

  @Post()
  @ApiOperation({ operationId: 'createEnvironment' })
  @ApiCreatedResponse({ type: EnvironmentEnvelopeDto })
  create(@Body() input: CreateEnvironmentDto): Promise<EnvironmentEnvelopeDto> {
    return this.service.create(input);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getEnvironment' })
  @ApiOkResponse({ type: EnvironmentEnvelopeDto })
  get(@Param() params: ResourceParamsDto): Promise<EnvironmentEnvelopeDto> {
    return this.service.get(params.id);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'updateEnvironment' })
  @ApiOkResponse({ type: EnvironmentEnvelopeDto })
  @ApiResponse({ status: 409, description: '资源 revision 已变化或当前状态不允许修改' })
  update(
    @Param() params: ResourceParamsDto,
    @Body() input: UpdateEnvironmentDto,
  ): Promise<EnvironmentEnvelopeDto> {
    return this.service.update(params.id, input);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'deleteEnvironment' })
  @ApiNoContentResponse()
  @ApiResponse({ status: 409, description: '资源仍被引用或受默认环境保护' })
  async delete(
    @Param() params: ResourceParamsDto,
    @Query() query: DeleteRevisionDto,
  ): Promise<void> {
    await this.service.delete(params.id, query.revision);
  }
}
