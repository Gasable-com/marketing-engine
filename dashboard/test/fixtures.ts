/**
 * Shapes copied from docs/API.md and the operator API's own tests. Not imported
 * from the engine: the dashboard is written against the published contract.
 */
import type {
  CampaignDetail,
  CampaignRow,
  CompanyRow,
  DeliveryRow,
  DiscoveryJobDetail,
  DiscoveryJobRow,
  DiscoveryResult,
  JobRow,
  MessageDetail,
  MessageRow,
  Metrics,
  Overview,
  PromocodeRow,
  RecipientRow,
  RedemptionRow,
  RowReading,
  ScheduleRow,
  TenantDetail,
  TenantRow,
} from '../src/api.js';

export const overview: Overview = {
  asOf: '2026-09-21T10:00:00.000Z',
  window: { since: '2026-09-20T10:00:00.000Z', until: '2026-09-21T10:00:00.000Z' },
  health: { db: true, boss: 'running (3 queued)', version: '0.1.0' },
  queue: [
    { name: 'message.send', created: 3, active: 1, retry: 2, failed: 4, cancelled: 0, completedInWindow: 412 },
  ],
  messages: { queued: 3, sent: 200, delivered: 180, read: 40, failed: 4, blocked: 12 },
  blockedReasons: { no_consent: 9, suppressed: 1, 'rule:sa-marketing-sms-hours': 2 },
  tenants: [
    {
      tenantId: '11111111-1111-1111-1111-111111111111',
      tenantName: 'Acme Supplies',
      messages: { sent: 200, delivered: 180, failed: 4, blocked: 12 },
      invites: { sent: 5, accepted: 1 },
      redemptions: { reserved: 2, settled: 9, released: 1 },
      webhookFailures: 0,
    },
  ],
  webhooks: { pending: 1, failed: 2 },
  reservations: { open: 2, expiringWithin15m: 1 },
  discovery: { searches: 33, invitesFromSearch: 4 },
  campaigns: { scheduled: 2, running: 1, recipientsPending: 340, sentInWindow: 1200, blockedInWindow: 45 },
};

export const tenants: TenantRow[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Acme Supplies',
    externalRef: 'mkt-acme',
    createdAt: '2026-09-01T09:00:00.000Z',
    messages: { sent: 200, failed: 4, blocked: 12 },
  },
];

export const tenantDetail: TenantDetail = {
  tenant: {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Acme Supplies',
    externalRef: 'mkt-acme',
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  channels: [
    {
      channel: 'sms',
      provider: 'taqnyat',
      sender: 'GASABLE-AD',
      unsubscribeText: 'Reply STOP',
      configured: true,
      updatedAt: '2026-09-20T09:00:00.000Z',
    },
  ],
  templates: [{ name: 'hello', channel: 'sms', updatedAt: '2026-09-20T09:00:00.000Z' }],
  rules: { sending_window: 1 },
  webhooks: [
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      url: 'https://marketplace.test/hooks',
      eventTypes: [],
      active: true,
      createdAt: '2026-09-20T09:00:00.000Z',
    },
  ],
  counts: {
    '24h': { messages: { sent: 200 }, invites: {}, redemptions: {} },
    '7d': null,
    '30d': null,
  },
};

export const messages: MessageRow[] = [
  {
    id: '22222222-2222-2222-2222-222222222222',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme Supplies',
    channel: 'sms',
    address: '+966501234567',
    region: 'SA',
    purpose: 'transactional',
    template: 'hello',
    status: 'delivered',
    blockedReason: null,
    error: null,
    provider: 'taqnyat',
    providerMessageId: '10139535725',
    companyId: null,
    companyName: null,
    parentMessageId: null,
    fallbackChannels: [],
    createdAt: '2026-09-21T09:00:00.000Z',
    updatedAt: '2026-09-21T09:01:00.000Z',
    timeline: [
      { type: 'message.queued', at: '2026-09-21T09:00:00.000Z' },
      { type: 'message.sent', at: '2026-09-21T09:00:30.000Z' },
      { type: 'message.delivered', at: '2026-09-21T09:01:00.000Z' },
    ],
  },
];

export const messageDetail: MessageDetail = {
  message: { ...messages[0]!, body: 'Hello Sam' },
  events: [
    { id: '1', type: 'message.queued', payload: {}, occurredAt: '2026-09-21T09:00:00.000Z' },
    { id: '2', type: 'message.delivered', payload: { raw: { status: 'DELIVERED' } }, occurredAt: '2026-09-21T09:01:00.000Z' },
  ],
  deliveryReports: [
    { id: '2', type: 'message.delivered', payload: { raw: { status: 'DELIVERED' } }, occurredAt: '2026-09-21T09:01:00.000Z' },
  ],
  fallbackChildren: [],
  parent: null,
};

export const jobs: JobRow[] = [
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'message.send',
    state: 'failed',
    retryCount: 3,
    retryLimit: 3,
    data: { messageId: '22222222-2222-2222-2222-222222222222' },
    output: { message: 'provider exploded' },
    createdOn: '2026-09-21T09:00:00.000Z',
    startedOn: '2026-09-21T09:00:01.000Z',
    completedOn: '2026-09-21T09:00:05.000Z',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme Supplies',
  },
];

export const schedules: ScheduleRow[] = [
  {
    name: 'promo.expire-reservations',
    cron: '*/5 * * * *',
    timezone: null,
    data: null,
    lastCompletedOn: '2026-09-21T09:55:00.000Z',
    lastState: 'completed',
    lastOutput: null,
  },
];

export const deliveries: DeliveryRow[] = [
  {
    id: '44',
    status: 'failed',
    attempt: 5,
    lastStatusCode: 500,
    lastError: 'receiver answered 500',
    nextAttemptAt: null,
    deliveredAt: null,
    createdAt: '2026-09-21T09:00:00.000Z',
    endpointId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    url: 'https://marketplace.test/hooks',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme Supplies',
    eventId: '1',
    eventType: 'message.sent',
  },
];

export const companies: CompanyRow[] = [
  {
    id: '55555555-5555-5555-5555-555555555555',
    name: 'شركة الفلاح للتجارة',
    country: 'SA',
    onPlatformRef: null,
    onPlatformAt: null,
    createdAt: '2026-09-20T09:00:00.000Z',
    buys: ['diesel'],
    sells: [],
    sector: 'energy',
    city: 'Riyadh',
  },
];

export const redemptions: RedemptionRow[] = [
  {
    id: '66666666-6666-6666-6666-666666666666',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme Supplies',
    promocodeId: '77777777-7777-7777-7777-777777777777',
    code: 'SAVE10',
    buyerRef: 'cust-1',
    buyerCompanyRef: 'co-1',
    orderRef: 'order-1',
    currency: 'SAR',
    discountAmount: '5000',
    status: 'settled',
    reservedAt: '2026-09-21T09:00:00.000Z',
    settledAt: '2026-09-21T09:05:00.000Z',
    releasedAt: null,
    releaseReason: null,
    expiresAt: '2026-09-21T10:00:00.000Z',
  },
];

export const promocodes: PromocodeRow[] = [
  {
    id: '77777777-7777-7777-7777-777777777777',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme Supplies',
    code: 'SAVE10',
    currency: 'SAR',
    discount: { type: 'percent', value: 1000, maxDiscount: 5000, productIds: ['99999999-9999-9999-9999-999999999999'] },
    rules: { '>=': [{ var: 'cart.subtotal' }, 100000] },
    budget: { maxUses: 100, maxSpend: 500000, perBuyerMaxUses: 1 },
    funders: [
      { party: 'platform', share: 0.6 },
      { party: 'tenant:11111111-1111-1111-1111-111111111111', share: 0.4 },
    ],
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: null,
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    usage: {
      uses: 10,
      spend: 45000,
      reserved: { count: 1, amount: 5000 },
      settled: { count: 9, amount: 40000 },
      released: { count: 1, amount: 5000 },
      buyers: 10,
      remainingUses: 90,
      remainingSpend: 455000,
      lastRedeemedAt: '2026-09-21T09:00:00.000Z',
    },
    availability: 'live',
  },
  {
    id: '88888888-8888-8888-8888-888888888888',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme Supplies',
    code: 'FLAT20',
    currency: 'SAR',
    discount: { type: 'fixed', value: 2000 },
    rules: null,
    budget: {},
    funders: [{ party: 'platform', share: 1 }],
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-09-15T00:00:00.000Z',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    usage: {
      uses: 0,
      spend: 0,
      reserved: { count: 0, amount: 0 },
      settled: { count: 0, amount: 0 },
      released: { count: 0, amount: 0 },
      buyers: 0,
      remainingUses: null,
      remainingSpend: null,
      lastRedeemedAt: null,
    },
    availability: 'expired',
  },
];

export const metrics: Metrics = {
  bucket: 'hour',
  series: [
    {
      key: 'sent',
      points: [
        ['2026-09-21T08:00:00.000Z', 12],
        ['2026-09-21T09:00:00.000Z', 30],
        ['2026-09-21T10:00:00.000Z', 7],
      ],
    },
    {
      key: 'failed',
      points: [
        ['2026-09-21T08:00:00.000Z', 1],
        ['2026-09-21T09:00:00.000Z', 0],
        ['2026-09-21T10:00:00.000Z', 2],
      ],
    },
  ],
};

const run = {
  id: '44444444-4444-4444-4444-444444444444',
  runNo: 3,
  status: 'sending',
  startedAt: '2026-09-21T09:00:00.000Z',
  finishedAt: null,
  audienceSize: 500,
  queued: 140,
  blocked: 18,
  skipped: 2,
  pending: 340,
  deferred: 120,
  error: null,
};

export const campaigns: CampaignRow[] = [
  {
    id: '33333333-3333-3333-3333-333333333333',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme Supplies',
    name: 'Monday diesel offer',
    status: 'running',
    purpose: 'marketing',
    channel: null,
    template: 'diesel_offer',
    audienceId: '55555555-5555-5555-5555-555555555555',
    audienceName: 'diesel buyers, Riyadh',
    throttlePerMinute: 60,
    recurrence: { cron: '0 10 * * 1' },
    timezone: 'Asia/Riyadh',
    scheduledAt: null,
    nextRunAt: '2026-09-28T07:00:00.000Z',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-21T09:00:00.000Z',
    lastRun: run,
  },
];

export const campaignDetail: CampaignDetail = {
  campaign: {
    ...campaigns[0]!,
    variables: { offer: '5%' },
    audienceKind: 'search',
  },
  runs: [run, { ...run, id: '66666666-6666-6666-6666-666666666666', runNo: 2, status: 'done', pending: 0, deferred: 0, queued: 470, blocked: 28, skipped: 2, finishedAt: '2026-09-14T07:20:00.000Z' }],
};

export const recipients: RecipientRow[] = [
  {
    id: '77777777-7777-7777-7777-777777777777',
    name: 'Riyadh Diesel Co',
    phone: '+966501234567',
    email: null,
    telegram: null,
    state: 'blocked',
    reason: 'no_consent',
    notBefore: null,
    messageId: '22222222-2222-2222-2222-222222222222',
    channel: 'sms',
    messageStatus: 'blocked',
    messageBlockedReason: 'no_channel',
    messageError: null,
    messageUpdatedAt: '2026-09-21T09:00:02.000Z',
  },
  {
    id: '88888888-8888-8888-8888-888888888888',
    name: 'Jeddah Transport',
    phone: '+966501234568',
    email: null,
    telegram: null,
    state: 'pending',
    reason: 'deferred:sa-marketing-sms-hours',
    notBefore: '2026-09-22T06:00:00.000Z',
    messageId: null,
    channel: null,
    messageStatus: null,
    messageBlockedReason: null,
    messageError: null,
    messageUpdatedAt: null,
  },
];

export const discoveryJobDetail: DiscoveryJobDetail = {
  job: {
    id: '99999999-9999-9999-9999-999999999999',
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantName: 'Acme',
    product: 'ديزل',
    category: 'Fuel',
    side: 'suppliers',
    countries: ['SA', 'AE'],
    terms: [],
    resultLimit: 50,
    status: 'done',
    counts: { ranked: 2 },
    createdAt: '2026-10-06T08:00:00.000Z',
    finishedAt: '2026-10-06T08:00:02.000Z',
  },
  tasks: [
    {
      id: 'a',
      country: 'SA',
      status: 'done',
      stage: 'rank',
      counts: { ranked: 2 },
      error: null,
      attempts: 1,
      createdAt: '2026-10-06T08:00:00.000Z',
      startedAt: '2026-10-06T08:00:01.000Z',
      finishedAt: '2026-10-06T08:00:02.000Z',
    },
    {
      id: 'b',
      country: 'AE',
      status: 'failed',
      stage: 'rank',
      counts: {},
      error: 'finder exploded',
      attempts: 4,
      createdAt: '2026-10-06T08:00:00.000Z',
      startedAt: '2026-10-06T08:00:01.000Z',
      finishedAt: '2026-10-06T08:00:02.000Z',
    },
  ],
};

export const discoveryJobs: DiscoveryJobRow[] = [discoveryJobDetail.job];

export const discoveryResults: DiscoveryResult[] = [
  {
    id: '1',
    rank: 1,
    score: 0.7,
    reasons: ['product: ديزل ~ توريد الديزل', 'profile: full', 'profiled 5 days ago'],
    country: 'SA',
    company: { id: 'c1', name: 'Riyadh Diesel', country: 'SA' },
    profile: {
      products: ['توريد الديزل'],
      roles: ['distributor'],
      cities: ['Riyadh'],
      quality: 'full',
      profiledAt: '2026-10-01T00:00:00.000Z',
    },
    identifiers: [{ type: 'domain', value: 'riyadh-diesel.com.sa' }],
  },
];

export const rowReading: RowReading = {
  product: 'Diesel fuel 20L',
  category: 'Fuel',
  cells: ['1042', 'Diesel fuel 20L', 'Fuel', '45.00 SAR'],
  header: ['ID', 'Product Name', 'Category', 'Price'],
  productIndex: 1,
  categoryIndex: 2,
};
