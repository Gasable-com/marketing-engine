import { useState } from 'preact/hooks';
import { api, type PromocodeRow, type RedemptionRow } from '../api.js';
import { count, discount, money } from '../format.js';
import { href } from '../router.js';
import {
  Badge,
  Card,
  Empty,
  Failed,
  Field,
  Loading,
  Pager,
  Select,
  Stamp,
  Text,
  Time,
  useAsync,
} from '../ui/index.js';

const STATUSES = ['active', 'paused', 'ended'];

type Filters = { tenantId: string; status: string; code: string };

export function PromocodesView({
  tenantId,
  status,
  code,
  onFilters,
}: Filters & { onFilters: (next: Filters) => void }) {
  const [rows, setRows] = useState<PromocodeRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const set = (patch: Partial<Filters>) => {
    setCursor(undefined);
    onFilters({ tenantId, status, code, ...patch });
  };

  const page = useAsync(
    async () => {
      const result = await api.promocodes({ tenantId, status, code, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [tenantId, status, code, cursor],
  );

  return (
    <>
      <div class="head">
        <h2>Promocodes</h2>
        <Stamp at={page.loadedAt} />
      </div>

      <div class="filters">
        <Field label="tenant id">
          <Text value={tenantId} placeholder="any" width={290} onChange={(v) => set({ tenantId: v })} />
        </Field>
        <Field label="status">
          <Select value={status} options={STATUSES} onChange={(v) => set({ status: v })} />
        </Field>
        <Field label="code">
          <Text value={code} placeholder="starts with" onChange={(v) => set({ code: v })} />
        </Field>
      </div>

      <Card>
        {page.state.status === 'loading' && rows.length === 0 ? <Loading what="promocodes" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="promocodes" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="promocodes" /> : null}
        {rows.length > 0 ? <PromocodeTable rows={rows} showTenant /> : null}

        <Pager
          cursor={page.state.status === 'ok' ? page.state.data.nextCursor : null}
          onMore={() => setCursor(page.state.status === 'ok' ? (page.state.data.nextCursor ?? undefined) : undefined)}
        />
      </Card>
    </>
  );
}

/** Also the tenant detail's promocodes tab. */
export function PromocodeTable({ rows, showTenant }: { rows: PromocodeRow[]; showTenant?: boolean }) {
  return (
    <table>
      <thead>
        <tr>
          <th>code</th>
          {showTenant ? <th>tenant</th> : null}
          <th>discount</th>
          <th>availability</th>
          <th class="num">uses</th>
          <th class="num">spend</th>
          <th>valid</th>
          <th>last redeemed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr
            key={p.id}
            class="clickable"
            onClick={() => {
              window.location.hash = href(`/promocodes/${p.id}`).slice(1);
            }}
          >
            <td class="mono">{p.code}</td>
            {showTenant ? <td>{p.tenantName}</td> : null}
            <td>
              {discount(p.discount, p.currency)}
              {p.discount.productIds?.length ? (
                <div class="muted">
                  only {count(p.discount.productIds.length)}{' '}
                  {p.discount.productIds.length === 1 ? 'product' : 'products'}
                </div>
              ) : null}
            </td>
            <td>
              <Badge value={p.availability} />
            </td>
            <td class="num">
              {count(p.usage.uses)}
              {p.budget.maxUses !== undefined ? <span class="muted"> / {count(p.budget.maxUses)}</span> : null}
            </td>
            <td class="num">
              {money(p.usage.spend, p.currency)}
              {p.budget.maxSpend !== undefined ? (
                <div class="muted">of {money(p.budget.maxSpend, p.currency)}</div>
              ) : null}
            </td>
            <td>
              <Time iso={p.startsAt} /> – <Time iso={p.endsAt} />
            </td>
            <td>
              <Time iso={p.usage.lastRedeemedAt} relative />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PromocodeDetailView({ id }: { id: string }) {
  const { state, loadedAt } = useAsync(() => api.promocode(id), [id]);

  if (state.status === 'loading') return <Loading what="the promocode" />;
  if (state.status === 'error') return <Failed error={state.error} what="the promocode" />;

  return <PromocodeDetail p={state.data.promocode} loadedAt={loadedAt} />;
}

export function PromocodeDetail({ p, loadedAt }: { p: PromocodeRow; loadedAt: Date | null }) {
  const { usage, budget } = p;
  const limit = (n: number | undefined, show: (n: number) => string) =>
    n === undefined ? <span class="muted">no limit</span> : show(n);
  const remaining = (n: number | null, show: (n: number) => string) =>
    n === null ? <span class="muted">—</span> : show(n);
  const amount = (n: number) => money(n, p.currency);

  return (
    <>
      <div class="head">
        <h2 class="mono">{p.code}</h2>
        <Badge value={p.availability} />
        <span class="mono muted">{p.id}</span>
        <Stamp at={loadedAt} />
      </div>

      <div class="cards">
        <Card title="code">
          <table>
            <tbody>
              <Row k="tenant">
                <a href={href(`/tenants/${p.tenantId}`)}>{p.tenantName}</a>
              </Row>
              <Row k="discount">{discount(p.discount, p.currency)}</Row>
              <Row k="products">
                {p.discount.productIds?.length ? (
                  p.discount.productIds.map((id) => (
                    <div key={id} class="mono wrap-any">
                      {id}
                    </div>
                  ))
                ) : (
                  <span class="muted">all products</span>
                )}
              </Row>
              <Row k="currency">{p.currency}</Row>
              <Row k="status">
                <Badge value={p.status} />
              </Row>
              <Row k="availability">
                <Badge value={p.availability} />
              </Row>
              <Row k="starts">
                <Time iso={p.startsAt} />
              </Row>
              <Row k="ends">{p.endsAt ? <Time iso={p.endsAt} /> : <span class="muted">never</span>}</Row>
              <Row k="created">
                <Time iso={p.createdAt} />
              </Row>
              <Row k="updated">
                <Time iso={p.updatedAt} />
              </Row>
            </tbody>
          </table>
        </Card>

        <Card title="budget and usage">
          <table>
            <tbody>
              <Row k="uses">
                {count(usage.uses)} <span class="muted">of {limit(budget.maxUses, count)}</span>
              </Row>
              <Row k="uses left">{remaining(usage.remainingUses, count)}</Row>
              <Row k="spend">
                {amount(usage.spend)} <span class="muted">of {limit(budget.maxSpend, amount)}</span>
              </Row>
              <Row k="spend left">{remaining(usage.remainingSpend, amount)}</Row>
              <Row k="per buyer">{limit(budget.perBuyerMaxUses, (n) => `${count(n)} uses`)}</Row>
              <Row k="buyers">{count(usage.buyers)}</Row>
              <Row k="reserved">
                {count(usage.reserved.count)} · {amount(usage.reserved.amount)}
              </Row>
              <Row k="settled">
                {count(usage.settled.count)} · {amount(usage.settled.amount)}
              </Row>
              <Row k="released">
                {count(usage.released.count)} · {amount(usage.released.amount)}
              </Row>
              <Row k="last redeemed">
                <Time iso={usage.lastRedeemedAt} />
              </Row>
            </tbody>
          </table>
        </Card>

        <Card title="funders">
          <table>
            <thead>
              <tr>
                <th>party</th>
                <th class="num">share</th>
              </tr>
            </thead>
            <tbody>
              {p.funders.map((f) => (
                <tr key={f.party}>
                  <td class="mono wrap-any">{f.party}</td>
                  <td class="num">
                    {(f.share * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="rules">
          {p.rules === null ? <span class="muted">none</span> : <pre class="raw">{JSON.stringify(p.rules, null, 2)}</pre>}
        </Card>

        <Card title="redemptions" wide>
          <Redemptions promocodeId={p.id} since={p.createdAt} />
        </Card>
      </div>
    </>
  );
}

function Redemptions({ promocodeId, since }: { promocodeId: string; since: string }) {
  const [rows, setRows] = useState<RedemptionRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  // `since` is the code's own creation, so the feed's default window hides nothing.
  const page = useAsync(
    async () => {
      const result = await api.redemptions({ promocodeId, since, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [promocodeId, since, cursor],
  );

  return (
    <>
      {page.state.status === 'loading' && rows.length === 0 ? <Loading what="redemptions" /> : null}
      {page.state.status === 'error' ? <Failed error={page.state.error} what="redemptions" /> : null}
      {page.state.status === 'ok' && rows.length === 0 ? <Empty what="redemptions" /> : null}

      {rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>reserved</th>
              <th>buyer</th>
              <th>order</th>
              <th class="num">discount</th>
              <th>status</th>
              <th>settled / released</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Time iso={r.reservedAt} />
                </td>
                <td class="mono wrap-any">{r.buyerRef}</td>
                <td class="mono wrap-any">{r.orderRef}</td>
                <td class="num">{money(r.discountAmount, r.currency)}</td>
                <td>
                  <Badge value={r.status} />
                </td>
                <td>
                  {r.settledAt ? (
                    <Time iso={r.settledAt} />
                  ) : r.releasedAt ? (
                    <>
                      <Time iso={r.releasedAt} />
                      {r.releaseReason ? <div class="muted">{r.releaseReason}</div> : null}
                    </>
                  ) : (
                    <span class="muted">expires <Time iso={r.expiresAt} relative /></span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <Pager
        cursor={page.state.status === 'ok' ? page.state.data.nextCursor : null}
        onMore={() => setCursor(page.state.status === 'ok' ? (page.state.data.nextCursor ?? undefined) : undefined)}
      />
    </>
  );
}

function Row({ k, children }: { k: string; children: preact.ComponentChildren }) {
  return (
    <tr>
      <td class="muted" style="width:120px">
        {k}
      </td>
      <td>{children}</td>
    </tr>
  );
}
