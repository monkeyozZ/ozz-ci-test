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
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DeleteRevisionDto, ResourceParamsDto } from './metadata.dto.js';
import {
  CreateProjectDto,
  ProjectEnvelopeDto,
  ProjectListDto,
  ProjectQueryDto,
  UpdateProjectDto,
} from './project.dto.js';
import { ProjectsService } from './projects.service.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';

@ApiTags('projects')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 422, description: '输入校验失败，响应为 application/problem+json' })
@Controller('projects')
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Get()
  @ApiOperation({ operationId: 'listProjects' })
  @ApiOkResponse({ type: ProjectListDto })
  list(@Query() query: ProjectQueryDto): Promise<ProjectListDto> {
    return this.service.list(query);
  }

  @Post()
  @ApiOperation({ operationId: 'createProject' })
  @ApiHeader({
    name: 'idempotency-key',
    required: false,
    description: '重试同一份创建请求时保留此键，返回原项目和默认环境的创建结果',
  })
  @ApiCreatedResponse({ type: ProjectEnvelopeDto })
  @ApiResponse({ status: 409, description: '标识已被使用或幂等键对应另一份创建请求' })
  create(
    @Body() input: CreateProjectDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ): Promise<ProjectEnvelopeDto> {
    return this.service.create(input, infrastructureActor(request), key);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getProject' })
  @ApiOkResponse({ type: ProjectEnvelopeDto })
  get(@Param() params: ResourceParamsDto): Promise<ProjectEnvelopeDto> {
    return this.service.get(params.id);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'updateProject' })
  @ApiOkResponse({ type: ProjectEnvelopeDto })
  @ApiResponse({ status: 409, description: '资源 revision 已变化或当前状态不允许修改' })
  update(
    @Param() params: ResourceParamsDto,
    @Body() input: UpdateProjectDto,
  ): Promise<ProjectEnvelopeDto> {
    return this.service.update(params.id, input);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'deleteProject' })
  @ApiNoContentResponse()
  @ApiResponse({ status: 409, description: '资源仍被引用或受默认环境保护' })
  async delete(
    @Param() params: ResourceParamsDto,
    @Query() query: DeleteRevisionDto,
  ): Promise<void> {
    await this.service.delete(params.id, query.revision);
  }
}
