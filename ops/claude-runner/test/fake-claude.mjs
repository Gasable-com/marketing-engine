#!/usr/bin/env node
// A fake `claude` for the runner tests. It never calls a model.
// It reads what to do from $HOME/control.json and records each call
// (argv, cwd and its entries, env, stdin, start and end times) to
// $HOME/calls/<pid>.json. The tests point HOME at a temporary directory.

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME;
const control = JSON.parse(readFileSync(join(home, 'control.json'), 'utf8'));
const argv = process.argv.slice(2);
const isProbe = argv.includes('stream-json');
const record = {
  argv,
  pid: process.pid,
  cwd: process.cwd(),
  cwdEntries: readdirSync(process.cwd()),
  env: { ...process.env },
  start: Date.now(),
};
mkdirSync(join(home, 'calls'), { recursive: true });
const save = (extra = {}) =>
  writeFileSync(join(home, 'calls', `${process.pid}.json`), JSON.stringify({ ...record, ...extra }));

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', main);

const result = (extra) =>
  JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 5,
    result: '', total_cost_usd: 0.0123, api_error_status: null, ...extra,
  });

function main() {
  record.stdin = stdin;
  save();

  if (isProbe) {
    const probe = control.probe ?? 'clean';
    if (probe !== 'none') {
      const init = {
        type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'fake',
        tools: probe === 'tool' ? ['Bash'] : [],
        mcp_servers: probe === 'mcp' ? [{ name: 'notion', status: 'connected' }] : [],
        model: 'claude-haiku',
      };
      process.stdout.write(JSON.stringify(init) + '\n');
    }
    process.stdout.write(result({ structured_output: { ok: true } }) + '\n');
    save({ end: Date.now() });
    return;
  }

  const mode = control.mode ?? 'ok';
  const delayMs = control.delayMs ?? 0;
  setTimeout(() => {
    switch (mode) {
      case 'ok':
      case 'slow':
        process.stdout.write(result({ structured_output: { name: 'Microsilica', got: stdin.length } }));
        break;
      case 'background': {
        // Succeeds but leaves a grandchild running in its process group.
        const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        save({ grandchild: g.pid, end: Date.now() });
        process.stdout.write(result({ structured_output: { name: 'Microsilica' } }));
        process.exit(0);
        break;
      }
      case 'split_utf8': {
        // Arabic split inside a character across two writes (two pipe reads).
        const bytes = Buffer.from(result({ structured_output: { name: 'غاز مكة', nameAr: 'مايكروسيليكا ' } }), 'utf8');
        const cut = bytes.indexOf(Buffer.from('غ', 'utf8')) + 1;
        process.stdout.write(bytes.subarray(0, cut), () => {
          setTimeout(() => {
            process.stdout.write(bytes.subarray(cut));
            save({ end: Date.now() });
          }, 100);
        });
        return;
      }
      case 'ok_limit_text':
        process.stdout.write(result({
          result: 'Claude AI usage limit reached, resets 3pm',
          structured_output: { note: 'Claude AI usage limit reached|resets 3pm', hit: 'You hit your usage limit' },
        }));
        break;
      case 'limit':
        process.stderr.write('Claude AI usage limit reached|1760000000\n');
        process.stdout.write(result({
          subtype: 'error_during_execution', is_error: true,
          result: 'Claude AI usage limit reached. Your limit resets 3pm (Asia/Riyadh).',
        }));
        save({ end: Date.now() });
        process.exit(1);
        break;
      case 'is_error':
        process.stdout.write(result({ is_error: true, result: 'Something went wrong: secret-model-text' }));
        save({ end: Date.now() });
        process.exit(1);
        break;
      case 'rate_limit':
        process.stdout.write(result({ is_error: true, result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}} Too Many Requests' }));
        save({ end: Date.now() });
        process.exit(1);
        break;
      case 'exit_fail':
        process.stderr.write('boom secret-cli-text ' + 'x'.repeat(500) + '\n');
        save({ end: Date.now() });
        process.exit(3);
        break;
      case 'no_structured':
        process.stdout.write(result({ result: 'plain words, no structured output' }));
        break;
      case 'hang': {
        // A grandchild in the same process group, to check the whole group dies.
        const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        save({ grandchild: g.pid });
        setInterval(() => {}, 1000);
        return;
      }
      default:
        process.exit(9);
    }
    save({ end: Date.now() });
  }, delayMs);
}
