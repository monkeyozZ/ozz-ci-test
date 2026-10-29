import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PageQueryDto } from '../../common/pagination.js';
import { ResourceParamsDto } from '../projects/metadata.dto.js';
import { ServiceEnvelopeDto } from '../services/service.dto.js';
import {
  GitPolicyUpdateDto,
  GitPreviewRequestDto,
  GitPublicationPreviewEnvelopeDto,
  GitSourceUpdateDto,
  WebhookDeliveryEnvelopeDto,
  WebhookDeliveryListDto,
  WebhookDeliveryQueryDto,
  WebhookRejectionListDto,
  WebhookTargetListDto,
} from './git.dto.js';
import { GitService } from './git.service.js';

@ApiTags('git')
@ApiCookieAuth()
@Controller()
export class GitController {
  constructor(private readonly service: GitService) {}
  @Get('services/:id/git-source')
  @ApiOperation({ operationId: 'getServiceGitSource' })
  @ApiOkResponse({ type: ServiceEnvelopeDto })
  source(@Param() params: ResourceParamsDto) {
    return this.service.services.get(params.id);
  }
  @Put('services/:id/git-source')
  @ApiOperation({ operationId: 'updateServiceGitSource' })
  @ApiOkResponse({ type: ServiceEnvelopeDto })
  update(@Param() params: ResourceParamsDto, @Body() input: GitSourceUpdateDto) {
    return this.service.services.request(async () => ({
      data: await this.service.services.git.updateSource(params.id, input),
    }));
  }
  @Patch('services/:id/git-source/policy')
  @ApiOperation({ operationId: 'updateServiceGitPolicy' })
  @ApiOkResponse({ type: ServiceEnvelopeDto })
  policy(@Param() params: ResourceParamsDto, @Body() input: GitPolicyUpdateDto) {
    return this.service.services.request(async () => ({
      data: await this.service.services.git.updatePolicy(params.id, input),
    }));
  }
  @Post('services/:id/git-source/preview')
  @HttpCode(200)
  @ApiOperation({ operationId: 'previewGitPublication' })
  @ApiOkResponse({ type: GitPublicationPreviewEnvelopeDto })
  preview(@Param() params: ResourceParamsDto, @Body() input: GitPreviewRequestDto) {
    return this.service.services.request(async () => ({
      data: await this.service.services.git.preview(params.id, input),
    }));
  }
  @Get('services/:id/pending-commits')
  @ApiOperation({ operationId: 'listPendingCommits' })
  @ApiOkResponse({ type: WebhookTargetListDto })
  pending(@Param() params: ResourceParamsDto, @Query() query: PageQueryDto) {
    return this.service.services.request(() =>
      this.service.queries.targets({ ...query, serviceId: params.id }),
    );
  }
  @Get('webhook-deliveries')
  @ApiOperation({ operationId: 'listWebhookDeliveries' })
  @ApiOkResponse({ type: WebhookDeliveryListDto })
  deliveries(@Query() query: WebhookDeliveryQueryDto) {
    return this.service.services.request(() => this.service.queries.deliveries(query));
  }
  @Get('webhook-deliveries/:id')
  @ApiOperation({ operationId: 'getWebhookDelivery' })
  @ApiOkResponse({ type: WebhookDeliveryEnvelopeDto })
  delivery(@Param() params: ResourceParamsDto) {
    return this.service.delivery(params.id);
  }
  @Get('webhook-deliveries/:id/targets')
  @ApiOperation({ operationId: 'listWebhookDeliveryTargets' })
  @ApiOkResponse({ type: WebhookTargetListDto })
  targets(@Param() params: ResourceParamsDto, @Query() query: PageQueryDto) {
    return this.service.services.request(() =>
      this.service.queries.targets({ ...query, webhookDeliveryId: params.id }),
    );
  }
  @Get('webhook-rejections')
  @ApiOperation({ operationId: 'listWebhookRejections' })
  @ApiOkResponse({ type: WebhookRejectionListDto })
  rejections(@Query() query: WebhookDeliveryQueryDto) {
    return this.service.rejections(query.repositoryId);
  }
}
