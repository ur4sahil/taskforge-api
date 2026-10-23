import { ConfigService } from '@nestjs/config';

/** Feature flags the web uses to show or hide UI. Derived from server config so
 *  the client never has to guess (QA #38: the AI panel rendered with no key set).
 *  Returned on GET /users/me and GET /workspaces/:wid. */
export function featureFlags(config: ConfigService): { ai: boolean } {
  return { ai: !!config.get<string>('ai.anthropicApiKey') };
}
