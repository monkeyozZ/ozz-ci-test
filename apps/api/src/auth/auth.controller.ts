import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '@ozz/config';
import { AuthSessionResponse, LoginDto } from './auth.dto';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { Public } from './public.decorator';
import type { AuthenticatedRequest } from './auth.types';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ operationId: 'login', summary: '管理员登录' })
  @ApiOkResponse({ type: AuthSessionResponse })
  async login(
    @Body() input: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token, data } = await this.auth.login(
      input,
      req.ip,
      req.id,
      req.cookies[SESSION_COOKIE],
    );
    const config = loadConfig();
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/api',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.nodeEnv === 'production',
      expires: data.expiresAt,
      maxAge: config.sessionTtlSeconds,
    });
    reply.header('Cache-Control', 'no-store');
    return { data };
  }

  @Get('me')
  @ApiCookieAuth(SESSION_COOKIE)
  @ApiOperation({ operationId: 'getCurrentSession', summary: '当前管理员与会话校验' })
  @ApiOkResponse({ type: AuthSessionResponse })
  me(@Req() req: AuthenticatedRequest) {
    return this.auth.describe(req.user, req.cookies[SESSION_COOKIE]!, req.sessionExpiresAt);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth(SESSION_COOKIE)
  @ApiOperation({ operationId: 'logout', summary: '撤销当前会话' })
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.sessionId, req.user.id, req.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/api' });
  }
}
