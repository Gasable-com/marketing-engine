/**
 * Typed wrappers over the engine's /internal/ API, proxied at /api/.
 *
 * The shapes here mirror docs/API.md by hand. Nothing is imported from the
 * engine's source: the dashboard talks to a published contract, not to an
 * implementation, and would still build if the engine were rewritten.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${status}`);
  }
}

async function get<T>(path: string, params: Params = {}): Promise<T> {
  const query = toQuery(params);
  const res = await fetch(`${BASE}${path}${query}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return (await res.json()) as T;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return (await res.json().catch(() => null)) as T;
}

export type Params = Record<string, string | number | undefined>;

function toQuery(params: Params): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}

/** Every list is a page with an opaque cursor; never an offset. */
export type Page<T> = { items: T[]; nextCursor: string | null };

export type QueueRow = {
  name: string;
  created: number;
  active: number;
  retry: number;
  failed: number;
  cancelled: number;
  completedInWindow: number;
};

export type MessageCounts = {
  queued?: number;
  sent?: number;
  delivered?: number;
  read?: number;
  failed?: number;
  blocked?: number;
};

export type TenantSummary = {
  tenantId: string;
  tenantName: string;
  messages: MessageCounts;
  invites: { sent: number; accepted: number };
  redemptions: { reserved: number; settled: number; released: number };
  webhookFailures: number;
};

export type Overview = {
  asOf: string;
  window: { since: string; until: string };
  health: { db: boolean; boss: string; version: string };
  queue: QueueRow[];
  messages: MessageCounts;
  blockedReasons: Record<string, number>;
  tenants: TenantSummary[];
  webhooks: { pending?: number; failed?: number };
  reservations: { open: number; expiringWithin15m: number };
  discovery: { searches: number; invitesFromSearch: number };
  campaigns: {
    scheduled: number;
    running: number;
    recipientsPending: number;
    sentInWindow: number;
    blockedInWindow: number;
  };
};

export type EventRow = {
  id: string;
  type: string;
  tenantId: string;
  tenantName: string;
  subjectType: string | null;
  subjectId: string | null;
  payload?: unknown;
  occurredAt: string;
};

export type MessageRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  channel: string;
  address: string;
  region: string | null;
  purpose: string;
  template: string;
  status: string;
  blockedReason: string | null;
  error: string | null;
  provider: string | null;
  providerMessageId: string | null;
  companyId: string | null;
  companyName: string | null;
  parentMessageId: string | null;
  fallbackChannels: string[];
  createdAt: string;
  updatedAt: string;
  timeline: { type: string; at: string }[];
};

export type MessageDetail = {
  message: MessageRow & { body?: string; variables?: unknown; contact?: unknown };
  events: { id: string; type: string; payload: unknown; occurredAt: string }[];
  deliveryReports: { id: string; type: string; payload: unknown; occurredAt: string }[];
  fallbackChildren: { id: string; channel: string; status: string; blockedReason: string | null }[];
  parent: { id: string; channel: string; status: string } | null;
};

export type JobRow = {
  id: string;
  name: string;
  state: string;
  retryCount: number;
  retryLimit: number;
  data: unknown;
  output: unknown;
  createdOn: string;
  startedOn: string | null;
  completedOn: string | null;
  tenantId: string | null;
  tenantName: string | null;
};

export type ScheduleRow = {
  name: string;
  cron: string;
  timezone: string | null;
  data: unknown;
  lastCompletedOn: string | null;
  lastState: string | null;
  lastOutput: unknown;
};

export type TenantRow = {
  id: string;
  name: string;
  externalRef: string | null;
  createdAt: string;
} & Partial<TenantSummary>;

export type TenantDetail = {
  tenant: { id: string; name: string; externalRef: string | null; createdAt: string };
  channels: {
    channel: string;
    provider: string;
    sender: string;
    unsubscribeText: string | null;
    configured: boolean;
    updatedAt: string;
  }[];
  templates: { name: string; channel: string; updatedAt: string }[];
  rules: Record<string, number>;
  webhooks: { id: string; url: string; eventTypes: string[]; active: boolean; createdAt: string }[];
  counts: Record<string, { messages: MessageCounts; invites: unknown; redemptions: unknown } | null>;
};

export type RedemptionRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  promocodeId: string;
  code: string;
  buyerRef: string;
  buyerCompanyRef: string | null;
  orderRef: string;
  currency: string;
  discountAmount: string;
  status: string;
  reservedAt: string;
  settledAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  expiresAt: string;
};

export type PromocodeRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  code: string;
  currency: string;
  /** A percent `value` is basis points: 1000 is 10%. Amounts are minor units. */
  discount: {
    type: 'percent' | 'fixed';
    value: number;
    maxDiscount?: number;
    minSubtotal?: number;
    /** Limits the code to these products, matched on each cart item's sku. Absent or empty: all. */
    productIds?: string[];
  };
  rules: unknown;
  budget: { maxSpend?: number; maxUses?: number; perBuyerMaxUses?: number };
  funders: { party: string; share: number }[];
  startsAt: string;
  endsAt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  usage: {
    /** Reserved plus settled: what the budget counts. */
    uses: number;
    spend: number;
    reserved: { count: number; amount: number };
    settled: { count: number; amount: number };
    released: { count: number; amount: number };
    buyers: number;
    remainingUses: number | null;
    remainingSpend: number | null;
    lastRedeemedAt: string | null;
  };
  /** Whether it can be redeemed right now, decided by the engine. */
  availability: string;
};

export type InviteRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  companyId: string;
  companyName: string;
  messageId: string | null;
  status: string;
  acceptedRef: string | null;
  finderRunId: string | null;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string;
};

export type CompanyRow = {
  id: string;
  name: string;
  country: string | null;
  onPlatformRef: string | null;
  onPlatformAt: string | null;
  createdAt: string;
  buys: string[] | null;
  sells: string[] | null;
  sector: string | null;
  city: string | null;
};

export type DeliveryRow = {
  id: string;
  status: string;
  attempt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  endpointId: string;
  url: string;
  tenantId: string | null;
  tenantName: string | null;
  eventId: string;
  eventType: string;
};

export type CampaignRun = {
  id: string;
  runNo: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  audienceSize: number | null;
  queued: number;
  blocked: number;
  skipped: number;
  pending: number;
  /** The part of `pending` waiting on a sending window. */
  deferred: number;
  error: string | null;
};

export type CampaignRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  status: string;
  purpose: string;
  channel: string | null;
  template: string;
  audienceId: string;
  audienceName: string;
  throttlePerMinute: number;
  recurrence: { cron: string; endsAt?: string; maxRuns?: number } | null;
  timezone: string;
  scheduledAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: CampaignRun | null;
};

export type CampaignDetail = {
  campaign: Omit<CampaignRow, 'lastRun'> & { variables: unknown; audienceKind: string };
  runs: CampaignRun[];
};

export type RecipientRow = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  state: string;
  reason: string | null;
  /** Set while a pending recipient waits on a sending window. */
  notBefore: string | null;
  messageId: string | null;
  channel: string | null;
  messageStatus: string | null;
  messageBlockedReason: string | null;
  messageError: string | null;
  messageUpdatedAt: string | null;
};

export type Metrics = {
  bucket: string;
  series: { key: string; points: [string, number][] }[];
};

export const api = {
  overview: (window: string) => get<Overview>('/overview', { window }),

  tenants: (params: Params) => get<Page<TenantRow>>('/tenants', params),
  tenant: (id: string) => get<TenantDetail>(`/tenants/${id}`),

  events: (params: Params) => get<Page<EventRow>>('/events', params),
  event: (id: string) => get<{ event: EventRow }>(`/events/${id}`),

  messages: (params: Params) => get<Page<MessageRow>>('/messages', params),
  message: (id: string) => get<MessageDetail>(`/messages/${id}`),

  redemptions: (params: Params) => get<Page<RedemptionRow>>('/redemptions', params),
  promocodes: (params: Params) => get<Page<PromocodeRow>>('/promocodes', params),
  promocode: (id: string) => get<{ promocode: PromocodeRow }>(`/promocodes/${id}`),
  invites: (params: Params) => get<Page<InviteRow>>('/invites', params),
  companies: (params: Params) => get<Page<CompanyRow>>('/companies', params),

  deliveries: (params: Params) => get<Page<DeliveryRow>>('/webhook-deliveries', params),
  replayDelivery: (id: string) => post<{ delivery: DeliveryRow }>(`/webhook-deliveries/${id}/replay`),

  jobs: (params: Params) => get<Page<JobRow>>('/jobs', params),
  job: (id: string) => get<{ job: JobRow }>(`/jobs/${id}`),
  retryJob: (id: string) => post<{ retried: string }>(`/jobs/${id}/retry`),
  schedules: () => get<{ schedules: ScheduleRow[] }>('/schedules'),

  metrics: (params: Params) => get<Metrics>('/metrics', params),

  campaigns: (params: Params) => get<Page<CampaignRow>>('/campaigns', params),
  campaign: (id: string) => get<CampaignDetail>(`/campaigns/${id}`),
  recipients: (id: string, runId: string, params: Params) =>
    get<Page<RecipientRow>>(`/campaigns/${id}/runs/${runId}/recipients`, params),

  /** The stream is an EventSource, not a fetch; this is just where its URL lives. */
  streamUrl: (params: Params) => `${BASE}/stream${toQuery(params)}`,
};
