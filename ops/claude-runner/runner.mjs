// The Claude bridge: a small host service that runs `claude -p` locked down
// for the marketing engine's discovery jobs. Plain Node 22, built-ins only.
// Spec: docs/briefs/18-claude-bridge-and-personas.md, "The bridge".

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TMP_ROOT = '/tmp/claude-runner';
export const MAX_BODY_BYTES = 1024 * 1024;
const MODELS = new Set(['sonnet', 'haiku']);
const BODY_KEYS = new Set(['task', 'system', 'input', 'schema', 'model']);
const TASK_RE = /^[a-z][a-z0-9_.-]{0,39}$/i;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ZONE = 'Asia/Riyadh';
const WEEK_MS = 7 * 24 * 3600 * 1000;
// A refused probe is configuration, not a hiccup: the unit does not restart on it.
export const PROBE_REFUSED_EXIT = 3;

// ---------------------------------------------------------------- the command

// The only argv the runner ever builds. Caller values are option *values*
// (each follows its flag as its own argument), never flags of their own.
export function lockedArgs({ schema, system, model, stream = false }) {
  return [
    '-p',
    '--safe-mode',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--output-format', stream ? 'stream-json' : 'json',
    ...(stream ? ['--verbose'] : []),
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', system,
    '--model', model,
  ];
}

function childEnv() {
  const env = {};
  for (const k of ['PATH', 'HOME', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function resolveBin(bin) {
  if (bin.includes('/')) return bin;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

// Runs the binary once in a fresh empty directory under TMP_ROOT, which is
// removed afterwards. Resolves when the process is gone (or could not start).
// Aborting `signal` kills the run's process group, as the timeout does.
function runOnce(bin, args, input, timeoutMs, live, signal) {
  return new Promise((resolve) => {
    const out = [];
    let outBytes = 0;
    const err = [];
    let errBytes = 0;
    let timedOut = false;
    let done = false;
    let cwd;
    let child;
    let timer;
    let fallback;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      signal?.removeEventListener('abort', stop);
      if (child) {
        live.delete(child);
        // Whatever claude left running in its group goes with it.
        if (child.pid !== undefined) killGroup(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      if (cwd) {
        try { rmSync(cwd, { recursive: true, force: true }); } catch {}
      }
      // Decoded once, so a character split across pipe reads stays whole.
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, ...r });
    };
    function stop() {
      killGroup(child);
      // If something outside the group still holds the pipes, do not wait on it.
      if (!fallback) fallback = setTimeout(() => finish({ code: null }), 5000);
    }
    try {
      mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 });
      cwd = mkdtempSync(join(TMP_ROOT, 'run-'));
      child = spawn(bin, args, { cwd, env: childEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return finish({ spawnFailed: true, code: null });
    }
    live.add(child);
    child.on('error', () => {
      // ENOENT/EACCES and friends: the process never ran.
      if (child.pid === undefined) finish({ spawnFailed: true, code: null });
    });
    child.stdout.on('data', (b) => {
      outBytes += b.length;
      if (outBytes <= MAX_STDOUT_BYTES) out.push(b);
    });
    child.stderr.on('data', (b) => {
      if (errBytes < 64 * 1024) {
        errBytes += b.length;
        err.push(b);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => finish({ code }));
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- usage limits

// The spec's phrases only. A transient API 429 (rate_limit_error) is not the
// seat's usage limit: it fails the run as exit_<code> and the queue retries it.
const LIMIT_RE = /usage limit reached|hit your [a-z ]{0,20}limit|\bresets\s+\S/i;

export function isUsageLimit(text) {
  return LIMIT_RE.test(text);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of an instant in a zone.
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// The instant at which the zone's wall clock reads y-mo-d h:mi.
function zonedToUtc(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(t, tz);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    t += want - seen;
  }
  return t;
}

// "resets 3pm", "resets 3:30pm (Asia/Riyadh)", "resets Oct 7, 5am", "resets 15:00",
// "resets Jan 3, 2027, 5pm (UTC)" (the CLI adds the year when it differs).
// Zone from the message, else Asia/Riyadh; rolled to the next occurrence;
// clamped to at most 7 days ahead; null when unparseable.
export function parseResetsAt(text, now = Date.now()) {
  const m = /resets\s+(?:at\s+|on\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i.exec(text);
  if (!m) return null;
  const [, monName, dayStr, yearStr, hStr, minStr, ampm, zoneStr] = m;
  if (!ampm && minStr === undefined) return null;
  let h = +hStr;
  const mi = minStr === undefined ? 0 : +minStr;
  if (mi > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm.toLowerCase() === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  const tz = zoneStr && validZone(zoneStr) ? zoneStr : DEFAULT_ZONE;
  const today = partsIn(now, tz);
  let t;
  if (monName) {
    const mo = MONTHS.indexOf(monName.slice(0, 3).toLowerCase()) + 1;
    const d = +dayStr;
    if (mo === 0 || d < 1 || d > 31) return null;
    if (yearStr) {
      t = zonedToUtc(+yearStr, mo, d, h, mi, tz);
      if (t <= now) return null;
    } else {
      t = zonedToUtc(today.y, mo, d, h, mi, tz);
      if (t <= now) t = zonedToUtc(today.y + 1, mo, d, h, mi, tz);
    }
  } else {
    t = zonedToUtc(today.y, today.mo, today.d, h, mi, tz);
    if (t <= now) t = zonedToUtc(today.y, today.mo, today.d + 1, h, mi, tz);
  }
  if (!Number.isFinite(t)) return null;
  return new Date(Math.min(t, now + WEEK_MS)).toISOString();
}

// ----------------------------------------------------------------- network

function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function parseCidr(cidr) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(cidr ?? '').trim());
  if (!m) return null;
  const base = ipv4ToInt(m[1]);
  const bits = +m[2];
  if (base === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (base & mask) >>> 0, mask };
}

export function inCidr(addr, cidr) {
  const ip = ipv4ToInt(String(addr ?? '').replace(/^::ffff:/i, ''));
  return ip !== null && ((ip & cidr.mask) >>> 0) === cidr.net;
}

function nextUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

function digest(s) {
  return createHash('sha256').update(String(s)).digest();
}

// ------------------------------------------------------------------ config

// Bytes of entropy a token can carry: hex is 4 bits a character, base64 6.
// Anything else (a passphrase) is not "random bytes" and is refused.
export function tokenBytes(t) {
  if (typeof t !== 'string') return 0;
  if (new Set(t).size < 8) return 0;
  if (/^[0-9a-f]+$/i.test(t)) return Math.floor(t.length / 2);
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return Math.floor((t.replace(/=+$/, '').length * 3) / 4);
  return 0;
}

function posInt(v, name, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function validateConfig(c) {
  const errors = [];
  const host = String(c.host ?? '').trim();
  if (!host) errors.push('CLAUDE_RUNNER_HOST is required (the gateway of marketing-staging_marketing)');
  else if (ipv4ToInt(host) === null) errors.push('CLAUDE_RUNNER_HOST must be an IPv4 address');
  else if (host === '0.0.0.0') errors.push('CLAUDE_RUNNER_HOST must not be 0.0.0.0');
  const cidr = parseCidr(c.allowCidr);
  if (!c.allowCidr) errors.push('CLAUDE_RUNNER_ALLOW_CIDR is required (the subnet of marketing-staging_marketing)');
  else if (!cidr) errors.push('CLAUDE_RUNNER_ALLOW_CIDR must be an IPv4 CIDR such as 192.168.112.0/20');
  if (tokenBytes(c.token) < 32) errors.push('CLAUDE_RUNNER_TOKEN is required and must be at least 32 random bytes, hex or base64 (openssl rand -hex 32)');
  const out = { host, cidr, token: c.token, stateDir: c.stateDir || null, log: c.log ?? ((o) => process.stdout.write(JSON.stringify(o) + '\n')) };
  for (const [key, name, def, min] of [
    ['port', 'CLAUDE_RUNNER_PORT', 8787, 0],
    ['concurrency', 'CLAUDE_RUNNER_CONCURRENCY', 2, 1],
    ['queue', 'CLAUDE_RUNNER_QUEUE', 20, 0],
    ['timeoutMs', 'CLAUDE_RUNNER_TIMEOUT_MS', 120000, 1],
    ['dailyCalls', 'CLAUDE_RUNNER_DAILY_CALLS', 300, 0],
  ]) {
    try {
      out[key] = posInt(c[key], name, def);
      if (out[key] < min) errors.push(`${name} must be at least ${min}`);
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (out.port > 65535) errors.push('CLAUDE_RUNNER_PORT must be at most 65535');
  const binName = c.claudeBin || 'claude';
  out.bin = resolveBin(binName);
  if (!out.bin) errors.push(`CLAUDE_BIN "${binName}" was not found on PATH`);
  if (errors.length) throw new Error('claude-runner: refusing to start:\n  - ' + errors.join('\n  - '));
  return out;
}

export function configFromEnv(env = process.env) {
  return {
    host: env.CLAUDE_RUNNER_HOST,
    port: env.CLAUDE_RUNNER_PORT,
    allowCidr: env.CLAUDE_RUNNER_ALLOW_CIDR,
    token: env.CLAUDE_RUNNER_TOKEN,
    concurrency: env.CLAUDE_RUNNER_CONCURRENCY,
    queue: env.CLAUDE_RUNNER_QUEUE,
    timeoutMs: env.CLAUDE_RUNNER_TIMEOUT_MS,
    dailyCalls: env.CLAUDE_RUNNER_DAILY_CALLS,
    claudeBin: env.CLAUDE_BIN,
    // Set by systemd from StateDirectory=; the day's call count is kept there.
    stateDir: env.STATE_DIRECTORY,
  };
}

// ------------------------------------------------------------------ server

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function validateBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object';
  for (const k of Object.keys(b)) if (!BODY_KEYS.has(k)) return `unknown field: ${k}`;
  if (typeof b.task !== 'string' || !TASK_RE.test(b.task)) return 'task must be a short name';
  if (typeof b.system !== 'string' || !b.system.trim()) return 'system must be a non-empty string';
  if (typeof b.input !== 'string') return 'input must be a string';
  if (!b.schema || typeof b.schema !== 'object' || Array.isArray(b.schema)) return 'schema must be a JSON object';
  if (b.model !== undefined && !MODELS.has(b.model)) return 'model must be sonnet or haiku';
  return null;
}

export function createRunner(config) {
  const c = validateConfig(config);
  const tokenDigest = digest(c.token);
  const live = new Set();
  const waiting = [];
  let active = 0;
  let ready = false;

  // The day's count survives a restart when there is a state directory.
  const budgetFile = c.stateDir ? join(c.stateDir, 'budget.json') : null;
  let budget = { day: '', used: 0 };
  if (budgetFile) {
    try {
      const b = JSON.parse(readFileSync(budgetFile, 'utf8'));
      if (typeof b?.day === 'string' && Number.isInteger(b.used) && b.used >= 0) budget = { day: b.day, used: b.used };
    } catch {}
  }
  const saveBudget = () => {
    if (!budgetFile) return;
    try {
      writeFileSync(`${budgetFile}.tmp`, JSON.stringify(budget), { mode: 0o600 });
      renameSync(`${budgetFile}.tmp`, budgetFile);
    } catch {}
  };
  // Returns the day charged, or null when the budget is used up.
  const useBudget = () => {
    const day = new Date().toISOString().slice(0, 10);
    if (budget.day !== day) budget = { day, used: 0 };
    if (budget.used >= c.dailyCalls) return null;
    budget.used++;
    saveBudget();
    return day;
  };
  const refundBudget = (day) => {
    if (budget.day === day && budget.used > 0) {
      budget.used--;
      saveBudget();
    }
  };

  // Resolves true with a slot, or false when `signal` aborts while queued.
  const acquire = (signal) => {
    if (active < c.concurrency) {
      active++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        const i = waiting.indexOf(take);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      };
      const take = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      waiting.push(take);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  async function handleRun(req, res) {
    const started = Date.now();
    const entry = { task: null, model: null, durationMs: 0, outcome: '', status: 0, inputBytes: 0, outputBytes: 0 };
    // A caller that goes away before its answer stops the queued or running work.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    const reply = (status, body, outcome, extra = {}) => {
      entry.durationMs = Date.now() - started;
      entry.status = status;
      entry.outcome = outcome;
      c.log({ ts: new Date().toISOString(), ...entry, ...extra });
      if (!gone.signal.aborted && !res.headersSent) send(res, status, body);
    };

    try {
      const auth = String(req.headers.authorization ?? '');
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!timingSafeEqual(digest(given), tokenDigest)) {
        req.resume();
        return reply(401, { error: 'unauthorized' }, 'unauthorized');
      }

      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        res.setHeader('connection', 'close');
        req.resume();
        return reply(413, { error: 'too_large' }, 'too_large');
      }
      const raw = await new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (b) => {
          size += b.length;
          if (size > MAX_BODY_BYTES) {
            req.pause();
            resolve(null);
          } else chunks.push(b);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(undefined));
      });
      if (raw === undefined) return; // client went away
      if (raw === null) {
        res.setHeader('connection', 'close');
        res.on('finish', () => req.socket.destroy());
        return reply(413, { error: 'too_large' }, 'too_large');
      }

      const body = parseJson(raw.toString('utf8'));
      const problem = validateBody(body);
      if (problem) return reply(400, { error: 'bad_request', reason: problem }, 'bad_request');
      const model = body.model ?? 'sonnet';
      entry.task = body.task;
      entry.model = model;
      entry.inputBytes = Buffer.byteLength(body.input);
      // Built before anything is spent: a schema too deep to serialise is the caller's fault.
      let args;
      try {
        args = lockedArgs({ schema: body.schema, system: body.system, model });
      } catch {
        return reply(400, { error: 'bad_request', reason: 'schema cannot be serialised' }, 'bad_request');
      }

      if (waiting.length >= c.queue && active >= c.concurrency) return reply(503, { error: 'busy' }, 'busy');
      const day = useBudget();
      if (!day) return reply(429, { error: 'bridge_budget', resetsAt: nextUtcMidnight() }, 'bridge_budget');

      if (!(await acquire(gone.signal))) {
        refundBudget(day);
        return reply(499, null, 'client_gone', { while: 'queued' });
      }
      if (gone.signal.aborted) {
        release();
        refundBudget(day);
        return reply(499, null, 'client_gone', { while: 'queued' });
      }
      let r;
      try {
        r = await runOnce(c.bin, args, body.input, c.timeoutMs, live, gone.signal);
      } finally {
        release();
      }
      if (gone.signal.aborted) return reply(499, null, 'client_gone', { while: 'running' });

      if (r.spawnFailed) return reply(502, { error: 'claude_failed', reason: 'spawn_failed' }, 'spawn_failed');
      if (r.timedOut) return reply(504, { error: 'timeout' }, 'timeout');
      const result = parseJson(r.stdout);
      const stderrHead = r.code !== 0 ? { stderr: r.stderr.slice(0, 200) } : {};
      if (r.code !== 0 || result?.is_error === true) {
        // Only a failed run can be a usage limit, and only stderr and the
        // result string are read for it, never structured_output.
        const text = `${r.stderr}\n${typeof result?.result === 'string' ? result.result : ''}`;
        if (isUsageLimit(text)) {
          return reply(429, { error: 'usage_limit', resetsAt: parseResetsAt(text) }, 'usage_limit', stderrHead);
        }
        return reply(502, { error: 'claude_failed', reason: `exit_${r.code}` }, `exit_${r.code}`, stderrHead);
      }
      const output = result?.structured_output;
      if (output === undefined || output === null) {
        return reply(502, { error: 'claude_failed', reason: 'no_structured_output' }, 'no_structured_output');
      }
      entry.outputBytes = Buffer.byteLength(JSON.stringify(output));
      const costUsd = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
      return reply(200, { output, durationMs: Date.now() - started, costUsd }, 'ok');
    } catch {
      // Still one log line for the call.
      if (!entry.outcome) reply(500, { error: 'internal' }, 'internal');
    }
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && path === '/run') {
      return handleRun(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'internal' });
      });
    }
    req.resume();
    send(res, 404, { error: 'not_found' });
  });
  // A connection from outside the allowed subnet is closed before anything is
  // read, and so is every connection until the probe has passed.
  server.on('connection', (socket) => {
    if (!ready || !inCidr(socket.remoteAddress, c.cidr)) socket.destroy();
  });

  // One call with the locked flags in stream-json: the init event must list
  // no tools and no MCP servers, or the runner does not listen.
  async function probe() {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const args = lockedArgs({ schema, system: 'Answer with ok set to true.', model: 'haiku', stream: true });
    useBudget();
    const r = await runOnce(c.bin, args, 'probe', c.timeoutMs, live);
    let init = null;
    for (const line of r.stdout.split('\n')) {
      const o = parseJson(line);
      if (o?.type === 'system' && o.subtype === 'init') {
        init = o;
        break;
      }
    }
    const tools = Array.isArray(init?.tools) ? init.tools : null;
    const mcp = Array.isArray(init?.mcp_servers) ? init.mcp_servers : null;
    const ok = !!init && tools !== null && tools.length === 0 && mcp !== null && mcp.length === 0;
    c.log({
      ts: new Date().toISOString(), probe: ok ? 'ok' : 'refused', initSeen: !!init,
      tools: tools ?? null, mcpServers: mcp ? mcp.map((s) => s?.name ?? s) : null,
      exitCode: r.code, timedOut: r.timedOut, spawnFailed: !!r.spawnFailed,
    });
    if (!ok) {
      throw Object.assign(new Error(init
        ? 'claude-runner: probe init lists tools or MCP servers; refusing to listen'
        : 'claude-runner: probe produced no init event; refusing to listen'), { exitCode: PROBE_REFUSED_EXIT });
    }
  }

  return {
    server,
    // Binds first, so an address that is not there costs no claude call; then
    // probes, and only then accepts connections.
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(c.port, c.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      try {
        await probe();
      } catch (e) {
        await new Promise((resolve) => server.close(() => resolve()));
        throw e;
      }
      ready = true;
      const a = server.address();
      c.log({ ts: new Date().toISOString(), listening: `${a.address}:${a.port}`, allow: config.allowCidr });
    },
    async stop() {
      for (const child of live) killGroup(child);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// --------------------------------------------------------------------- main

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let runner;
  try {
    runner = createRunner(configFromEnv());
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const shutdown = () => runner.stop().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  runner.start().catch((e) => {
    console.error(e.message);
    process.exit(e.exitCode ?? 1);
  });
}
