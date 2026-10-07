import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { go, href, section, useRoute } from './router.js';
import { useAsync } from './ui/index.js';
import { CampaignDetailView, CampaignsView } from './views/campaigns.js';
import { CompaniesView } from './views/companies.js';
import { DeliveriesView } from './views/deliveries.js';
import { DiscoveryJobView, DiscoveryView, NewDiscoveryView } from './views/discovery.js';
import { LiveView } from './views/live.js';
import { MessageDetailView, MessagesView, type MessageFilters } from './views/messages.js';
import { MetricsView } from './views/metrics.js';
import { OverviewView } from './views/overview.js';
import { PromocodeDetailView, PromocodesView } from './views/promocodes.js';
import { QueueView } from './views/queue.js';
import { TenantDetailView, TenantsView } from './views/tenants.js';

const NAV = [
  ['/overview', 'Overview'],
  ['/live', 'Live'],
  ['/queue', 'Queue'],
  ['/tenants', 'Tenants'],
  ['/messages', 'Messages'],
  ['/campaigns', 'Campaigns'],
  ['/promocodes', 'Promocodes'],
  ['/deliveries', 'Deliveries'],
  ['/metrics', 'Metrics'],
  ['/companies', 'Companies'],
  ['/discovery', 'Discovery'],
] as const;

const STREAM_WARN_MS = 30_000;

export function App() {
  const route = useRoute();
  const [unauthorized, setUnauthorized] = useState(false);
  const [disconnectedAt, setDisconnectedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // The version is also the cheapest check that the API is reachable at all.
  const health = useAsync(() => api.overview('24h'), [], 60_000);

  useEffect(() => {
    // A 401 means basic auth lapsed; every other failure is shown by the view
    // that hit it.
    if (health.state.status === 'error') {
      const status = (health.state.error as { status?: number }).status;
      setUnauthorized(status === 401);
    } else if (health.state.status === 'ok') {
      setUnauthorized(false);
    }
  }, [health.state.status]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const streamDown = disconnectedAt !== null && now - disconnectedAt > STREAM_WARN_MS;
  const version = health.state.status === 'ok' ? health.state.data.health.version : null;

  return (
    <>
      {unauthorized ? (
        <div class="banner critical">
          The API answered 401. Your sign-in has probably expired — reload the page to sign in
          again.
        </div>
      ) : null}
      {streamDown ? (
        <div class="banner">
          The live stream has been disconnected for more than 30 seconds. It keeps retrying; events
          are not lost, they are replayed when it reconnects.
        </div>
      ) : null}

      <div class="shell">
        <nav class="nav">
          <h1>marketing engine</h1>
          {NAV.map(([path, label]) => (
            <a
              key={path}
              href={href(path)}
              aria-current={section(route.path) === path ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
          <div class="foot">
            {version ? `engine ${version}` : 'engine —'}
            <br />
            operator view
          </div>
        </nav>

        <main class="main">
          <View route={route} onStreamState={setDisconnectedAt} />
        </main>
      </div>
    </>
  );
}

function View({
  route,
  onStreamState,
}: {
  route: ReturnType<typeof useRoute>;
  onStreamState: (since: number | null) => void;
}) {
  const { path, query } = route;
  const q = (k: string) => query.get(k) ?? '';

  if (path.startsWith('/messages/')) {
    return <MessageDetailView id={path.slice('/messages/'.length)} />;
  }
  if (path.startsWith('/campaigns/')) {
    return <CampaignDetailView id={path.slice('/campaigns/'.length)} />;
  }
  if (path.startsWith('/promocodes/')) {
    return <PromocodeDetailView id={path.slice('/promocodes/'.length)} />;
  }
  if (path === '/discovery/new') return <NewDiscoveryView />;
  if (path.startsWith('/discovery/')) {
    const id = path.slice('/discovery/'.length);
    return (
      <DiscoveryJobView
        id={id}
        country={q('country')}
        onCountry={(country) => go(`/discovery/${id}`, { country })}
      />
    );
  }
  if (path.startsWith('/tenants/')) {
    return <TenantDetailView id={path.slice('/tenants/'.length)} />;
  }

  switch (path) {
    case '/overview':
      return (
        <OverviewView
          window={q('window') || '24h'}
          onWindow={(w) => go('/overview', { window: w })}
        />
      );
    case '/live':
      return (
        <LiveView
          tenantId={q('tenantId')}
          type={q('type')}
          onFilters={(next) => go('/live', next)}
          onDisconnected={onStreamState}
        />
      );
    case '/queue':
      return (
        <QueueView
          name={q('name')}
          state={q('state')}
          onFilters={(next) => go('/queue', next)}
        />
      );
    case '/tenants':
      return <TenantsView />;
    case '/messages': {
      const filters: MessageFilters = {
        tenantId: q('tenantId'),
        status: q('status'),
        channel: q('channel'),
        provider: q('provider'),
        address: q('address'),
        since: q('since'),
        until: q('until'),
      };
      return <MessagesView filters={filters} onFilters={(next) => go('/messages', next)} />;
    }
    case '/campaigns':
      return (
        <CampaignsView
          tenantId={q('tenantId')}
          status={q('status')}
          onFilters={(next) => go('/campaigns', next)}
        />
      );
    case '/promocodes':
      return (
        <PromocodesView
          tenantId={q('tenantId')}
          status={q('status')}
          code={q('code')}
          onFilters={(next) => go('/promocodes', next)}
        />
      );
    case '/deliveries':
      return (
        <DeliveriesView status={q('status')} onStatus={(s) => go('/deliveries', { status: s })} />
      );
    case '/metrics':
      return <MetricsView />;
    case '/discovery':
      return (
        <DiscoveryView
          tenantId={q('tenantId')}
          status={q('status')}
          onFilters={(next) => go('/discovery', next)}
        />
      );
    case '/companies':
      return (
        <CompaniesView
          q={q('q')}
          country={q('country')}
          onFilters={(next) => go('/companies', next)}
        />
      );
    default:
      return <div class="state">no such view</div>;
  }
}
