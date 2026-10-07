import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api.js';
import { clockTime, localTime, relativeTime } from '../format.js';

export function Card({
  title,
  wide,
  children,
}: {
  title?: string;
  wide?: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class={wide ? 'card wide' : 'card'}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div class="stat">
      <div class="n">{value}</div>
      <div class="k">{label}</div>
    </div>
  );
}

/** ISO in the title so the exact value is one hover away. */
export function Time({ iso, relative }: { iso: string | null; relative?: boolean }) {
  if (!iso) return <span class="muted">—</span>;
  return (
    <span title={iso}>{relative ? relativeTime(iso) : localTime(iso)}</span>
  );
}

export function Clock({ iso }: { iso: string }) {
  return <span title={iso}>{clockTime(iso)}</span>;
}

/**
 * Status as a coloured dot beside its own name. The name is what carries the
 * meaning; the colour only makes it findable.
 */
const TONE: Record<string, string> = {
  delivered: 'good',
  read: 'good',
  sent: 'good',
  settled: 'good',
  accepted: 'good',
  completed: 'good',
  active: 'good',
  done: 'good',
  running: 'good',
  live: 'good',
  sending: 'good',
  queued: 'warning',
  scheduled: 'warning',
  expanding: 'warning',
  paused: 'warning',
  pending: 'warning',
  reserved: 'warning',
  created: 'warning',
  retry: 'serious',
  blocked: 'serious',
  released: 'serious',
  expired: 'serious',
  exhausted: 'serious',
  ended: 'serious',
  cancelled: 'serious',
  skipped: 'serious',
  failed: 'critical',
  kept: 'good',
  extracted: 'good',
  not_saved: 'serious',
  dropped: 'serious',
  new: 'warning',
};

export function Badge({ value }: { value: string | null }) {
  if (!value) return <span class="muted">—</span>;
  const tone = TONE[value] ?? '';
  return (
    <span class={`badge ${tone}`}>
      <span class="dot" />
      {value}
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return <div class="state">loading {what}…</div>;
}

export function Empty({ what }: { what: string }) {
  return <div class="state">no {what}</div>;
}

/** The API's own error body, verbatim. Guessing at what went wrong helps nobody. */
export function Failed({ error, what }: { error: unknown; what: string }) {
  const status = error instanceof ApiError ? error.status : null;
  const body = error instanceof ApiError ? error.body : { message: String(error) };
  return (
    <div class="state error">
      <div>
        could not load {what}
        {status ? ` — HTTP ${status}` : ''}
      </div>
      <pre>{JSON.stringify(body, null, 2)}</pre>
    </div>
  );
}

export type Async<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ok'; data: T };

/**
 * One fetch, re-run when `deps` change, optionally on an interval. Pauses the
 * interval while the tab is hidden: a dashboard on a background tab should not
 * keep asking.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  everyMs?: number,
): { state: Async<T>; refresh: () => void; loadedAt: Date | null } {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const ticket = ++latest.current;
      try {
        const data = await load();
        // A slower earlier request must not overwrite a newer answer.
        if (alive && ticket === latest.current) {
          setState({ status: 'ok', data });
          setLoadedAt(new Date());
        }
      } catch (error) {
        if (alive && ticket === latest.current) setState({ status: 'error', error });
      }
    };

    void run();

    if (!everyMs) return () => { alive = false; };

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void run();
    }, everyMs);

    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, everyMs]);

  return { state, refresh: () => setNonce((n) => n + 1), loadedAt };
}

export function Stamp({ at }: { at: Date | null }) {
  if (!at) return null;
  return <span class="stamp">refreshed {at.toLocaleTimeString()}</span>;
}

export function Pager({
  cursor,
  onMore,
  loading,
}: {
  cursor: string | null;
  onMore: () => void;
  loading?: boolean;
}) {
  if (!cursor) return null;
  return (
    <div style="margin-top:10px">
      <button onClick={onMore} disabled={loading}>
        {loading ? 'loading…' : 'load more'}
      </button>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}

export function Select({
  value,
  options,
  onChange,
  allowEmpty = true,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  allowEmpty?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {allowEmpty ? <option value="">any</option> : null}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function Text({
  value,
  placeholder,
  onChange,
  width = 150,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  width?: number;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder ?? ''}
      style={`width:${width}px`}
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
    />
  );
}

/**
 * A filled bar for a count the API returned out of a total it returned. Only
 * the width is computed here; both numbers are the engine's.
 */
export function Progress({ done, total }: { done: number; total: number | null }) {
  if (!total) return <span class="muted">—</span>;
  const pct = Math.min(100, Math.round((done / total) * 100));
  return (
    <span class="progress" title={`${done} of ${total}`}>
      <span class="progress-bar">
        <span class="progress-fill" style={`width:${pct}%`} />
      </span>
      <span class="progress-text">
        {done.toLocaleString()} / {total.toLocaleString()}
      </span>
    </span>
  );
}
