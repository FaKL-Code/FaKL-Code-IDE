import { randomBytes } from 'node:crypto';

import type { ScopedAccess } from './rpc/server.js';

/**
 * Tokens restritos dos agentes. Cada sessão recebe um token que só abre os
 * métodos das ferramentas MCP dela (maestro, vault), e os métodos sabem qual
 * sessão chamou.
 */
export class AgentTokens {
  private readonly byToken = new Map<string, ScopedAccess>();

  issue(sessionId: string, methods: Iterable<string>): string {
    const token = randomBytes(32).toString('base64url');
    this.byToken.set(token, { principal: sessionId, methods: new Set(methods) });
    return token;
  }

  access(token: string): ScopedAccess | undefined {
    return this.byToken.get(token);
  }

  revokeSession(sessionId: string): void {
    for (const [token, access] of this.byToken) {
      if (access.principal === sessionId) this.byToken.delete(token);
    }
  }
}
