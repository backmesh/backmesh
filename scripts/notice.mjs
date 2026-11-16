// Prints the third-party notices for bundles Bun built: each package its
// `// node_modules/…` markers name, with its licence file once per distinct
// text, and any bundled file's own copyright header its licence file lacks
// (Bun strips comments, so a notice kept only there would be lost).
//
//   node scripts/notice.mjs <bundle>...
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const files = new Set();
for (const bundle of process.argv.slice(2)) {
  for (const [, file] of readFileSync(bundle, 'utf8').matchAll(
    /^\/\/ (\S*node_modules\/\S+)$/gm,
  ))
    files.add(file);
}

const flat = (text) => text.replace(/\s+/g, ' ');
// The comments near a file's top that hold a copyright: runs of `//` lines
// and `/* … */` blocks, each on its own.
function headers(file) {
  const blocks = [];
  let block = [];
  let kind = null;
  const flush = () => {
    if (block.some((l) => /copyright/i.test(l))) blocks.push(block.join('\n'));
    block = [];
    kind = null;
  };
  for (const line of readFileSync(file, 'utf8').slice(0, 4000).split('\n')) {
    const text = line.trim();
    if (kind !== '/*') {
      const next = text.startsWith('/*') ? '/*' : text.startsWith('//') && '//';
      if (next !== kind || next === '/*') flush();
      kind = next || null;
      if (!kind) continue;
    }
    block.push(text);
    if (kind === '/*' && text.includes('*/')) flush();
  }
  flush();
  return blocks;
}

// A header's copyright holder: its copyright line, up to the first sentence's
// end, without "All rights reserved".
const holderOf = (header) =>
  flat(header.split('\n').find((l) => /copyright/i.test(l)))
    .replace(/^[/*!\s]+/, '')
    .replace(/\.(\s.*)?$/, '')
    .replace(/\s*all rights reserved/i, '');

const packages = new Map();
for (const file of [...files].sort()) {
  const dir = file.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)[1];
  if (!packages.has(dir)) {
    const { name, version, license, author } = JSON.parse(
      readFileSync(`${dir}/package.json`, 'utf8'),
    );
    const found = readdirSync(dir).find((n) =>
      /^(licen[cs]e|copying)/i.test(n),
    );
    const text = found
      ? readFileSync(`${dir}/${found}`, 'utf8').replace(/\r/g, '').trim()
      : `${license}, ${author?.name ?? author}. The package ships no licence file.`;
    packages.set(dir, {
      id: `${name} ${version} (${license})`,
      text,
      extra: [],
      holders: new Set(),
    });
  }
  const pkg = packages.get(dir);
  if (!existsSync(file)) continue;
  for (const header of headers(file)) {
    const holder = holderOf(header);
    if (flat(pkg.text).includes(holder) || pkg.holders.has(holder)) continue;
    pkg.holders.add(holder);
    pkg.extra.push(header);
  }
}

const groups = new Map();
for (const { id, text, extra } of packages.values()) {
  const body = [text, ...extra].join('\n\n');
  if (!groups.has(body)) groups.set(body, []);
  groups.get(body).push(id);
}
for (const [body, ids] of groups)
  process.stdout.write(`\n${'-'.repeat(78)}\n\n${ids.join('\n')}\n\n${body}\n`);
