import nodemailer, { type Transporter } from 'nodemailer';
import { isPromotional } from '../../../spine/contacts/normalize.js';
import type {
  ChannelAdapter,
  CredentialCheck,
  ProviderConfig,
  ProviderEvent,
  SendInput,
  SendResult,
} from './types.js';

type SmtpConfig = {
  host?: unknown;
  port?: unknown;
  secure?: unknown;
  user?: unknown;
  pass?: unknown;
  fromName?: unknown;
};

function transportFor(config: ProviderConfig): { transport: Transporter; fromName?: string } {
  const { host, port, secure, user, pass, fromName } = config as SmtpConfig;
  if (typeof host !== 'string' || !host) throw new Error('email-smtp: config.host is required');

  return {
    transport: nodemailer.createTransport({
      host,
      port: typeof port === 'number' ? port : Number(port ?? 587),
      secure: secure === true || secure === 'true',
      ...(typeof user === 'string' && user
        ? { auth: { user, pass: typeof pass === 'string' ? pass : '' } }
        : {}),
    }),
    ...(typeof fromName === 'string' ? { fromName } : {}),
  };
}

export const emailSmtpAdapter: ChannelAdapter = {
  provider: 'email-smtp',
  channel: 'email',

  async send(input: SendInput): Promise<SendResult> {
    if (!input.subject) throw new Error('email-smtp: template has no subject');

    const { transport, fromName } = transportFor(input.config);

    // One-click unsubscribe. Gmail and Yahoo require it on bulk mail, and it is
    // the difference between an opt-out and a spam complaint.
    const headers: Record<string, string> = {};
    if (isPromotional(input.purpose) && input.unsubscribeUrl) {
      headers['List-Unsubscribe'] =
        `<${input.unsubscribeUrl}>, <mailto:${input.sender}?subject=unsubscribe>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    const result = await transport.sendMail({
      from: fromName ? `"${fromName}" <${input.sender}>` : input.sender,
      to: input.to,
      subject: input.subject,
      text: input.body,
      headers,
    });

    if (!result.messageId) throw new Error('email-smtp: transport returned no messageId');
    return { providerMessageId: result.messageId, raw: result };
  },

  async validateCredentials(config: ProviderConfig): Promise<CredentialCheck> {
    try {
      const { transport } = transportFor(config);
      await transport.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  },

  /** SMTP has no delivery reports. A sent message stays `sent`. */
  parseWebhook(): ProviderEvent[] {
    return [];
  },
};
