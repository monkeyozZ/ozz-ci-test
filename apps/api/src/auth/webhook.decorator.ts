import { SetMetadata } from '@nestjs/common';
export const IS_SIGNED_GITHUB_WEBHOOK = 'ozz:signed-github-webhook';
/** Only paired with the dedicated HMAC guard; does not weaken other public POST routes. */
export const SignedGitHubWebhook = () => SetMetadata(IS_SIGNED_GITHUB_WEBHOOK, true);
