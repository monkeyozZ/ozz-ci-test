import {
  Controller,
  Injectable,
  Post,
  Req,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  HttpCode,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignedGitHubWebhook } from '../../auth/webhook.decorator.js';
import { GitService } from './git.service.js';
import { WebhookReceiptDto } from './git.dto.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawWebhookBody?: Buffer;
    webhookReceipt?: WebhookReceiptDto;
  }
}
@Injectable()
export class GitHubWebhookGuard implements CanActivate {
  constructor(private readonly service: GitService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const params = request.params as { repositoryId: string; callbackId: string };
    request.webhookReceipt = await this.service.services.request(() =>
      this.service.receiver.receive({
        repositoryId: params.repositoryId,
        callbackId: params.callbackId,
        deliveryId: request.headers['x-github-delivery'],
        event: request.headers['x-github-event'],
        signature: request.headers['x-hub-signature-256'],
        contentEncoding: request.headers['content-encoding'],
        body: request.rawWebhookBody!,
      }),
    );
    return true;
  }
}
@ApiTags('webhooks')
@SignedGitHubWebhook()
@UseGuards(GitHubWebhookGuard)
@Controller('webhooks/github')
export class GitHubWebhookController {
  @Post(':repositoryId/:callbackId')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'receiveGithubWebhook',
    description: '仅HMAC验签：对原始Buffer验证后才解析JSON；首次投递202，合法重复投递200',
  })
  @ApiAcceptedResponse({ type: WebhookReceiptDto })
  @ApiOkResponse({ type: WebhookReceiptDto })
  @ApiParam({ name: 'repositoryId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'callbackId', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'X-GitHub-Delivery', required: true })
  @ApiHeader({ name: 'X-GitHub-Event', required: true })
  @ApiHeader({ name: 'X-Hub-Signature-256', required: true })
  @ApiBody({
    schema: { type: 'object', additionalProperties: true },
    description: '原始GitHub JSON bytes，验签前不解析',
  })
  receive(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.code(request.webhookReceipt!.duplicate ? 200 : 202);
    return request.webhookReceipt;
  }
}
