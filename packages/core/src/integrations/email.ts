import {
  EmailClient,
  type EmailCredentials,
  type EmailMessage,
  type EmailMessageSummary,
} from '@fakl/integrations';
import type { EmailAccountRef } from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

import type { Router, CallContext } from '../rpc/router.js';
import { objectParams, RpcError, stringParam } from '../rpc/router.js';
import { untrusted } from './guard.js';

function isAgent(context: CallContext): boolean {
  return context.principal !== undefined && !context.principal.startsWith('remote:');
}

function safeLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.floor(value)))
    : 25;
}

/** Caixas IMAP em memória; os dados e credenciais vêm do SecretStorage da IDE. */
export class EmailService {
  private accounts: EmailCredentials[] = [];

  register(router: Router): void {
    router.register('email.configure', (params, context) => {
      if (context.principal !== undefined)
        throw RpcError.invalidParams(l10n.t('only the IDE configures email'));
      const p = objectParams(params);
      if (!Array.isArray(p.contas)) throw RpcError.invalidParams(l10n.t('contas must be a list'));
      this.accounts = p.contas.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw RpcError.invalidParams(l10n.t('invalid account'));
        }
        const account = item as Record<string, unknown>;
        const id = stringParam(account, 'id');
        const email = stringParam(account, 'email');
        const host = stringParam(account, 'host');
        const username = stringParam(account, 'username');
        const password = stringParam(account, 'password');
        const port = account.port;
        if (!/^[\w.-]+$/.test(host) || !email.includes('@')) {
          throw RpcError.invalidParams(l10n.t('invalid IMAP address'));
        }
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw RpcError.invalidParams(l10n.t('invalid IMAP port'));
        }
        return { id, email, host, username, password, port, secure: true };
      });
      return this.accounts.map(({ id, email }) => ({ id, email }));
    });

    router.register('email.accounts', () => this.accountRefs());
    router.register('email.verify', async (params) => {
      const p = objectParams(params);
      await new EmailClient(this.account(stringParam(p, 'accountId'))).verify();
      return { conectado: true };
    });
    router.register('email.inbox', async (params, context) => {
      const p = objectParams(params);
      const account = this.account(stringParam(p, 'accountId'));
      const messages = await new EmailClient(account).list(safeLimit(p.limite));
      return messages.map((message) => this.markSummary(message, isAgent(context)));
    });
    router.register('email.read', async (params, context) => {
      const p = objectParams(params);
      const account = this.account(stringParam(p, 'accountId'));
      const uid = p.uid;
      if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0) {
        throw RpcError.invalidParams(l10n.t('uid must be a positive integer'));
      }
      const message = await new EmailClient(account).read(uid);
      if (!message) throw RpcError.invalidParams(l10n.t('email not found in the inbox'));
      return this.markMessage(message, isAgent(context));
    });
  }

  accountRefs(): EmailAccountRef[] {
    return this.accounts.map(({ id, email }) => ({ id, email }));
  }

  private account(id: string): EmailCredentials {
    const account = this.accounts.find((candidate) => candidate.id === id);
    if (!account) throw RpcError.invalidParams(l10n.t('email mailbox not configured'));
    return account;
  }

  private markSummary(message: EmailMessageSummary, agent: boolean): EmailMessageSummary {
    if (!agent) return message;
    return {
      ...message,
      from: untrusted('email', message.from),
      subject: untrusted('email', message.subject),
      preview: message.preview ? untrusted('email', message.preview) : '',
    };
  }

  private markMessage(message: EmailMessage, agent: boolean): EmailMessage {
    if (!agent) return message;
    return {
      ...this.markSummary(message, true),
      to: message.to,
      text: untrusted('email', message.text),
    };
  }
}
