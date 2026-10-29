import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TemplatesService } from './templates.service.js';
import {
  TemplateEnvelopeDto,
  TemplateListDto,
  TemplateParamsDto,
  TemplatePreviewEnvelopeDto,
  TemplatePreviewInputDto,
  TemplateQueryDto,
  TemplateVersionQueryDto,
} from './template.dto.js';

@ApiTags('templates')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效管理员会话' })
@ApiResponse({ status: 404, description: '固定模板版本或环境不存在' })
@ApiResponse({ status: 422, description: '模板参数、固定归属或分页输入无效' })
@ApiResponse({ status: 503, description: '恢复核对期间只允许读取' })
@Controller('templates')
export class TemplatesController {
  constructor(private readonly service: TemplatesService) {}
  @Get()
  @ApiOperation({ operationId: 'listTemplates' })
  @ApiOkResponse({ type: TemplateListDto })
  list(@Query() query: TemplateQueryDto) {
    return this.service.list(query);
  }
  @Get(':id')
  @ApiOperation({ operationId: 'getTemplate' })
  @ApiOkResponse({ type: TemplateEnvelopeDto })
  get(@Param() params: TemplateParamsDto, @Query() query: TemplateVersionQueryDto) {
    return this.service.get(params.id, query.version);
  }
  @Post(':id/preview')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'previewTemplate',
    description: '只读生成配置预览，不分配服务、卷或凭证身份。',
  })
  @ApiOkResponse({ type: TemplatePreviewEnvelopeDto })
  preview(@Param() params: TemplateParamsDto, @Body() input: TemplatePreviewInputDto) {
    return this.service.preview(params.id, input);
  }
}
