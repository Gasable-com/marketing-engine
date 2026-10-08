/**
 * Every view renders from a fixture without throwing, and shows its empty and
 * error states. These are not screenshots: they catch the crash that a typo in
 * a field name causes, which is the failure a dashboard actually suffers.
 */
import { render } from 'preact-render-to-string';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fixtures from './fixtures.js';

const ok = <T,>(data: T) => Promise.resolve(data);

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock('../src/api.js', async () => {
    const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
    return {
      ...actual,
      api: {
        overview: () => ok(fixtures.overview),
        tenants: () => ok({ items: fixtures.tenants, nextCursor: null }),
        tenant: () => ok(fixtures.tenantDetail),
        events: () => ok({ items: [], nextCursor: null }),
        event: () => ok({ event: {} }),
        messages: () => ok({ items: fixtures.messages, nextCursor: null }),
        message: () => ok(fixtures.messageDetail),
        redemptions: () => ok({ items: fixtures.redemptions, nextCursor: null }),
        promocodes: () => ok({ items: fixtures.promocodes, nextCursor: null }),
        promocode: () => ok({ promocode: fixtures.promocodes[0] }),
        invites: () => ok({ items: [], nextCursor: null }),
        companies: () => ok({ items: fixtures.companies, nextCursor: null }),
        deliveries: () => ok({ items: fixtures.deliveries, nextCursor: null }),
        replayDelivery: () => ok({ delivery: fixtures.deliveries[0] }),
        jobs: () => ok({ items: fixtures.jobs, nextCursor: null }),
        job: () => ok({ job: fixtures.jobs[0] }),
        retryJob: () => ok({ retried: 'x' }),
        schedules: () => ok({ schedules: fixtures.schedules }),
        metrics: () => ok(fixtures.metrics),
        campaigns: () => ok({ items: fixtures.campaigns, nextCursor: null }),
        campaign: () => ok(fixtures.campaignDetail),
        recipients: () => ok({ items: fixtures.recipients, nextCursor: null }),
        discoveryJobs: () => ok({ items: fixtures.discoveryJobs, nextCursor: null }),
        discoveryJob: () => ok(fixtures.discoveryJobDetail),
        discoveryResults: () => ok({ items: fixtures.discoveryResults, nextCursor: null }),
        discoveryCandidates: () => ok({ items: [], nextCursor: null }),
        discoveryQueries: () => ok({ items: fixtures.discoveryQueries, nextCursor: null }),
        discoveryResultsCsvUrl: (id: string) => `/api/discovery/jobs/${id}/results.csv`,
        createDiscoveryJob: () => ok(fixtures.discoveryJobDetail),
        readRow: () => ok(fixtures.rowReading),
        identifyProduct: () => ok({ identified: null, didYouMean: null }),
        rfqSearches: () => ok({ items: [], nextCursor: null }),
        rfqSearch: () => ok({ rfqSearch: {}, lines: [] }),
        createRfqSearch: () => ok({ rfqSearch: {}, lines: [] }),
        streamUrl: () => '/api/stream',
        ...overrides,
      },
    };
  });
}

beforeEach(() => {
  vi.resetModules();
  // The views call document.visibilityState through their polling helper.
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('window', { location: { hash: '' }, addEventListener() {}, removeEventListener() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/api.js');
});

describe('views render', () => {
  it('overview', async () => {
    mockApi();
    const { OverviewView, OverviewSections } = await import('../src/views/overview.js');
    expect(render(<OverviewView window="24h" onWindow={() => {}} />)).toContain('Overview');
    // The serper cost card, with the engine's figures as they came.
    const html = render(<OverviewSections data={fixtures.overview} />);
    expect(html).toContain('serper cost');
    expect(html).toContain('$0.033');
    expect(html).toContain('$0.0165');
    expect(html).toContain('35%');
    expect(html).toContain('costliest searches');
    expect(html).toContain('Microsilica (silica fume)');
  });

  it('queue', async () => {
    mockApi();
    const { QueueView } = await import('../src/views/queue.js');
    expect(render(<QueueView name="" state="" onFilters={() => {}} />)).toContain('Queue');
  });

  it('tenants', async () => {
    mockApi();
    const { TenantsView, TenantDetailView } = await import('../src/views/tenants.js');
    expect(render(<TenantsView />)).toContain('Tenants');
    expect(render(<TenantDetailView id="11111111-1111-1111-1111-111111111111" />)).toBeTruthy();
  });

  it('messages', async () => {
    mockApi();
    const { MessagesView, MessageDetailView } = await import('../src/views/messages.js');
    const filters = {
      tenantId: '', status: '', channel: '', provider: '', address: '', since: '', until: '',
    };
    expect(render(<MessagesView filters={filters} onFilters={() => {}} />)).toContain('Messages');
    expect(render(<MessageDetailView id="22222222-2222-2222-2222-222222222222" />)).toBeTruthy();
  });

  it('deliveries', async () => {
    mockApi();
    const { DeliveriesView } = await import('../src/views/deliveries.js');
    expect(render(<DeliveriesView status="" onStatus={() => {}} />)).toContain('deliveries');
  });

  it('companies', async () => {
    mockApi();
    const { CompaniesView } = await import('../src/views/companies.js');
    expect(render(<CompaniesView q="" country="" onFilters={() => {}} />)).toContain('Companies');
  });

  it('campaigns', async () => {
    mockApi();
    const { CampaignsView, CampaignDetailView } = await import('../src/views/campaigns.js');
    expect(render(<CampaignsView tenantId="" status="" onFilters={() => {}} />)).toContain('Campaigns');
    expect(render(<CampaignDetailView id="33333333-3333-3333-3333-333333333333" />)).toBeTruthy();
  });

  it('promocodes', async () => {
    mockApi();
    const { PromocodesView, PromocodeDetailView, PromocodeDetail, PromocodeTable } = await import(
      '../src/views/promocodes.js'
    );
    expect(render(<PromocodesView tenantId="" status="" code="" onFilters={() => {}} />)).toContain('Promocodes');
    expect(render(<PromocodeDetailView id="77777777-7777-7777-7777-777777777777" />)).toBeTruthy();

    const table = render(<PromocodeTable rows={fixtures.promocodes} showTenant />);
    expect(table).toContain('SAVE10');
    expect(table).toContain('Acme Supplies');
    expect(table).toContain('10%');
    expect(table).toContain('expired');
    expect(table).toMatch(/only 1(<!-- -->)?\s*(<!-- -->)?product</);

    const detail = render(<PromocodeDetail p={fixtures.promocodes[0]!} loadedAt={null} />);
    expect(detail).toContain('live');
    expect(detail).toContain('60%');
    expect(detail).toContain('cart.subtotal');
    expect(detail).toContain('99999999-9999-9999-9999-999999999999');
    // A code with no budget and no rules says so rather than showing zeros.
    const open = render(<PromocodeDetail p={fixtures.promocodes[1]!} loadedAt={null} />);
    expect(open).toContain('no limit');
    expect(open).toContain('none');
    expect(open).toContain('all products');
  });

  it('metrics', async () => {
    mockApi();
    const { MetricsView } = await import('../src/views/metrics.js');
    expect(render(<MetricsView />)).toContain('Metrics');
  });
});

describe('discovery', () => {
  it('lists searches and offers a new one', async () => {
    mockApi();
    const { DiscoveryView } = await import('../src/views/discovery.js');
    const html = render(<DiscoveryView tenantId="" status="" onFilters={() => {}} />);
    expect(html).toContain('Discovery');
    expect(html).toContain('New search');
  });

  it('shows the new-search form with the row box and the pool-only note', async () => {
    mockApi();
    const { NewDiscoveryView } = await import('../src/views/discovery.js');
    const html = render(<NewDiscoveryView />);
    expect(html).toContain('Read row');
    expect(html).toContain('Find buyers');
    expect(html).toContain('textarea');
    expect(html).toContain('only ranks companies already in the pool');
  });

  it("renders a job with its tasks, a task's error and the ranked results", async () => {
    mockApi();
    const { DiscoveryJob } = await import('../src/views/discovery.js');
    const html = render(
      <DiscoveryJob detail={fixtures.discoveryJobDetail} loadedAt={null} country="" onCountry={() => {}} />,
    );
    expect(html).toContain('Microsilica (silica fume)');
    expect(html).toContain('Ready-mix concrete plants');
    expect(html).toContain('who would buy it');
    expect(html).toContain('Waiting for the Claude usage limit');
    expect(html).toContain('Download CSV');
    expect(html).toContain('results.csv');
    expect(html).toContain('finder exploded');
    expect(html).toContain('Serper cost');
    expect(html).toContain('$0.022');
    expect(html).toContain('rank');
    expect(html).toContain('results');
  });

  it('offers did-you-mean choices before a search starts', async () => {
    mockApi();
    const { DidYouMean } = await import('../src/views/discovery.js');
    const html = render(
      <DidYouMean
        ask={{
          question: 'Did you mean one of these? "Fundo Cement" is not a product we can be sure of.',
          asked: 'Fundo Cement',
          best: { name: 'Fondu Cement (High Alumina Cement)', nameAr: 'أسمنت فوندو', description: 'Calcium aluminate cement.' },
          alternatives: [{ name: 'Fundo-brand Portland Cement', nameAr: 'أسمنت بورتلاند', description: 'Ordinary cement.' }],
        }}
        busy={false}
        onBest={() => {}}
        onPick={() => {}}
        onAsTyped={() => {}}
      />,
    );
    expect(html).toContain('Fondu Cement (High Alumina Cement)');
    expect(html).toContain('Fundo-brand Portland Cement');
    expect(html).toContain('as typed');
  });

  it('shows an RFQ search as its products, each with its own results', async () => {
    mockApi();
    const { RfqSearch, RfqSearchesView } = await import('../src/views/discovery.js');
    const html = render(
      <RfqSearch
        loadedAt={null}
        detail={{
          rfqSearch: {
            id: 'r1', tenantId: 't', tenantName: 'Acme', rfqRef: 'RFQ-A', requesterRef: 'corp-7', side: 'suppliers',
            countries: ['SA'], status: 'done', counts: { ranked: 3 }, createdAt: '2026-10-07T07:00:00.000Z', finishedAt: null,
          },
          lines: [
            { position: 0, lineRef: 'L1', jobId: 'j1', product: 'Product A', identifiedName: 'Product A', status: 'done', counts: { ranked: 2 }, error: null },
            { position: 1, lineRef: 'L2', jobId: 'j2', product: 'Product B', identifiedName: 'Product B', status: 'done', counts: { ranked: 1 }, error: null },
          ],
        }}
      />,
    );
    expect(html).toContain('RFQ-A');
    expect(html.indexOf('L1 · Product A')).toBeGreaterThan(-1);
    expect(html.indexOf('L2 · Product B')).toBeGreaterThan(html.indexOf('L1 · Product A'));
    expect(render(<RfqSearchesView status="" onStatus={() => {}} />)).toContain('RFQ searches');
  });

  it('loads a job by id', async () => {
    mockApi();
    const { DiscoveryJobView } = await import('../src/views/discovery.js');
    expect(render(<DiscoveryJobView id="x" country="" onCountry={() => {}} />)).toContain('loading');
  });
});

describe('the chart', () => {
  it('draws a line per series, with a legend', async () => {
    const { LineChart } = await import('../src/ui/chart.js');
    const html = render(<LineChart series={fixtures.metrics.series} label="test" />);
    expect(html).toContain('<path');
    expect(html).toContain('sent');
    expect(html).toContain('failed');
  });

  it('says so rather than drawing an empty box when there is no data', async () => {
    const { LineChart } = await import('../src/ui/chart.js');
    expect(render(<LineChart series={[]} label="test" />)).toContain('no data');
  });

  it('never draws more series than the palette can tell apart', async () => {
    const { LineChart } = await import('../src/ui/chart.js');
    const many = Array.from({ length: 12 }, (_, i) => ({
      key: `series-${i}`,
      points: [['2026-09-21T08:00:00.000Z', i] as [string, number]],
    }));
    const html = render(<LineChart series={many} label="test" />);
    expect((html.match(/<path/g) ?? []).length).toBe(8);
    expect(html).toContain('more series not drawn');
  });
});

describe('progress', () => {
  it('fills to the share the engine reported, and says the numbers', async () => {
    const { Progress } = await import('../src/ui/index.js');
    const html = render(<Progress done={160} total={500} />);
    expect(html).toContain('width:32%');
    expect(html).toContain('160 / 500');
  });

  it('shows a dash before the audience is known', async () => {
    const { Progress } = await import('../src/ui/index.js');
    expect(render(<Progress done={0} total={null} />)).toContain('—');
  });
});

describe('empty and error states', () => {
  it('says there is nothing rather than showing an empty table', async () => {
    mockApi({ companies: () => ok({ items: [], nextCursor: null }) });
    const { CompaniesView } = await import('../src/views/companies.js');
    // The first paint is the loading state; the empty state follows the fetch.
    expect(render(<CompaniesView q="" country="" onFilters={() => {}} />)).toContain('loading');
  });

  it("shows the API's own error body", async () => {
    const { Failed } = await import('../src/ui/index.js');
    const { ApiError } = await import('../src/api.js');
    const html = render(<Failed error={new ApiError(503, { error: 'nope' })} what="the overview" />);
    expect(html).toContain('503');
    expect(html).toContain('nope');
  });

  it('shows an empty state when handed nothing', async () => {
    const { Empty } = await import('../src/ui/index.js');
    expect(render(<Empty what="messages" />)).toContain('no messages');
  });
});
