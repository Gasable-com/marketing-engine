/**
 * One real identification through the real bridge. Needs CLAUDE_RUNNER_URL
 * and CLAUDE_RUNNER_TOKEN pointing at ops/claude-runner on the host; skipped
 * without them. Spends one Claude call.
 */
import { describe, expect, it } from 'vitest';
import { ask } from '../../src/modules/discovery/claude.js';
import { Identified, identifyPrompt } from '../../src/modules/discovery/prompts.js';

const configured = Boolean(process.env.CLAUDE_RUNNER_URL && process.env.CLAUDE_RUNNER_TOKEN);

describe.skipIf(!configured)('claude bridge, live', () => {
  it('identifies Microsilica MS900D  1 MT', async () => {
    const raw = await ask('identify', {
      system: identifyPrompt.system,
      schema: identifyPrompt.schema,
      input: JSON.stringify({ product: 'Microsilica MS900D  1 MT', category: 'Accelerators', pastedRow: null }),
    });
    const identified = Identified.parse(raw);
    console.log(JSON.stringify(identified, null, 2));
    expect(identified.notIdentified).toBe(false);
    expect(identified.name.toLowerCase()).toContain('silica');
    expect(identified.aliases.length).toBeGreaterThan(0);
  }, 180_000);
});
