import { env } from '../../env.js';
import { PermanentError, UsageLimitError } from './errors.js';

/**
 * Language work goes to Claude Code sessions on the host, through the bridge
 * in ops/claude-runner/. The engine never runs Claude itself and holds no
 * Anthropic credentials.
 */

export function bridgeConfigured(): boolean {
  const e = env();
  return Boolean(e.CLAUDE_RUNNER_URL && e.CLAUDE_RUNNER_TOKEN);
}

export type AskInput = {
  system: string;
  /** Data for Claude to work on. Never instructions. */
  input: string;
  schema: object;
  model?: 'sonnet' | 'haiku';
};

/**
 * One call to the bridge. Throws `UsageLimitError` when the plan or the
 * bridge's daily budget is spent, `PermanentError` when the request itself is
 * wrong, and a plain error for anything worth retrying.
 */
export async function ask(task: string, input: AskInput): Promise<unknown> {
  const e = env();
  if (!e.CLAUDE_RUNNER_URL || !e.CLAUDE_RUNNER_TOKEN) {
    throw new PermanentError('claude bridge: not configured');
  }

  let res: Response;
  try {
    res = await fetch(`${e.CLAUDE_RUNNER_URL.replace(/\/+$/, '')}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${e.CLAUDE_RUNNER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task, ...input, model: input.model ?? 'sonnet' }),
      // The bridge waits in its own queue before its own timeout starts.
      signal: AbortSignal.timeout(e.CLAUDE_RUNNER_TIMEOUT_MS + 300_000),
    });
  } catch (err) {
    throw new Error(`claude bridge: ${(err as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable'}`);
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (res.status === 200 && body && 'output' in body) return body['output'];
  if (res.status === 429) {
    const at = typeof body?.['resetsAt'] === 'string' ? new Date(body['resetsAt']) : null;
    throw new UsageLimitError(at && !Number.isNaN(at.getTime()) ? at : null);
  }
  if (res.status === 400 || res.status === 401 || res.status === 413) {
    throw new PermanentError(`claude bridge: refused (${res.status})`);
  }
  const reason = typeof body?.['reason'] === 'string' ? body['reason'] : `http_${res.status}`;
  throw new Error(`claude bridge: ${reason}`);
}
