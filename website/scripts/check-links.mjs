// Fails when a page in the build links to a page, file or #anchor on this
// site that the build doesn't have. External links aren't fetched.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'dist';
const pages = readdirSync(root, { recursive: true }).filter((f) =>
  f.endsWith('.html'),
);
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) {
    const html = readFileSync(file, 'utf8');
    ids.set(
      file,
      new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
    );
  }
  return ids.get(file);
};
const target = (path) => {
  const file = join(root, decodeURIComponent(path));
  if (existsSync(join(file, 'index.html'))) return join(file, 'index.html');
  if (existsSync(file) && statSync(file).isFile()) return file;
};

const broken = [];
for (const page of pages) {
  const file = join(root, page);
  const html = readFileSync(file, 'utf8');
  for (const [, link] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|data:|\/\/)/.test(link)) continue;
    const [path, anchor] = link.split('#');
    const resolved = path
      ? target(path.startsWith('/') ? path : join('/', page, '..', path))
      : file;
    if (
      !resolved ||
      (anchor &&
        resolved.endsWith('.html') &&
        !idsOf(resolved).has(decodeURIComponent(anchor)))
    ) {
      broken.push(`${page}: ${link}`);
    }
  }
}
if (broken.length) {
  console.error(`Broken links:\n${broken.join('\n')}`);
  process.exit(1);
}
console.log(`Checked the links in ${pages.length} pages.`);
