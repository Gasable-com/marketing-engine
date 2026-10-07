import { useEffect, useState } from 'preact/hooks';
import {
  ApiError,
  api,
  type CountryRow,
  type DiscoveryJobDetail,
  type DiscoveryCandidate,
  type DiscoveryJobRow,
  type DiscoveryResult,
  type NewDiscoveryJob,
  type ProductIdentification,
  type RfqSearchDetail,
  type RfqSearchRow,
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
  'Without the search providers switched on, a search only ranks companies already in the pool by their profiles.';

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
        <a class="button" href={href('/discovery/rfq')}>
          RFQ searches
        </a>
        <a class="button" href={href('/discovery/countries')}>
          Countries
        </a>
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
  // One product, or an RFQ with several: one search, results split by product.
  const [mode, setMode] = useState<'product' | 'rfq'>('product');
  const [rfqRef, setRfqRef] = useState('');
  const [rfqLines, setRfqLines] = useState('');
  const [busy, setBusy] = useState<'reading' | 'identifying' | 'creating' | null>(null);
  const [ask, setAsk] = useState<ProductIdentification | null>(null);
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

  /** Create the search, with whatever the operator confirmed. */
  const create = async (extra: Pick<NewDiscoveryJob, 'identified' | 'confirmed'> & { product?: string } = {}) => {
    setBusy('creating');
    setError(null);
    try {
      const created = await api.createDiscoveryJob({
        tenantId,
        side: side as 'suppliers' | 'buyers',
        ...(row.trim() ? { row } : {}),
        product: extra.product ?? product,
        ...(category.trim() ? { category } : {}),
        // Split as typed; the engine checks and upper-cases the codes.
        countries: countries.split(/[\s,]+/).filter(Boolean),
        ...(resultLimit.trim() ? { resultLimit: Number(resultLimit) } : {}),
        ...(extra.identified ? { identified: extra.identified } : {}),
        ...(extra.confirmed ? { confirmed: true } : {}),
      });
      go(`/discovery/${created.job.id}`);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  /** An RFQ search: one product per line, typed or pasted. */
  const createRfq = async () => {
    setBusy('creating');
    setError(null);
    try {
      const created = await api.createRfqSearch({
        tenantId,
        side: side as 'suppliers' | 'buyers',
        ...(rfqRef.trim() ? { rfqRef: rfqRef.trim() } : {}),
        countries: countries.split(/[\s,]+/).filter(Boolean),
        ...(resultLimit.trim() ? { resultLimit: Number(resultLimit) } : {}),
        lines: rfqLines
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((product, i) => ({ product, lineRef: `L${i + 1}` })),
      });
      go(`/discovery/rfq/${String(created.rfqSearch.id)}`);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  /**
   * Search: first what the product is. When the engine is sure, the search
   * starts with its reading; when not, it asks "did you mean" here, before
   * anything is searched. If identifying fails, the product is searched as typed.
   */
  const search = async () => {
    setBusy('identifying');
    setError(null);
    setAsk(null);
    let answer: ProductIdentification;
    try {
      answer = await api.identifyProduct({
        product,
        ...(category.trim() ? { category } : {}),
        ...(row.trim() ? { row } : {}),
      });
    } catch {
      await create();
      return;
    }
    if (answer.didYouMean) {
      setAsk(answer);
      setBusy(null);
      return;
    }
    await create(answer.identified ? { identified: answer.identified } : {});
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

          <div class="actions">
            <button class={mode === 'product' ? 'primary' : ''} aria-pressed={mode === 'product'} onClick={() => setMode('product')}>
              One product
            </button>
            <button class={mode === 'rfq' ? 'primary' : ''} aria-pressed={mode === 'rfq'} onClick={() => setMode('rfq')}>
              RFQ (several products)
            </button>
          </div>

          {mode === 'product' ? (
            <>
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
            </>
          ) : (
            <>
              <label>
                RFQ reference (optional)
                <input value={rfqRef} placeholder="RFQ-2026-0142" onInput={(e) => setRfqRef((e.target as HTMLInputElement).value)} />
              </label>
              <label>
                the RFQ's products, one per line
                <textarea
                  value={rfqLines}
                  placeholder={'Calcium Hypochlorite 70% Granular - 45 kg Drum\nDiesel fuel\nLPG cylinders 12 kg'}
                  onInput={(e) => setRfqLines((e.target as HTMLTextAreaElement).value)}
                />
              </label>
            </>
          )}

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
            <button
              class="primary"
              onClick={mode === 'rfq' ? createRfq : search}
              disabled={!tenantId || !side || busy !== null || (mode === 'rfq' ? !rfqLines.trim() : !product.trim())}
            >
              {busy === 'identifying' ? 'understanding your product…' : busy === 'creating' ? 'starting…' : 'Search'}
            </button>
          </div>

          {ask?.didYouMean ? (
            <DidYouMean
              ask={ask.didYouMean}
              busy={busy !== null}
              onBest={() => create(ask.identified ? { identified: ask.identified } : { confirmed: true })}
              onPick={(name) => create({ product: name, confirmed: true })}
              onAsTyped={() => create({ confirmed: true })}
            />
          ) : null}

          {error ? <WriteFailed error={error} /> : null}
        </div>
      </Card>
    </>
  );
}

/** "Did you mean": the engine's best reading, its other readings, and the words as typed. */
export function DidYouMean({
  ask,
  busy,
  onBest,
  onPick,
  onAsTyped,
}: {
  ask: NonNullable<ProductIdentification['didYouMean']>;
  busy: boolean;
  onBest: () => void;
  onPick: (name: string) => void;
  onAsTyped: () => void;
}) {
  const option = (o: { name: string; nameAr: string; description: string }, onClick: () => void) => (
    <div key={o.name} class="actions">
      <button class="primary" disabled={busy} onClick={onClick}>
        {o.name}
      </button>
      <span>
        {o.nameAr ? <span class="muted">{o.nameAr} · </span> : null}
        {o.description}
      </span>
    </div>
  );
  return (
    <div class="banner">
      <p>{ask.question}</p>
      {ask.best ? option(ask.best, onBest) : null}
      {ask.alternatives.map((a) => option(a, () => onPick(a.name)))}
      <div class="actions">
        <button disabled={busy} onClick={onAsTyped}>
          Search “{ask.asked}” as typed
        </button>
      </div>
    </div>
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
/**
 * How each country is searched. Rows come seeded (SA, AE), made by Claude the
 * first time a job searches a country, or set here; saving replaces the row
 * and the next search in that country uses it.
 */
export function CountriesView() {
  const page = useAsync(() => api.discoveryCountries(), []);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <>
      <div class="head">
        <h2>Countries</h2>
        <a class="button" href={href('/discovery')}>
          Searches
        </a>
        <Stamp at={page.loadedAt} />
      </div>
      <p class="muted">
        A country searched for the first time gets its languages, names and cities from Claude, saved here. Correct
        them if they are wrong; the next search in that country uses what you save.
      </p>
      <Card>
        {page.state.status === 'loading' ? <Loading what="countries" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="countries" /> : null}
        {page.state.status === 'ok' && page.state.data.items.length === 0 ? <Empty what="countries yet" /> : null}
        {page.state.status === 'ok' && page.state.data.items.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>country</th>
                <th>languages</th>
                <th>cities</th>
                <th>row</th>
                <th>created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.state.data.items.map((row) => (
                <CountryLine
                  key={row.code}
                  row={row}
                  open={editing === row.code}
                  onToggle={() => setEditing(editing === row.code ? null : row.code)}
                  onSaved={() => {
                    setEditing(null);
                    page.refresh();
                  }}
                />
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}

function CountryLine({
  row,
  open,
  onToggle,
  onSaved,
}: {
  row: CountryRow;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(row.settings, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveDiscoveryCountry(row.code, JSON.parse(text));
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr>
        <td>
          <span class="mono">{row.code}</span> {row.name}
        </td>
        <td class="mono">{row.settings?.languages.join(' ') ?? '—'}</td>
        <td>{row.settings?.cities.map((c) => c['en'] ?? Object.values(c)[0]).join(', ') ?? '—'}</td>
        <td>{row.rule}</td>
        <td>
          <Time iso={row.createdAt} />
        </td>
        <td>
          <button onClick={onToggle}>{open ? 'Close' : 'Edit'}</button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6}>
            <div class="form">
              <label>
                settings: gl, languages (ISO 639-1), suffix and city names per language, other names
                <textarea
                  value={text}
                  rows={16}
                  onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                />
              </label>
              <div class="actions">
                <button class="primary" disabled={busy} onClick={save}>
                  {busy ? 'saving…' : 'Save'}
                </button>
              </div>
              {error ? <WriteFailed error={error} /> : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

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

  return (
    <DiscoveryJob
      detail={state.data}
      loadedAt={loadedAt}
      country={country}
      onCountry={onCountry}
    />
  );
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
      {job.rfqSearchId ? (
        <div class="muted" style="margin-bottom:8px">
          one product of <a href={href(`/discovery/rfq/${job.rfqSearchId}`)}>{job.rfqRef ?? 'an RFQ search'}</a>
          {job.lineRef ? ` (line ${job.lineRef})` : ''}
        </div>
      ) : null}

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
            <a class="button" href={api.discoveryResultsCsvUrl(job.id, { country })} download>
              Download CSV{country ? ` (${country})` : ''}
            </a>
          </div>
          {/* Asked again whenever the job moves on, so results appear as tasks finish. */}
          <Results jobId={job.id} country={country} version={`${job.status}:${JSON.stringify(job.counts)}:${tasks.map((t) => t.status).join()}`} />
        </Card>

        <Card title="what the search found" wide>
          <Candidates jobId={job.id} country={country} version={`${job.status}:${tasks.map((t) => `${t.status}${t.stage}`).join()}`} />
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
              <th>persona</th>
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
                  {r.persona ? r.persona.name : <span class="muted">—</span>}
                  {r.fit ? <div class="muted">{r.fit} fit</div> : null}
                  <div class="muted">{r.tier === 'found' ? 'found by this search' : 'already in the pool'}</div>
                </td>
                <td>
                  {r.evidence?.length ? (
                    <ul class="reasons">
                      {r.evidence.map((e) => (
                        <li key={e.quote}>
                          {e.claim}: “{e.quote}”{' '}
                          {/^https?:\/\//.test(e.url) ? (
                            <a href={e.url} target="_blank" rel="noopener noreferrer">
                              page
                            </a>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <ul class="reasons">
                      {r.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
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

/**
 * Every company the searches turned up, kept ones first, as the engine
 * ordered them. Dropped ones, with why, behind a toggle.
 */
function Candidates({ jobId, country, version }: { jobId: string; country: string; version: string }) {
  const [showDropped, setShowDropped] = useState(false);
  const [rows, setRows] = useState<DiscoveryCandidate[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Everything but what triage dropped, by default; everything with the toggle.
  const status = showDropped ? '' : 'new,kept,extracted,not_saved,failed';

  useEffect(() => setCursor(undefined), [jobId, country, status, version]);

  const answer = useAsync(
    async () => ({ used: cursor, result: await api.discoveryCandidates(jobId, { country, status, cursor, limit: 200 }) }),
    [jobId, country, status, cursor, version],
  );
  useEffect(() => {
    if (answer.state.status !== 'ok') return;
    const { used, result } = answer.state.data;
    setRows((current) => (used ? [...current, ...result.items] : result.items));
  }, [answer.state]);
  const next = answer.state.status === 'ok' ? answer.state.data.result.nextCursor : null;

  return (
    <>
      <div class="filters">
        <label>
          <input
            type="checkbox"
            checked={showDropped}
            onChange={(e) => setShowDropped((e.target as HTMLInputElement).checked)}
          />{' '}
          show everything, including what triage dropped
        </label>
      </div>
      {answer.state.status === 'loading' && rows.length === 0 ? <Loading what="candidates" /> : null}
      {answer.state.status === 'error' ? <Failed error={answer.state.error} what="candidates" /> : null}
      {answer.state.status === 'ok' && rows.length === 0 ? <Empty what="candidates yet" /> : null}
      {rows.length > 0 ? <CandidateTable rows={rows} /> : null}
      <Pager cursor={next} onMore={() => setCursor(next ?? undefined)} />
    </>
  );
}

function CandidateTable({ rows }: { rows: DiscoveryCandidate[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>company</th>
          <th>country</th>
          <th>found on</th>
          <th>persona</th>
          <th>status</th>
          <th>why</th>
          <th>contact</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <td>
              {c.name}
              {c.domain ? <div class="mono muted">{c.domain}</div> : null}
              {c.companyId ? <div class="muted">already in the pool</div> : null}
            </td>
            <td class="mono">{c.country}</td>
            <td>
              {c.kind === 'both' ? 'web and Maps' : c.kind === 'maps' ? 'Maps' : 'web'}
              {c.category ? <div class="muted">{c.category}</div> : null}
            </td>
            <td>{c.personas.length ? c.personas.map((p) => p.name).join(', ') : <span class="muted">—</span>}</td>
            <td>
              <Badge value={c.status} />
              {c.fit ? <div class="muted">{c.fit} fit</div> : null}
            </td>
            <td>{c.reason ?? <span class="muted">—</span>}</td>
            <td>
              {c.phone ? <div class="mono">{c.phone}</div> : null}
              {c.address ? <div class="muted">{c.address}</div> : null}
              {c.url && /^https?:\/\//.test(c.url) ? (
                <a href={c.url} target="_blank" rel="noopener noreferrer">
                  site
                </a>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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

/** RFQ searches: one row per RFQ, with its products. */
export function RfqSearchesView({ status, onStatus }: { status: string; onStatus: (s: string) => void }) {
  const page = useAsync(() => api.rfqSearches({ status, limit: 100 }), [status], 10_000);
  const rows: RfqSearchRow[] = page.state.status === 'ok' ? page.state.data.items : [];
  return (
    <>
      <div class="head">
        <h2>RFQ searches</h2>
        <button class="primary" onClick={() => go('/discovery/new')}>
          New search
        </button>
        <a class="button" href={href('/discovery')}>
          all searches
        </a>
        <Stamp at={page.loadedAt} />
      </div>
      <div class="filters">
        <Field label="status">
          <Select value={status} options={['running', 'done', 'failed']} onChange={onStatus} />
        </Field>
      </div>
      <Card>
        {page.state.status === 'loading' ? <Loading what="RFQ searches" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="RFQ searches" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="RFQ searches yet" /> : null}
        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>created</th>
                <th>tenant</th>
                <th>RFQ</th>
                <th>products</th>
                <th>looking for</th>
                <th>status</th>
                <th class="num">ranked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  class="clickable"
                  onClick={() => {
                    window.location.hash = href(`/discovery/rfq/${r.id}`).slice(1);
                  }}
                >
                  <td>
                    <Time iso={r.createdAt} relative />
                  </td>
                  <td>{r.tenantName}</td>
                  <td class="mono">{r.rfqRef ?? <span class="muted">—</span>}</td>
                  <td>{(r.products ?? []).join(' · ')}</td>
                  <td>{r.side}</td>
                  <td>
                    <Badge value={r.status} />
                  </td>
                  <td class="num">{r.counts['ranked'] === undefined ? '—' : count(r.counts['ranked'])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </>
  );
}

/**
 * One RFQ search: the RFQ, then each of its products with its own status and
 * ranked companies, in the RFQ's order.
 */
export function RfqSearchView({ id }: { id: string }) {
  const [live, setLive] = useState(true);
  const { state, loadedAt } = useAsync(() => api.rfqSearch(id), [id], live ? LIVE_MS : undefined);
  const status = state.status === 'ok' ? state.data.rfqSearch.status : null;
  useEffect(() => {
    if (status) setLive(status === 'running');
  }, [status]);

  if (state.status === 'loading') return <Loading what="the RFQ search" />;
  if (state.status === 'error') return <Failed error={state.error} what="the RFQ search" />;
  return <RfqSearch detail={state.data} loadedAt={loadedAt} />;
}

export function RfqSearch({ detail, loadedAt }: { detail: RfqSearchDetail; loadedAt: Date | null }) {
  const { rfqSearch: rfq, lines } = detail;
  return (
    <>
      <div class="head">
        <h2>{rfq.rfqRef ?? 'RFQ search'}</h2>
        <Badge value={rfq.status} />
        <span class="muted">
          {rfq.tenantName} · looking for {rfq.side} · {rfq.countries.join(' ')} · {lines.length}{' '}
          {lines.length === 1 ? 'product' : 'products'}
        </span>
        <Stamp at={loadedAt} />
      </div>
      {lines.map((line) => (
        <Card
          key={line.jobId}
          title={`${line.lineRef ? `${line.lineRef} · ` : ''}${line.identifiedName ?? line.product}`}
          wide
        >
          <div class="filters">
            <Badge value={line.status} />
            {line.identifiedName && line.identifiedName !== line.product ? (
              <span class="muted">asked as “{line.product}”</span>
            ) : null}
            <Counts counts={line.counts} />
            <a href={href(`/discovery/${line.jobId}`)}>open this product's search</a>
          </div>
          {line.error ? <div class="state error">{line.error}</div> : null}
          <Results jobId={line.jobId} country="" version={`${line.status}:${JSON.stringify(line.counts)}`} />
        </Card>
      ))}
    </>
  );
}
