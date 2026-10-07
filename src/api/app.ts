import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth, type AuthVars } from './middleware/auth.js';
import { idempotency } from './middleware/idempotency.js';
import { observability, type RequestVars } from './middleware/observability.js';
import { campaigns } from './routes/campaigns.js';
import { companies } from './routes/companies.js';
import { consent } from './routes/consent.js';
import { discovery, marketplace } from './routes/discovery.js';
import { portalDiscovery } from './routes/portal-discovery.js';
import { events } from './routes/events.js';
import { health } from './routes/health.js';
import { messaging } from './routes/messaging.js';
import { promocodes } from './routes/promocodes.js';
import { rules } from './routes/rules.js';
import { unsubscribe } from './routes/unsubscribe.js';
import { internal } from './routes/internal.js';
import { operator } from './routes/operator/index.js';
import { webhookEndpoints } from './routes/webhook-endpoints.js';
import { webhooks } from './routes/webhooks.js';
import { InvalidAddressError } from '../spine/contacts/normalize.js';
import { CampaignError } from '../modules/campaigns/index.js';
import { DiscoveryError } from '../modules/discovery/index.js';
import { MessagingError } from '../modules/messaging/errors.js';
import { PromocodeError } from '../modules/promocodes/index.js';
import { WebhookError } from '../modules/webhooks/index.js';

export function createApp() {
  const app = new Hono<AuthVars & RequestVars>();

  app.use('*', observability);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof InvalidAddressError) return c.json({ error: err.message }, 400);
    if (err instanceof WebhookError) {
      return c.json({ error: err.code, message: err.message }, err.status);
    }
    if (err instanceof PromocodeError) {
      return c.json({ error: err.code, message: err.message }, err.status);
    }
    if (err instanceof CampaignError) {
      return c.json({ error: err.code, message: err.message, ...(err.detail ?? {}) }, err.status);
    }
    if (err instanceof DiscoveryError) {
      return c.json({ error: err.code, message: err.message, ...(err.detail ?? {}) }, err.status);
    }
    if (err instanceof MessagingError) {
      return c.json({ error: err.code, message: err.message, ...(err.detail ?? {}) }, err.status);
    }
    console.error('unhandled error', err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.route('/', health);
  app.route('/', webhooks);
  app.route('/', unsubscribe);
  app.route('/', marketplace);
  app.route('/', internal);
  app.route('/', operator);

  app.use('/v1/*', auth);
  app.use('/v1/*', idempotency);
  app.route('/', events);
  app.route('/', consent);
  app.route('/', rules);
  app.route('/', messaging);
  app.route('/', companies);
  app.route('/', discovery);
  app.route('/', portalDiscovery);
  app.route('/', promocodes);
  app.route('/', campaigns);
  app.route('/', webhookEndpoints);

  return app;
}
