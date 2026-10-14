import type { Channel, Purpose } from '../../../spine/contacts/normalize.js';

/** Whatever a provider needs to authenticate. Shape is the adapter's business. */
export type ProviderConfig = Record<string, unknown>;

export type SendInput = {
  config: ProviderConfig;
  /** The engine's own message id, for correlation. Adapters may ignore it. */
  messageId: string;
  /** E.164 for phones, an address for email, a chat id for telegram. */
  to: string;
  /** The rendered Liquid body. WhatsApp ignores it: Meta only takes templates. */
  body: string;
  sender: string;
  purpose: Purpose;
  /** Email only: the rendered subject line. */
  subject?: string | undefined;
  /** WhatsApp only: the approved template name, language and parameter order. */
  providerRef?: unknown;
  /** The intent's variables, for a provider that fills its own template. */
  variables?: Record<string, unknown> | undefined;
  /** Promotional email only (marketing, outreach): the one-click List-Unsubscribe URL. */
  unsubscribeUrl?: string | undefined;
};

export type SendResult = { providerMessageId: string; raw: unknown };

/** What a provider callback turned out to mean. */
export type ProviderEvent =
  | {
      kind: 'status';
      providerMessageId: string;
      status: 'delivered' | 'read' | 'failed' | 'unknown';
      raw: unknown;
    }
  | { kind: 'inbound'; address: string; text: string; raw: unknown };

export type WebhookRequest = {
  headers: Record<string, string>;
  body: unknown;
  /** The body exactly as received, for signature verification. */
  rawBody: string;
  /** The tenant's decrypted credentials, when the provider signs per tenant. */
  config?: ProviderConfig | undefined;
};

export type CredentialCheck = { ok: true } | { ok: false; reason: string };

/**
 * A webhook that failed authentication rather than parsing. The status says
 * which lie to tell: 401 when a signature was wrong and the caller should know,
 * 404 when a shared secret was wrong and it should look like nothing is here.
 */
export class WebhookAuthError extends Error {
  constructor(
    readonly status: 401 | 404,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One file per provider. Adding a channel or a second vendor is a new file
 * implementing this and one line in the registry — nothing else changes.
 */
export interface ChannelAdapter {
  readonly provider: string;
  readonly channel: Channel;
  /** True when this provider verifies callbacks with a per-tenant secret. */
  readonly webhookNeedsConfig?: boolean;
  send(input: SendInput): Promise<SendResult>;
  parseWebhook(req: WebhookRequest): ProviderEvent[];
  validateCredentials(config: ProviderConfig, sender: string): Promise<CredentialCheck>;
  /** Which tenant a callback belongs to, when the payload says. */
  tenantHint?(req: WebhookRequest): { configKey: string; value: string } | undefined;
}
