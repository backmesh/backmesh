// Stepping aside and the opt-out: a
// line scan, with no YAML parser, of the job's block in its checked-out
// workflow file, and of the local and downloaded actions it ran.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pm } from './job.js';

const indent = (line: string) => line.length - line.trimStart().length;
const blank = (line: string) =>
  !line.trim() || line.trimStart().startsWith('#');
// The lines a key or list item at lines[i] holds: those after it indented
// deeper, blank ones included.
function under(lines: readonly string[], i: number): string[] {
  let j = i + 1;
  while (
    j < lines.length &&
    (blank(lines[j]!) || indent(lines[j]!) > indent(lines[i]!))
  )
    j++;
  return lines.slice(i + 1, j);
}
// A scalar without its comment or quotes.
const unquote = (v: string) =>
  v
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');

// The workflow's top-level `env:` and the job's block, or undefined when the
// job isn't there.
export function jobLines(workflow: string, job: string): string[] | undefined {
  const lines = workflow.split(/\r?\n/);
  const top = (key: string) =>
    lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  const jobs = top('jobs');
  if (jobs < 0) return undefined;
  const body = under(lines, jobs);
  const depth = Math.min(...body.filter((l) => !blank(l)).map(indent));
  const at = body.findIndex(
    (l) =>
      indent(l) === depth &&
      /:\s*(#.*)?$/.test(l) &&
      unquote(l.replace(/:\s*(#.*)?$/, '')) === job,
  );
  if (at < 0) return undefined;
  const env = top('env');
  return [...(env < 0 ? [] : under(lines, env)), ...under(body, at)];
}

interface Step {
  action: string;
  // The `uses:` line's comment, which may name a pinned SHA's version.
  comment: string;
  lines: string[];
}

// Each list item with a `uses:`.
function steps(lines: readonly string[]): Step[] {
  const out: Step[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*-\s/.test(line)) return;
    const item = [line.replace('-', ' '), ...under(lines, i)];
    const uses = item
      .map((l) => /^\s*uses:\s*(.+)$/.exec(l)?.[1])
      .find(Boolean);
    if (uses)
      out.push({
        action: unquote(uses),
        comment: /#(.*)$/.exec(uses)?.[1] ?? '',
        lines: item,
      });
  });
  return out;
}

// An input's value: inline, or a block scalar's lines.
function input(step: Step, name: string): string | undefined {
  const i = step.lines.findIndex((l) => new RegExp(`^\\s*${name}:`).test(l));
  if (i < 0) return undefined;
  const inline = unquote(step.lines[i]!.replace(/^\s*[\w-]+:/, ''));
  return [inline.replace(/^[|>][-+]?$/, ''), ...under(step.lines, i)]
    .join('\n')
    .trim();
}

// Each manager's directory as a cache's `path:` names it, and the command
// whose output a `path:` expression may take instead.
const PATHS: [Pm, RegExp, RegExp][] = [
  ['npm', /\.npm\b/, /npm config get cache/],
  ['yarn', /\.cache\/yarn/, /yarn cache dir/],
  ['berry', /\.yarn\/berry/, /yarn config get cacheFolder/],
  ['pnpm', /pnpm\/store|pnpm-store/, /pnpm store path/],
];

export interface Package {
  packageManager?: unknown;
  devEngines?: { packageManager?: unknown };
}

// The scanned texts' verdict: `off`, and the managers the job caches itself.
export function judge(
  texts: readonly string[][],
  pkg: Package = {},
): { off: boolean; aside: Set<Pm> } {
  const off = texts[0]!.some((l) =>
    /^\s*BACKMESH_AUTO_CACHE:\s*(false|'false'|"false")\s*(#.*)?$/.test(l),
  );
  const all = texts.flat().join('\n');
  const aside = new Set<Pm>();
  // setup-node v5 and later caches npm unasked when the project names it.
  const npm = [
    pkg.packageManager,
    ...[pkg.devEngines?.packageManager].flat(),
  ].some((p) =>
    typeof p === 'string'
      ? p.startsWith('npm@')
      : (p as { name?: unknown } | undefined)?.name === 'npm',
  );
  for (const step of texts.flatMap(steps)) {
    const [action = '', ref = ''] = step.action.split('@');
    if (/^(actions|backmesh)\/cache(\/restore)?$/i.test(action)) {
      const path = input(step, 'path') ?? '';
      for (const [pm, dir, command] of PATHS)
        if (dir.test(path) || (path.includes('${{') && command.test(all)))
          aside.add(pm);
    }
    if (!/^actions\/setup-node$/i.test(action)) continue;
    // An expression counts as not caching.
    const cache = input(step, 'cache');
    if (cache === 'npm' || cache === 'pnpm') aside.add(cache);
    if (cache === 'yarn') aside.add('yarn').add('berry');
    // A SHA pin's version is in its comment; one not named is the newest.
    const major = Number(
      /^v?(\d+)(?:\.\d+)*$/.exec(ref)?.[1] ??
        /v(\d+)/.exec(step.comment)?.[1] ??
        99,
    );
    const auto = input(step, 'package-manager-cache') !== 'false';
    if (!cache && major >= 5 && auto && npm) aside.add('npm');
  }
  return { off, aside };
}

// Every action.yml under the runner's downloaded actions.
async function actionFiles(dir: string, depth = 0): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name);
    if (/^action\.ya?ml$/.test(name)) files.push(path);
    else if (depth < 6 && name !== 'node_modules' && name !== '.git')
      if ((await lstat(path).catch(() => undefined))?.isDirectory())
        files.push(...(await actionFiles(path, depth + 1)));
  }
  return files;
}

const text = (path: string) => readFile(path, 'utf8').catch(() => undefined);

// The job's verdict, or undefined when its workflow file can't be read: in
// another repository, or not checked out at the workspace's root.
export async function scanJob(
  workspace: string,
  repo: string,
  workflow: string,
  job: string,
  actions: string,
): Promise<ReturnType<typeof judge> | undefined> {
  const [owner, name, ...path] = workflow.split('/');
  if (`${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) return undefined;
  const file = await text(join(workspace, ...path));
  const lines = file && jobLines(file, job);
  if (!lines) return undefined;
  const texts = [lines];
  const local = steps(lines)
    .map((s) => s.action)
    .filter((a) => a.startsWith('./'))
    .flatMap((a) =>
      ['action.yml', 'action.yaml'].map((f) => join(workspace, a, f)),
    );
  for (const f of [...local, ...(await actionFiles(actions))]) {
    const t = await text(f);
    if (t) texts.push(t.split(/\r?\n/));
  }
  let pkg: Package = {};
  try {
    pkg = JSON.parse((await text(join(workspace, 'package.json'))) ?? '{}');
  } catch {
    // Not JSON: no packageManager.
  }
  return judge(texts, pkg);
}
