import {
  Body,
  Controller,
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
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PageQueryDto } from '../../common/pagination.js';
import { ResourceParamsDto, RevisionDto } from '../projects/metadata.dto.js';
import { infrastructureActor, type InfrastructureRequest } from '../infrastructure/actor.js';
import { OperationEnvelopeDto } from '../operations/operation.dto.js';
import { IntegrationsService } from './integrations.service.js';
import {
  BuilderCreateDto,
  BuilderEnvelopeDto,
  BuilderListDto,
  BuilderUpdateDto,
  GitBranchListDto,
  GitHubConnectionCreateDto,
  GitHubConnectionEnvelopeDto,
  GitHubConnectionListDto,
  GitHubConnectionUpdateDto,
  GitHubPageQueryDto,
  GitHubRepositoryParamsDto,
  GitRepositoryListDto,
  RegisterWebhookDto,
  RegistryConnectionCreateDto,
  RegistryConnectionEnvelopeDto,
  RegistryConnectionListDto,
  RegistryConnectionUpdateDto,
} from './integration.dto.js';

@ApiTags('integrations')
@ApiCookieAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}
  @Get('github')
  @ApiOperation({ operationId: 'listGithubConnections' })
  @ApiOkResponse({ type: GitHubConnectionListDto })
  github(@Query() query: PageQueryDto) {
    return this.service.request(() => this.service.commands.githubConnections(query));
  }
  @Post('github')
  @ApiOperation({
    operationId: 'createGithubConnection',
    description: '只保存PAT引用，不注册Webhook',
  })
  @ApiCreatedResponse({ type: GitHubConnectionEnvelopeDto })
  createGithub(@Body() input: GitHubConnectionCreateDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.createGithub(input),
    }));
  }
  @Get('github/:id')
  @ApiOperation({ operationId: 'getGithubConnection' })
  @ApiOkResponse({ type: GitHubConnectionEnvelopeDto })
  getGithub(@Param() params: ResourceParamsDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.getGithub(params.id),
    }));
  }
  @Patch('github/:id')
  @ApiOperation({ operationId: 'updateGithubConnection' })
  @ApiOkResponse({ type: GitHubConnectionEnvelopeDto })
  updateGithub(@Param() params: ResourceParamsDto, @Body() input: GitHubConnectionUpdateDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.updateGithub(params.id, input),
    }));
  }
  @Post('github/:id/verify')
  @HttpCode(200)
  @ApiOperation({ operationId: 'verifyGithubConnection' })
  @ApiOkResponse({ type: GitHubConnectionEnvelopeDto })
  verifyGithub(@Param() params: ResourceParamsDto, @Body() input: RevisionDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.verifyGithub(params.id, input.revision),
    }));
  }
  @Get('github/:id/repositories')
  @ApiOperation({ operationId: 'listGithubRepositories' })
  @ApiOkResponse({ type: GitRepositoryListDto })
  repositories(@Param() params: ResourceParamsDto, @Query() query: GitHubPageQueryDto) {
    return this.service.request(() => this.service.commands.repositories(params.id, query.cursor));
  }
  @Get('github/:id/repositories/:repositoryId/branches')
  @ApiOperation({ operationId: 'listGithubBranches' })
  @ApiOkResponse({ type: GitBranchListDto })
  branches(@Param() params: GitHubRepositoryParamsDto, @Query() query: GitHubPageQueryDto) {
    return this.service.request(() =>
      this.service.commands.branches(params.id, params.repositoryId, query.cursor),
    );
  }
  @Post('github/:id/repositories/:repositoryId/webhook')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'registerGithubWebhook',
    description: '明确注册或更新平台自己持有的GitHub hook，执行真实外部写操作',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  registerWebhook(
    @Param() params: GitHubRepositoryParamsDto,
    @Body() input: RegisterWebhookDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async () => ({
      data: await this.service.commands.registerWebhook(
        params.id,
        params.repositoryId,
        input,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Get('registries')
  @ApiOperation({ operationId: 'listRegistryConnections' })
  @ApiOkResponse({ type: RegistryConnectionListDto })
  registries(@Query() query: PageQueryDto) {
    return this.service.request(() => this.service.commands.registries(query));
  }
  @Post('registries')
  @ApiOperation({ operationId: 'createRegistryConnection' })
  @ApiCreatedResponse({ type: RegistryConnectionEnvelopeDto })
  createRegistry(@Body() input: RegistryConnectionCreateDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.createRegistry(input),
    }));
  }
  @Get('registries/:id')
  @ApiOperation({ operationId: 'getRegistryConnection' })
  @ApiOkResponse({ type: RegistryConnectionEnvelopeDto })
  getRegistry(@Param() params: ResourceParamsDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.getRegistry(params.id),
    }));
  }
  @Patch('registries/:id')
  @ApiOperation({ operationId: 'updateRegistryConnection' })
  @ApiOkResponse({ type: RegistryConnectionEnvelopeDto })
  updateRegistry(@Param() params: ResourceParamsDto, @Body() input: RegistryConnectionUpdateDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.updateRegistry(params.id, input),
    }));
  }
  @Post('registries/:id/verify')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'verifyRegistryConnection',
    description: '在平台专用探针repository推送小型OCI镜像，验证pull身份可读取并实际不能push',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiAcceptedResponse({ type: OperationEnvelopeDto })
  verifyRegistry(
    @Param() params: ResourceParamsDto,
    @Body() input: RevisionDto,
    @Req() request: InfrastructureRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.request(async () => ({
      data: await this.service.commands.verifyRegistry(
        params.id,
        input.revision,
        infrastructureActor(request),
        key,
      ),
    }));
  }
  @Get('builders')
  @ApiOperation({ operationId: 'listBuilders' })
  @ApiOkResponse({ type: BuilderListDto })
  builders(@Query() query: PageQueryDto) {
    return this.service.request(() => this.service.commands.builders(query));
  }
  @Post('builders')
  @ApiOperation({ operationId: 'createBuilder' })
  @ApiCreatedResponse({ type: BuilderEnvelopeDto })
  createBuilder(@Body() input: BuilderCreateDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.createBuilder(input),
    }));
  }
  @Get('builders/:id')
  @ApiOperation({ operationId: 'getBuilder' })
  @ApiOkResponse({ type: BuilderEnvelopeDto })
  getBuilder(@Param() params: ResourceParamsDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.getBuilder(params.id),
    }));
  }
  @Patch('builders/:id')
  @ApiOperation({ operationId: 'updateBuilder' })
  @ApiOkResponse({ type: BuilderEnvelopeDto })
  updateBuilder(@Param() params: ResourceParamsDto, @Body() input: BuilderUpdateDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.updateBuilder(params.id, input),
    }));
  }
  @Post('builders/:id/verify')
  @HttpCode(200)
  @ApiOperation({ operationId: 'verifyBuilder' })
  @ApiOkResponse({ type: BuilderEnvelopeDto })
  verifyBuilder(@Param() params: ResourceParamsDto, @Body() input: RevisionDto) {
    return this.service.request(async () => ({
      data: await this.service.commands.verifyBuilder(params.id, input.revision),
    }));
  }
}
