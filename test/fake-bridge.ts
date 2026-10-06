import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../src/db/client.js';
import { resetEnv } from '../src/env.js';
import { runPlan, runTask, setSerperFetch, type PlanJob, type TaskJob } from '../src/modules/discovery/index.js';

/**
 * Fakes for the discovery providers, shared by the search and extraction
 * tests: a Claude bridge answering by task, and a Serper answering from saved
 * responses in test/fixtures/serper/.
 */

export const RUNNER_TOKEN = 'test-runner-token-0123456789abcdef0123456789';

export type BridgeCall = { task: string; input: Record<string, unknown> };
export type BridgeAnswer = { status: number; body: unknown };
export type BridgeHandler = (task: string, input: Record<string, unknown>, n: number) => BridgeAnswer;

export const ok = (output: unknown): BridgeAnswer => ({ status: 200, body: { output, durationMs: 1, costUsd: 0 } });

export class FakeBridge {
  calls: BridgeCall[] = [];
  handler: BridgeHandler = () => ({ status: 500, body: {} });
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        const task = String(body['task']);
        const input = JSON.parse(String(body['input'] ?? '{}')) as Record<string, unknown>;
        this.calls.push({ task, input });
        const n = this.calls.filter((c) => c.task === task).length;
        const reply = this.handler(task, input, n);
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  count(task: string): number {
    return this.calls.filter((c) => c.task === task).length;
  }
}

export function setProviders(opts: { bridge?: string | null; serper?: boolean }): void {
  if (opts.bridge) {
    process.env.CLAUDE_RUNNER_URL = opts.bridge;
    process.env.CLAUDE_RUNNER_TOKEN = RUNNER_TOKEN;
  } else {
    delete process.env.CLAUDE_RUNNER_URL;
    delete process.env.CLAUDE_RUNNER_TOKEN;
  }
  if (opts.serper) {
    process.env.SERPER_API_KEY = 'test-serper-key';
    process.env.SERPER_RPS = '50';
  } else {
    delete process.env.SERPER_API_KEY;
  }
  resetEnv();
}

export function clearProviders(): void {
  for (const k of [
    'CLAUDE_RUNNER_URL',
    'CLAUDE_RUNNER_TOKEN',
    'SERPER_API_KEY',
    'SERPER_RPS',
    'DISCOVERY_MAX_QUERIES',
    'DISCOVERY_MAX_QUERIES_PER_JOB',
    'FIRECRAWL_URL',
  ]) {
    delete process.env[k];
  }
  resetEnv();
  setSerperFetch(null);
}

export type SerperCall = { path: string; q: string; gl: string; hl: string };

/**
 * Serper from saved responses: the first rule whose pattern matches the query
 * answers; anything else gets no results. `override` answers before the rules.
 */
export class FakeSerper {
  calls: SerperCall[] = [];
  override: ((call: SerperCall) => Response | null) | null = null;

  constructor(private readonly rules: { path: '/search' | '/places'; match: RegExp; fixture: string }[]) {}

  install(): void {
    setSerperFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
      const call = { path, q: body['q'] ?? '', gl: body['gl'] ?? '', hl: body['hl'] ?? '' };
      this.calls.push(call);
      const forced = this.override?.(call);
      if (forced) return forced;
      const rule = this.rules.find((r) => r.path === path && r.match.test(call.q));
      const json = rule
        ? readFileSync(new URL(`./fixtures/serper/${rule.fixture}`, import.meta.url), 'utf8')
        : JSON.stringify(path === '/places' ? { places: [] } : { organic: [] });
      return new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  }
}

type Queued = { id: string; name: string; data: PlanJob & TaskJob };

export async function queued(name?: string): Promise<Queued[]> {
  return db()<Queued[]>`
    select id::text, name, data from pgboss.job
    where state = 'created' and ${name ? db()`name = ${name}` : db()`name like 'discovery.%'`}
    order by created_on, id
  `;
}

/** Run every waiting discovery job, oldest first, ignoring start_after. */
export async function drive(opts: { finalAttempt?: boolean } = {}): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const [job] = await queued();
    if (!job) return;
    await db()`delete from pgboss.job where id = ${job.id}`;
    if (job.name === 'discovery.plan') await runPlan(job.data, { finalAttempt: opts.finalAttempt ?? true });
    else await runTask(job.data, { finalAttempt: opts.finalAttempt ?? true });
  }
  throw new Error('drive did not settle');
}
