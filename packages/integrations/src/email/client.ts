import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface EmailAccount {
  readonly id: string;
  readonly email: string;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
}

export interface EmailCredentials extends EmailAccount {
  readonly password: string;
}

export interface EmailMessageSummary {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly preview: string;
  readonly unread: boolean;
}

export interface EmailMessage extends EmailMessageSummary {
  readonly to: string[];
  readonly text: string;
}

function clientFor(account: EmailCredentials): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: account.password },
    logger: false,
    socketTimeout: 20_000,
  });
}

function addressList(
  values: readonly { name?: string | undefined; address?: string | undefined }[],
): string {
  return values
    .map((value) => (value.name ? `${value.name} <${value.address ?? ''}>` : (value.address ?? '')))
    .filter(Boolean)
    .join(', ');
}

function isoDate(value: Date | string | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

/** Leitor IMAP sem estado: cada operação abre e fecha a própria conexão TLS. */
export class EmailClient {
  constructor(private readonly account: EmailCredentials) {}

  async verify(): Promise<void> {
    const client = clientFor(this.account);
    try {
      await client.connect();
      await client.mailboxOpen('INBOX', { readOnly: true });
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  async list(limit = 25): Promise<EmailMessageSummary[]> {
    const client = clientFor(this.account);
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const uids = await client.search({ all: true }, { uid: true });
        const selected = (uids === false || uids === undefined ? [] : uids)
          .slice(-Math.max(1, Math.min(100, limit)))
          .reverse();
        if (selected.length === 0) return [];
        const messages = await client.fetchAll(
          selected.join(','),
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            bodyStructure: false,
          },
          { uid: true },
        );
        return messages.reverse().map((message) => ({
          uid: message.uid,
          from: addressList(message.envelope?.from ?? []),
          subject: message.envelope?.subject ?? '(sem assunto)',
          date: isoDate(message.internalDate ?? message.envelope?.date),
          preview: '',
          unread: !message.flags?.has('\\Seen'),
        }));
      } finally {
        lock.release();
      }
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }

  async read(uid: number): Promise<EmailMessage | undefined> {
    const client = clientFor(this.account);
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const message = await client.fetchOne(
          String(uid),
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            source: true,
          },
          { uid: true },
        );
        if (!message || !message.source) return undefined;
        const parsed = await simpleParser(message.source);
        const text = (
          typeof parsed.text === 'string'
            ? parsed.text
            : typeof parsed.html === 'string'
              ? parsed.html.replace(/<[^>]*>/g, ' ')
              : ''
        ).trim();
        return {
          uid: message.uid,
          from: addressList(message.envelope?.from ?? []),
          to: (message.envelope?.to ?? []).map((value) => value.address ?? '').filter(Boolean),
          subject: message.envelope?.subject ?? '(sem assunto)',
          date: isoDate(message.internalDate ?? message.envelope?.date),
          preview: text.slice(0, 240),
          text: text.slice(0, 20_000),
          unread: !message.flags?.has('\\Seen'),
        };
      } finally {
        lock.release();
      }
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }
}
