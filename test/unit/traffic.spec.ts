import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, '../../scripts/traffic.sh');
const day = new Date().toISOString().slice(0, 10);

// Runs scripts/traffic.sh in `dir` with gh and curl replaced: gh answers each
// API path with `answers`' entry, curl with `clicks`.
function run(
  dir: string,
  env: Record<string, string>,
  answers: Record<string, unknown>,
  clicks?: unknown,
) {
  const bin = mkdtempSync(join(tmpdir(), 'traffic-bin-'));
  writeFileSync(join(bin, 'answers.json'), JSON.stringify(answers));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // The path is the argument after `api`'s options; --jq applies as gh would.
  stub(
    'gh',
    `path=$(printf '%s\\n' "$@" | grep -m1 '^repos/'); path=\${path%%\\?*}
filter=.; for ((i=1; i<=$#; i++)); do [[ \${!i} == --jq ]] && { j=$((i+1)); filter=\${!j}; }; done
jq -c --arg p "$path" '.[$p]' "${bin}/answers.json" | jq -c "$filter"`,
  );
  stub(
    'curl',
    clicks === undefined ? 'exit 22' : `echo '${JSON.stringify(clicks)}'`,
  );
  const result = spawnSync('bash', [script, 'backmesh/backmesh'], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
const json = (dir: string, file: string) =>
  JSON.parse(readFileSync(join(dir, file), 'utf8'));

const stars = [
  { user: { login: 'b' }, starred_at: '2026-11-24T10:00:00Z' },
  { user: { login: 'a' }, starred_at: '2026-11-20T10:00:00Z' },
];
const traffic = (views: unknown[]) => ({
  'repos/backmesh/backmesh/stargazers': stars,
  'repos/backmesh/backmesh/traffic/views': { views },
  'repos/backmesh/backmesh/traffic/clones': { clones: [] },
  'repos/backmesh/backmesh/traffic/popular/referrers': [
    { referrer: 'news.ycombinator.com', count: 9, uniques: 7 },
  ],
  'repos/backmesh/backmesh/traffic/popular/paths': [],
});

describe('scripts/traffic.sh', () => {
  it('keeps every day seen, the newest run winning, and each run of the 14-day tops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traffic-'));
    const env = {
      TRAFFIC_TOKEN: 't',
      CLOUDFLARE_API_TOKEN: 'c',
      CLOUDFLARE_ACCOUNT_ID: 'a',
    };
    const day1 = { timestamp: '2026-11-10T00:00:00Z', count: 1, uniques: 1 };
    run(
      dir,
      env,
      traffic([
        day1,
        { timestamp: '2026-11-24T00:00:00Z', count: 2, uniques: 1 },
      ]),
      { data: [{ day: '2026-11-24', channel: 'hn', clicks: '3' }] },
    );
    run(
      dir,
      env,
      traffic([{ timestamp: '2026-11-24T00:00:00Z', count: 5, uniques: 4 }]),
      {
        data: [
          { day: '2026-11-24', channel: 'hn', clicks: '4' },
          { day: '2026-11-24', channel: 'x', clicks: '1' },
        ],
      },
    );
    expect(json(dir, 'backmesh/stargazers.json')).toEqual([
      { login: 'a', starred_at: '2026-11-20T10:00:00Z' },
      { login: 'b', starred_at: '2026-11-24T10:00:00Z' },
    ]);
    expect(json(dir, 'backmesh/views.json')).toEqual([
      day1,
      { timestamp: '2026-11-24T00:00:00Z', count: 5, uniques: 4 },
    ]);
    expect(json(dir, `backmesh/referrers/${day}.json`)).toEqual([
      { referrer: 'news.ycombinator.com', count: 9, uniques: 7 },
    ]);
    expect(json(dir, 'go-links.json')).toEqual([
      { day: '2026-11-24', channel: 'hn', clicks: 4 },
      { day: '2026-11-24', channel: 'x', clicks: 1 },
    ]);
  });

  it('keeps the stargazers alone without tokens, and warns when Cloudflare fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traffic-'));
    expect(run(dir, {}, traffic([]))).toContain('No TRAFFIC_TOKEN');
    expect(existsSync(join(dir, 'backmesh/stargazers.json'))).toBe(true);
    expect(existsSync(join(dir, 'backmesh/views.json'))).toBe(false);
    expect(
      run(
        dir,
        { CLOUDFLARE_API_TOKEN: 'c', CLOUDFLARE_ACCOUNT_ID: 'a' },
        traffic([]),
      ),
    ).toContain("::warning::Couldn't read the /go/ link clicks");
  });
});
