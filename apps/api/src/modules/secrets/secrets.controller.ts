import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
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
import { CreateSecretDto, SecretEnvelopeDto, SecretListDto, SecretQueryDto } from './secret.dto.js';
import { SecretsService } from './secrets.service.js';

@ApiTags('secrets')
@ApiCookieAuth()
@ApiResponse({ status: 401, description: '需要有效的管理员会话' })
@ApiResponse({ status: 422, description: '输入校验失败，响应为 application/problem+json' })
@Controller('secrets')
export class SecretsController {
  constructor(private readonly service: SecretsService) {}

  @Get()
  @ApiOperation({ operationId: 'listSecrets' })
  @ApiOkResponse({ type: SecretListDto })
  list(@Query() query: SecretQueryDto): Promise<SecretListDto> {
    return this.service.list(query);
  }

  @Post()
  @ApiOperation({ operationId: 'createSecret' })
  @ApiCreatedResponse({ type: SecretEnvelopeDto })
  create(@Body() input: CreateSecretDto): Promise<SecretEnvelopeDto> {
    return this.service.create(input);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getSecret' })
  @ApiOkResponse({ type: SecretEnvelopeDto })
  get(@Param() params: ResourceParamsDto): Promise<SecretEnvelopeDto> {
    return this.service.get(params.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'deleteSecret' })
  @ApiNoContentResponse()
  @ApiResponse({ status: 409, description: '资源仍被引用或受默认环境保护' })
  async delete(
    @Param() params: ResourceParamsDto,
    @Query() query: DeleteRevisionDto,
  ): Promise<void> {
    await this.service.delete(params.id, query.revision);
  }
}
