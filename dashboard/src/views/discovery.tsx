import { useEffect, useState } from 'preact/hooks';
import {
  ApiError,
  api,
  type DiscoveryJobDetail,
  type DiscoveryJobRow,
  type DiscoveryResult,
  type RowReading,
  type TenantRow,
} from '../api.js';
import { count } from '../format.js';
import { go, href } from '../router.js';
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

const STATUSES = ['planning', 'running', 'done', 'failed'];

/** How often a running job's page asks again. */
const LIVE_MS = 3000;

/** Said wherever a search's reach matters: it does not go to the web yet. */
const POOL_ONLY =
  'Until web search is switched on, a search ranks only the companies already in the pool, and a buyers search ranks nothing yet.';

type Filters = { tenantId: string; status: string };

export function DiscoveryView({
  tenantId,
  status,
  onFilters,
}: Filters & { onFilters: (next: Filters) => void }) {
  const [rows, setRows] = useState<DiscoveryJobRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const set = (patch: Partial<Filters>) => {
    setCursor(undefined);
    onFilters({ tenantId, status, ...patch });
  };

  const page = useAsync(
    async () => {
      const result = await api.discoveryJobs({ tenantId, status, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [tenantId, status, cursor],
    // Polling a later page would append it again; only the first page refreshes.
    cursor ? undefined : 10_000,
  );

  return (
    <>
      <div class="head">
        <h2>Discovery</h2>
        <button class="primary" onClick={() => go('/discovery/new')}>
          New search
        </button>
        <Stamp at={page.loadedAt} />
      </div>

      <div class="filters">
        <Field label="tenant id">
          <Text value={tenantId} placeholder="any" width={290} onChange={(v) => set({ tenantId: v })} />
        </Field>
        <Field label="status">
          <Select value={status} options={STATUSES} onChange={(v) => set({ status: v })} />
        </Field>
      </div>

      <Card>
        {page.state.status === 'loading' && rows.length === 0 ? <Loading what="searches" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="searches" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="searches yet" /> : null}
        {rows.length > 0 ? <JobTable rows={rows} /> : null}

        <Pager
          cursor={page.state.status === 'ok' ? page.state.data.nextCursor : null}
          onMore={() => setCursor(page.state.status === 'ok' ? (page.state.data.nextCursor ?? undefined) : undefined)}
        />
      </Card>
    </>
  );
}

function JobTable({ rows }: { rows: DiscoveryJobRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>created</th>
          <th>tenant</th>
          <th>product</th>
          <th>looking for</th>
          <th>countries</th>
          <th>status</th>
          <th class="num">ranked</th>
          <th>finished</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((j) => (
          <tr
            key={j.id}
            class="clickable"
            onClick={() => {
              window.location.hash = href(`/discovery/${j.id}`).slice(1);
            }}
          >
            <td>
              <Time iso={j.createdAt} relative />
            </td>
            <td>{j.tenantName}</td>
            <td>
              {j.identifiedName ?? j.product}
              {j.identifiedName ? <div class="muted">{j.product}</div> : null}
              {j.category ? <div class="muted">{j.category}</div> : null}
            </td>
            <td>{j.side}</td>
            <td class="mono">{j.countries.join(' ')}</td>
            <td>
              <Badge value={j.status} />
            </td>
            <td class="num">{j.counts['ranked'] === undefined ? '—' : count(j.counts['ranked'])}</td>
            <td>
              <Time iso={j.finishedAt} relative />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Start a search. A pasted row goes to the engine, which says what it reads
 * as the product and category; the operator can change both before running.
 */
export function NewDiscoveryView() {
  const tenants = useAsync(() => api.tenants({ limit: 500 }), []);

  const [tenantId, setTenantId] = useState('');
  const [side, setSide] = useState<'' | 'suppliers' | 'buyers'>('');
  const [row, setRow] = useState('');
  const [reading, setReading] = useState<RowReading | null>(null);
  const [product, setProduct] = useState('');
  const [category, setCategory] = useState('');
  const [countries, setCountries] = useState('SA');
  const [resultLimit, setResultLimit] = useState('50');
  const [busy, setBusy] = useState<'reading' | 'creating' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const tenantRows: TenantRow[] = tenants.state.status === 'ok' ? tenants.state.data.items : [];

  // One tenant needs no choosing.
  useEffect(() => {
    if (!tenantId && tenantRows.length === 1) setTenantId(tenantRows[0]!.id);
  }, [tenantRows.length]);

  const read = async () => {
    setBusy('reading');
    setError(null);
    try {
      const result = await api.readRow(row);
      setReading(result);
      setProduct(result.product);
      setCategory(result.category ?? '');
    } catch (err) {
      setReading(null);
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy('creating');
    setError(null);
    try {
      const created = await api.createDiscoveryJob({
        tenantId,
        side: side as 'suppliers' | 'buyers',
        ...(row.trim() ? { row } : {}),
        product,
        ...(category.trim() ? { category } : {}),
        // Split as typed; the engine checks and upper-cases the codes.
        countries: countries.split(/[\s,]+/).filter(Boolean),
        ...(resultLimit.trim() ? { resultLimit: Number(resultLimit) } : {}),
      });
      go(`/discovery/${created.job.id}`);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  return (
    <>
      <div class="head">
        <h2>New search</h2>
        <a href={href('/discovery')}>all searches</a>
      </div>

      <Card>
        <div class="form">
          <p class="muted">{POOL_ONLY}</p>

          <label>
            tenant
            {tenants.state.status === 'error' ? (
              <Failed error={tenants.state.error} what="tenants" />
            ) : (
              <select
                value={tenantId}
                onChange={(e) => setTenantId((e.target as HTMLSelectElement).value)}
              >
                <option value="">choose a tenant…</option>
                {tenantRows.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </label>

          <div>
            <div class="muted" style="font-size:11px;margin-bottom:4px">looking for</div>
            <div class="actions">
              <button
                class={side === 'suppliers' ? 'primary' : ''}
                aria-pressed={side === 'suppliers'}
                onClick={() => setSide('suppliers')}
              >
                Find suppliers
              </button>
              <button
                class={side === 'buyers' ? 'primary' : ''}
                aria-pressed={side === 'buyers'}
                onClick={() => setSide('buyers')}
              >
                Find buyers
              </button>
              <span class="muted">
                {side === 'suppliers'
                  ? 'companies that sell this product'
                  : side === 'buyers'
                    ? 'companies that would buy and use it'
                    : 'choose one'}
              </span>
            </div>
          </div>

          <label>
            a row from the portal's product table, with its header line if you have it
            <textarea
              value={row}
              placeholder={'ID\tProduct Name\tCategory\tPrice\n1042\tDiesel fuel 20L\tFuel\t45.00 SAR'}
              onInput={(e) => setRow((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <div class="actions">
            <button onClick={read} disabled={!row.trim() || busy !== null}>
              {busy === 'reading' ? 'reading…' : 'Read row'}
            </button>
            <span class="muted">or type the product below</span>
          </div>

          {reading ? <Reading reading={reading} /> : null}

          <label>
            product
            <input
              value={product}
              placeholder="ديزل"
              onInput={(e) => setProduct((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            category (optional label)
            <input value={category} onInput={(e) => setCategory((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            countries (ISO codes, comma or space separated)
            <input value={countries} onInput={(e) => setCountries((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            results per country
            <input
              value={resultLimit}
              inputMode="numeric"
              style="width:80px"
              onInput={(e) => setResultLimit((e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="actions">
            <button class="primary" onClick={create} disabled={!tenantId || !side || !product.trim() || busy !== null}>
              {busy === 'creating' ? 'starting…' : 'Search'}
            </button>
          </div>

          {error ? <WriteFailed error={error} /> : null}
        </div>
      </Card>
    </>
  );
}

/** The engine's reading of the row: every cell, with the ones it picked marked. */
function Reading({ reading }: { reading: RowReading }) {
  const label = (i: number) =>
    i === reading.productIndex ? 'product' : i === reading.categoryIndex ? 'category' : null;
  return (
    <div>
      <div class="muted">
        {reading.method === 'header' ? 'read by column name' : 'this is a guess from what the cells look like — check it'}
      </div>
      <div class="cells">
        {reading.cells.map((cell, i) => (
          <span
            key={i}
            class={label(i) ? 'cell picked' : 'cell'}
            title={reading.header?.[i] ?? undefined}
          >
            {label(i) ? <b>{label(i)}: </b> : null}
            {cell || <span class="muted">empty</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A refused write: the engine's own reason, verbatim. */
function WriteFailed({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : null;
  const body = error instanceof ApiError ? error.body : { message: String(error) };
  return (
    <div class="state error">
      <div>the engine refused{status ? ` — HTTP ${status}` : ''}</div>
      <pre>{JSON.stringify(body, null, 2)}</pre>
    </div>
  );
}

export function DiscoveryJobView({
  id,
  country,
  onCountry,
}: {
  id: string;
  country: string;
  onCountry: (country: string) => void;
}) {
  // Asked again every few seconds while the job runs, then left alone.
  const [live, setLive] = useState(true);
  const { state, loadedAt } = useAsync(() => api.discoveryJob(id), [id], live ? LIVE_MS : undefined);

  // The engine says whether the job can still change.
  const engineLive = state.status === 'ok' ? state.data.job.live : null;
  useEffect(() => {
    if (engineLive !== null) setLive(engineLive);
  }, [engineLive]);

  if (state.status === 'loading') return <Loading what="the search" />;
  if (state.status === 'error') return <Failed error={state.error} what="the search" />;

  return <DiscoveryJob detail={state.data} loadedAt={loadedAt} country={country} onCountry={onCountry} />;
}

export function DiscoveryJob({
  detail,
  loadedAt,
  country,
  onCountry,
}: {
  detail: DiscoveryJobDetail;
  loadedAt: Date | null;
  country: string;
  onCountry: (country: string) => void;
}) {
  const { job, tasks, personas } = detail;

  return (
    <>
      <div class="head">
        <h2>{job.identified?.name ?? job.product}</h2>
        <Badge value={job.status} />
        <span class="mono muted">{job.id}</span>
        <Stamp at={loadedAt} />
      </div>

      {job.waiting ? (
        <div class="banner">
          Waiting for the Claude usage limit to reset, until <Time iso={job.waiting.until} />. It carries on by
          itself.
        </div>
      ) : null}
      {job.error ? <div class="banner critical">{job.error}</div> : null}

      <div class="cards">
        <Card title="search">
          <table>
            <tbody>
              <Row k="tenant">
                <a href={href(`/tenants/${job.tenantId}`)}>{job.tenantName}</a>
              </Row>
              <Row k="looking for">{job.side === 'buyers' ? 'buyers of the product' : 'suppliers of the product'}</Row>
              <Row k="as entered">{job.product}</Row>
              <Row k="category">{job.category ?? <span class="muted">—</span>}</Row>
              <Row k="countries">
                <span class="mono">{job.countries.join(' ')}</span>
              </Row>
              <Row k="terms">
                {job.terms.length ? job.terms.join(', ') : <span class="muted">none yet</span>}
              </Row>
              <Row k="per country">{count(job.resultLimit)}</Row>
              <Row k="status">
                <Badge value={job.status} />
              </Row>
              <Row k="counts">
                <Counts counts={job.counts} />
              </Row>
              <Row k="created">
                <Time iso={job.createdAt} />
              </Row>
              <Row k="finished">
                <Time iso={job.finishedAt} />
              </Row>
            </tbody>
          </table>
        </Card>

        <Card title="product">
          {job.identified ? (
            <table>
              <tbody>
                <Row k="name">{job.identified.name}</Row>
                <Row k="Arabic">{job.identified.nameAr}</Row>
                <Row k="brand · model">
                  {[job.identified.brand, job.identified.model].filter(Boolean).join(' · ') || (
                    <span class="muted">—</span>
                  )}
                </Row>
                <Row k="category">{job.identified.category}</Row>
                <Row k="also called">{job.identified.aliases.join(' · ')}</Row>
                <Row k="what it is">{job.identified.description}</Row>
                <Row k="used for">{job.identified.uses.join(' · ')}</Row>
              </tbody>
            </table>
          ) : (
            <span class="muted">{job.status === 'planning' ? 'identifying…' : 'not identified (no Claude bridge)'}</span>
          )}
        </Card>

        <Card title={job.side === 'buyers' ? 'who would buy it' : 'who sells it'} wide>
          {personas.length ? (
            <table>
              <thead>
                <tr>
                  <th>persona</th>
                  <th>why</th>
                  <th>search terms</th>
                  <th>Maps keywords</th>
                  <th>signals on a website</th>
                </tr>
              </thead>
              <tbody>
                {personas.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      <div class="muted">{[...p.roles, ...p.sectors].join(', ')}</div>
                    </td>
                    <td>{p.description}</td>
                    <td>{p.searchTerms.join(' · ')}</td>
                    <td>{p.placesTerms.join(' · ')}</td>
                    <td>
                      <ul class="reasons">
                        {p.signals.map((signal) => (
                          <li key={signal}>{signal}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <span class="muted">{job.status === 'planning' ? 'working out who to look for…' : 'no personas'}</span>
          )}
        </Card>

        <Card title="tasks">
          <table>
            <thead>
              <tr>
                <th>country</th>
                <th>status</th>
                <th>stage</th>
                <th>counts</th>
                <th class="num">attempts</th>
                <th>finished</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td class="mono">{t.country}</td>
                  <td>
                    <Badge value={t.status} />
                    {t.error ? <div class="muted wrap-any">{t.error}</div> : null}
                    {t.waiting ? (
                      <div class="muted">
                        waiting until <Time iso={t.waiting.until} />
                      </div>
                    ) : null}
                  </td>
                  <td class="mono">{t.stage ?? <span class="muted">—</span>}</td>
                  <td>
                    <Counts counts={t.counts} />
                  </td>
                  <td class="num">{count(t.attempts)}</td>
                  <td>
                    <Time iso={t.finishedAt} relative />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="results" wide>
          <div class="filters">
            <Field label="country">
              <Select value={country} options={job.countries} onChange={onCountry} />
            </Field>
          </div>
          {/* Asked again whenever the job moves on, so results appear as tasks finish. */}
          <Results jobId={job.id} country={country} version={`${job.status}:${JSON.stringify(job.counts)}:${tasks.map((t) => t.status).join()}`} />
        </Card>
      </div>
    </>
  );
}

function Results({ jobId, country, version }: { jobId: string; country: string; version: string }) {
  const [rows, setRows] = useState<DiscoveryResult[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  useEffect(() => setCursor(undefined), [jobId, country, version]);

  // The rows are taken from the answer useAsync keeps, which is always the
  // latest request's: a slower stale page can never land on top of a fresh one.
  const answer = useAsync(
    async () => ({ used: cursor, result: await api.discoveryResults(jobId, { country, cursor, limit: 100 }) }),
    [jobId, country, cursor, version],
  );
  useEffect(() => {
    if (answer.state.status !== 'ok') return;
    const { used, result } = answer.state.data;
    setRows((current) => (used ? [...current, ...result.items] : result.items));
  }, [answer.state]);
  const page = {
    state:
      answer.state.status === 'ok'
        ? { status: 'ok' as const, data: answer.state.data.result }
        : answer.state,
  };

  return (
    <>
      {page.state.status === 'loading' && rows.length === 0 ? <Loading what="results" /> : null}
      {page.state.status === 'error' ? <Failed error={page.state.error} what="results" /> : null}
      {page.state.status === 'ok' && rows.length === 0 ? (
        <>
          <Empty what="results" />
          <p class="muted">{POOL_ONLY}</p>
        </>
      ) : null}

      {rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th class="num">rank</th>
              <th>company</th>
              <th>country</th>
              <th class="num">score</th>
              <th>why</th>
              <th>profile</th>
              <th>identifiers</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td class="num">{r.rank}</td>
                <td>
                  {r.company.name}
                  <div class="mono muted">{r.company.id}</div>
                </td>
                <td class="mono">{r.country}</td>
                <td class="num">{r.score.toFixed(2)}</td>
                <td>
                  <ul class="reasons">
                    {r.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </td>
                <td>
                  {r.profile ? (
                    <>
                      {r.profile.products.length ? <div>{r.profile.products.join(' · ')}</div> : null}
                      {r.profile.roles.length ? <div class="muted">{r.profile.roles.join(', ')}</div> : null}
                      {r.profile.cities.length ? <div class="muted">{r.profile.cities.join(', ')}</div> : null}
                      {r.profile.quality ? <Badge value={r.profile.quality} /> : null}
                    </>
                  ) : (
                    <span class="muted">—</span>
                  )}
                </td>
                <td>
                  {r.identifiers.length ? (
                    r.identifiers.map((i) => (
                      <div key={`${i.type}:${i.value}`} class="mono wrap-any">
                        <span class="muted">{i.type}</span> {i.value}
                      </div>
                    ))
                  ) : (
                    <span class="muted">—</span>
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

function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return <span class="muted">—</span>;
  return (
    <span>
      {entries.map(([k, v]) => (
        <span key={k} style="margin-right:8px">
          <span class="muted">{k}</span> {count(v)}
        </span>
      ))}
    </span>
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
