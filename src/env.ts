import { z } from 'zod';

/**
 * Every variable the service reads, in one place, checked once at boot.
 *
 * A service that starts with a missing key and only discovers it on the first
 * send is worse than one that refuses to start, so this throws with the whole
 * list of what is wrong rather than the first problem it meets.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'a Postgres connection string'),
  JWT_SECRET: z.string().min(1, 'the HS256 secret tenant tokens are signed with'),
  CREDENTIALS_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, '32 bytes of hex (openssl rand -hex 32)'),
  WEBHOOK_TOKEN: z.string().min(16, 'at least 16 characters; it is a URL secret'),
  INTERNAL_TOKEN: z.string().min(16, "at least 16 characters; it is the marketplace's key"),
  PUBLIC_BASE_URL: z.string().url('the public origin of this service'),
  MARKETPLACE_SIGNUP_URL: z.string().url('where an invited company signs up'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FINDER: z.string().min(1).default('basic'),
  LEDGER: z.string().min(1).default('internal'),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().min(1).default(60),

  // Optional: each one turns a capability on, and the engine works without it.
  PLATFORM_DOMAIN: z.string().optional(),
  WATHQ_API_KEY: z.string().optional(),
  WATHQ_BASE_URL: z.string().url().optional(),
  FINANCE_ENGINE_URL: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),

  // Discovery's providers. Each is optional; without them a job ranks the pool.
  CLAUDE_RUNNER_URL: z.string().url().optional(),
  CLAUDE_RUNNER_TOKEN: z.string().optional(),
  CLAUDE_RUNNER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  DISCOVERY_MAX_DEFERRALS: z.coerce.number().int().min(0).default(5),
  SERPER_API_KEY: z.string().optional(),
  SERPER_RPS: z.coerce.number().min(0.1).max(50).default(4),
  // What one Serper credit costs, for the operator's spend figures. The
  // smallest pack is USD 50 for 50,000 credits; set it to the pack you bought.
  SERPER_USD_PER_CREDIT: z.coerce.number().min(0).default(0.001),
  SEARCH_CACHE_DAYS: z.coerce.number().int().min(0).default(30),
  DISCOVERY_MAX_QUERIES: z.coerce.number().int().min(1).default(30),
  DISCOVERY_MAX_QUERIES_PER_JOB: z.coerce.number().int().min(1).default(60),
  // Reading websites: the self-hosted Firecrawl, with a guarded plain fetch without it.
  FIRECRAWL_URL: z.string().url().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  DISCOVERY_MAX_READS: z.coerce.number().int().min(0).default(25),
  DISCOVERY_MAX_CLAUDE_CALLS: z.coerce.number().int().min(1).default(60),
});

export type Env = z.infer<typeof schema>;

let parsed: Env | undefined;

/** Throws with every problem at once. Call once at boot. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`the environment is not usable:\n${problems}`);
  }
  parsed = result.data;
  return parsed;
}

/**
 * The parsed environment. Reads lazily so a test or a script that sets
 * variables after import still gets them, and so nothing has to be loaded in a
 * particular order.
 */
export function env(): Env {
  return parsed ?? loadEnv();
}

/** Tests change variables between cases; this forgets what was parsed. */
export function resetEnv(): void {
  parsed = undefined;
}
