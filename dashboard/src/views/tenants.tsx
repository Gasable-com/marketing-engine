import { useState } from 'preact/hooks';
import { api, type TenantDetail, type TenantRow } from '../api.js';
import { count, money } from '../format.js';
import { href } from '../router.js';
import { Badge, Card, Empty, Failed, Loading, Pager, Stamp, Time, useAsync } from '../ui/index.js';
import { PromocodeTable } from './promocodes.js';

export function TenantsView() {
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const page = useAsync(
    async () => {
      const result = await api.tenants({ cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [cursor],
  );

  return (
    <>
      <div class="head">
        <h2>Tenants</h2>
        <Stamp at={page.loadedAt} />
      </div>

      <Card>
        {page.state.status === 'loading' && rows.length === 0 ? <Loading what="tenants" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="tenants" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="tenants" /> : null}

        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>marketplace ref</th>
                <th>created</th>
                <th class="num">sent 24h</th>
                <th class="num">failed 24h</th>
                <th class="num">blocked 24h</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <a href={href(`/tenants/${t.id}`)}>{t.name}</a>
                  </td>
                  <td class="mono">{t.externalRef ?? '—'}</td>
                  <td>
                    <Time iso={t.createdAt} relative />
                  </td>
                  <td class="num">{count(t.messages?.sent ?? 0)}</td>
                  <td class="num">{count(t.messages?.failed ?? 0)}</td>
                  <td class="num">{count(t.messages?.blocked ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <Pager
          cursor={page.state.status === 'ok' ? page.state.data.nextCursor : null}
          onMore={() => setCursor(page.state.status === 'ok' ? (page.state.data.nextCursor ?? undefined) : undefined)}
        />
      </Card>
    </>
  );
}

const TABS = ['messages', 'promocodes', 'redemptions', 'invites', 'deliveries'] as const;
type Tab = (typeof TABS)[number];

export function TenantDetailView({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>('messages');
  const { state } = useAsync<TenantDetail>(() => api.tenant(id), [id]);

  if (state.status === 'loading') return <Loading what="the tenant" />;
  if (state.status === 'error') return <Failed error={state.error} what="the tenant" />;

  const { tenant, channels, templates, rules, webhooks, counts } = state.data;

  return (
    <>
      <div class="head">
        <h2>{tenant.name}</h2>
        <span class="mono muted">{tenant.id}</span>
      </div>

      <div class="cards">
        {Object.entries(counts).map(([window, c]) => (
          <Card key={window} title={window}>
            <div class="stat-row">
              {c
                ? Object.entries(c.messages).map(([k, v]) => <Stat2 key={k} k={k} v={v as number} />)
                : <span class="muted">no data</span>}
            </div>
          </Card>
        ))}

        <Card title="channels" wide>
          {channels.length === 0 ? (
            <Empty what="configured channels" />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>channel</th>
                  <th>provider</th>
                  <th>sender</th>
                  <th>unsubscribe text</th>
                  <th>updated</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel}>
                    <td>{c.channel}</td>
                    <td>{c.provider}</td>
                    <td class="mono">{c.sender}</td>
                    <td class="muted">{c.unsubscribeText ?? '—'}</td>
                    <td>
                      <Time iso={c.updatedAt} relative />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="templates">
          {templates.length === 0 ? (
            <Empty what="templates" />
          ) : (
            <table>
              <tbody>
                {templates.map((t) => (
                  <tr key={`${t.name}-${t.channel}`}>
                    <td>{t.name}</td>
                    <td class="muted">{t.channel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="rules">
          {Object.keys(rules).length === 0 ? (
            <Empty what="tenant rules" />
          ) : (
            <table>
              <tbody>
                {Object.entries(rules).map(([kind, n]) => (
                  <tr key={kind}>
                    <td>{kind}</td>
                    <td class="num">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="webhook endpoints" wide>
          {webhooks.length === 0 ? (
            <Empty what="endpoints" />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>url</th>
                  <th>events</th>
                  <th>active</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id}>
                    <td class="mono wrap-any">{w.url}</td>
                    <td class="muted">{w.eventTypes.length ? w.eventTypes.join(', ') : 'all'}</td>
                    <td>
                      <Badge value={w.active ? 'active' : 'cancelled'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div class="tabs">
        {TABS.map((t) => (
          <button key={t} aria-selected={t === tab} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <Card>
        <TenantTab tab={tab} tenantId={id} />
      </Card>
    </>
  );
}

function Stat2({ k, v }: { k: string; v: number }) {
  return (
    <div class="stat">
      <div class="n">{count(v)}</div>
      <div class="k">{k}</div>
    </div>
  );
}

function TenantTab({ tab, tenantId }: { tab: Tab; tenantId: string }) {
  const { state } = useAsync(async () => {
    if (tab === 'messages') return api.messages({ tenantId, limit: 50 });
    if (tab === 'promocodes') return api.promocodes({ tenantId, limit: 50 });
    if (tab === 'redemptions') return api.redemptions({ tenantId, limit: 50 });
    if (tab === 'invites') return api.invites({ tenantId, limit: 50 });
    return api.deliveries({ tenantId, limit: 50 });
  }, [tab, tenantId]);

  if (state.status === 'loading') return <Loading what={tab} />;
  if (state.status === 'error') return <Failed error={state.error} what={tab} />;
  if (state.data.items.length === 0) return <Empty what={tab} />;

  if (tab === 'messages') {
    const items = state.data.items as import('../api.js').MessageRow[];
    return (
      <table>
        <thead>
          <tr><th>when</th><th>channel</th><th>to</th><th>status</th></tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td><Time iso={m.createdAt} relative /></td>
              <td>{m.channel}</td>
              <td class="mono wrap-any"><a href={href(`/messages/${m.id}`)}>{m.address}</a></td>
              <td><Badge value={m.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (tab === 'promocodes') {
    return <PromocodeTable rows={state.data.items as import('../api.js').PromocodeRow[]} />;
  }

  if (tab === 'redemptions') {
    const items = state.data.items as import('../api.js').RedemptionRow[];
    return (
      <table>
        <thead>
          <tr><th>reserved</th><th>code</th><th>buyer</th><th>order</th><th class="num">discount</th><th>status</th></tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td><Time iso={r.reservedAt} relative /></td>
              <td class="mono">
                <a href={href(`/promocodes/${r.promocodeId}`)}>{r.code}</a>
              </td>
              <td class="mono wrap-any">
                {r.buyerRef}
                {r.buyerCompanyRef ? <div class="muted">{r.buyerCompanyRef}</div> : null}
              </td>
              <td class="mono">{r.orderRef}</td>
              <td class="num">{money(r.discountAmount, r.currency)}</td>
              <td><Badge value={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (tab === 'invites') {
    const items = state.data.items as import('../api.js').InviteRow[];
    return (
      <table>
        <thead>
          <tr><th>sent</th><th>company</th><th>status</th><th>from search</th></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td><Time iso={i.createdAt} relative /></td>
              <td>{i.companyName}</td>
              <td><Badge value={i.status} /></td>
              <td class="muted">{i.finderRunId ? `run ${i.finderRunId}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const items = state.data.items as import('../api.js').DeliveryRow[];
  return (
    <table>
      <thead>
        <tr><th>when</th><th>event</th><th>url</th><th>status</th><th class="num">attempt</th></tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id}>
            <td><Time iso={d.createdAt} relative /></td>
            <td>{d.eventType}</td>
            <td class="mono wrap-any">{d.url}</td>
            <td><Badge value={d.status} /></td>
            <td class="num">{d.attempt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
