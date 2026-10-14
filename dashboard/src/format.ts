/**
 * Formatting only. Nothing here derives a fact the API did not return: these
 * turn a value the engine sent into something legible.
 */

/** Minor units to a readable amount. 5000 SAR halalas is 50.00 SAR. */
export function money(minorUnits: string | number, currency: string): string {
  const n = typeof minorUnits === 'string' ? Number(minorUnits) : minorUnits;
  if (!Number.isFinite(n)) return '—';

  // Most currencies are two decimal places; the ones that are not are rare
  // enough that a wrong guess is worse than asking Intl.
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * A discount as written on a code: "10%" for 1000 basis points, money for a
 * fixed amount, then its cap and minimum when it has them.
 */
export function discount(
  d: { type: 'percent' | 'fixed'; value: number; maxDiscount?: number; minSubtotal?: number },
  currency: string,
): string {
  const base =
    d.type === 'percent'
      ? `${(d.value / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
      : money(d.value, currency);
  const parts = [base];
  if (d.maxDiscount !== undefined) parts.push(`up to ${money(d.maxDiscount, currency)}`);
  if (d.minSubtotal !== undefined) parts.push(`min subtotal ${money(d.minSubtotal, currency)}`);
  return parts.join(', ');
}

const UNITS: [limit: number, seconds: number, name: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [604800, 86400, 'day'],
  [2629800, 604800, 'week'],
  [31557600, 2629800, 'month'],
  [Infinity, 31557600, 'year'],
];

/** "3 minutes ago". Takes `now` so it can be tested without faking the clock. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';

  const seconds = (then.getTime() - now.getTime()) / 1000;
  const magnitude = Math.abs(seconds);
  if (magnitude < 5) return 'just now';

  const unit = UNITS.find(([limit]) => magnitude < limit) ?? UNITS[UNITS.length - 1]!;
  const value = Math.round(seconds / unit[1]);
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit[2]);
}

/** The operator's own zone; the ISO value goes in the title attribute. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const EVERY: Record<string, string> = {
  '* * * * *': 'every minute',
  '0 * * * *': 'hourly, on the hour',
  '0 0 * * *': 'daily at midnight',
};

/**
 * A cron string in words, for the handful of shapes this engine actually uses.
 * Anything else is shown as-is rather than guessed at — a wrong description of
 * a schedule is worse than no description.
 */
export function cronToText(cron: string): string {
  const known = EVERY[cron.trim()];
  if (known) return known;

  const everyN = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
  if (everyN) {
    const n = Number(everyN[1]);
    return n === 1 ? 'every minute' : `every ${n} minutes`;
  }

  const everyNHours = /^0 \*\/(\d+) \* \* \*$/.exec(cron.trim());
  if (everyNHours) {
    const n = Number(everyNHours[1]);
    return n === 1 ? 'hourly, on the hour' : `every ${n} hours`;
  }

  const dailyAt = /^(\d+) (\d+) \* \* \*$/.exec(cron.trim());
  if (dailyAt) {
    return `daily at ${String(dailyAt[2]).padStart(2, '0')}:${String(dailyAt[1]).padStart(2, '0')}`;
  }

  return cron;
}

export function count(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString();
}

/**
 * US dollars as the engine prices Serper credits: a credit is a tenth of a
 * cent, so up to four decimals, never fewer than two.
 */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(n);
}

/** A ratio the engine worked out, as a whole percentage. */
export function percent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}
