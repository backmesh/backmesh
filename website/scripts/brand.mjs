// Generates the brand assets in public/brand: the wordmark outlined to paths
// with its three stacked squares (the CLI's cursor, split in three for the
// clouds), the b-and-squares mark, the favicons and the OG image.
// Run `yarn brand` after changing a color, the mark or the wordmark, and
// commit the output.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import * as fontkit from 'fontkit';
import { decompress } from 'wawoff2';

const out = new URL('../public/brand/', import.meta.url);
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
// fontkit can't instance a WOFF2 variable font, so it reads the plain TTF.
const font = async (file) =>
  fontkit.create(
    Buffer.from(await decompress(readFileSync(require.resolve(file)))),
  );
const sans = await font(
  '@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2',
);
const mono = await font(
  '@fontsource/fragment-mono/files/fragment-mono-latin-400-normal.woff2',
);

// The tokens (src/styles/tokens.css).
const light = {
  ink: '#15171a',
  soft: '#5f6670',
  accent: '#0e6ba8',
  hair: '#e6e8eb',
};
const dark = { ink: '#eceff2', accent: '#7cc4f5' };

// Text as one outlined path, laid out with the font's kerning.
function outline(face, text, size, x, y, { spacing = 0, axes } = {}) {
  const instance = axes ? face.getVariation(axes) : face;
  const run = instance.layout(text);
  const s = size / instance.unitsPerEm;
  let pen = x;
  let d = '';
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    d += glyph.path
      .scale(s, -s)
      .translate(pen + pos.xOffset * s, y - pos.yOffset * s)
      .toSVG();
    pen += pos.xAdvance * s + spacing;
  });
  return { d, width: pen - spacing - x };
}

const n = (v) => +v.toFixed(2);
const svg = (w, h, body, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}"${label ? ` role="img" aria-label="${label}"` : ''}>${body}</svg>\n`;
const bold = { wght: 700 };

// Three stacked squares, `w` wide, standing on y = bottom.
const stack = (x, bottom, w, fill) => {
  const gap = w / 6;
  const h = (w * 17) / 6 / 3 - gap / 1.5;
  let body = '';
  for (let i = 0; i < 3; i++) {
    const y = bottom - (3 - i) * h - (2 - i) * gap;
    body += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
  }
  return body;
};

// The lockup: "backmesh" at 30 units, tracked as on the page (-0.035em),
// and the squares as tall as the ascenders, standing on the baseline 0.12em
// after the h.
const SIZE = 30;
const BASE = 26;
const word = outline(sans, 'backmesh', SIZE, 0, BASE, {
  spacing: -0.035 * SIZE,
  axes: bold,
});
const stackW = 0.257 * SIZE;
const stackX = word.width + 0.12 * SIZE;
const lockupW = Math.ceil(stackX + stackW + 1);
const lockup = ({ ink, accent }) =>
  `<path d="${word.d}" fill="${ink}"/>` + stack(stackX, BASE, stackW, accent);

// The mark: the wordmark's own b and the squares, in a 32-unit square.
const b = outline(sans, 'b', 30, 3.5, 27.5, { axes: bold });
const mark = ({ ink, accent }) =>
  `<path d="${b.d}" fill="${ink}"/>` +
  stack(3.5 + b.width + 2.2, 27.5 - 0.5, 6.2, accent);

const variants = {
  light: light,
  dark: dark,
  mono: { ink: 'currentColor', accent: 'currentColor' },
};
const files = {};
for (const [name, colors] of Object.entries(variants)) {
  files[`lockup-${name}.svg`] = svg(lockupW, 32, lockup(colors), 'backmesh');
  files[`mark-${name}.svg`] = svg(32, 32, mark(colors), 'backmesh');
}

// The favicons, on an ink tile: the mark at 32 px and up, the squares alone
// at 16 px, where the b's counter would fill in.
const tile = (r) =>
  `<rect width="32" height="32" rx="${r}" fill="${light.ink}"/>`;
const favicon = svg(
  32,
  32,
  tile(7) + mark({ ink: '#ffffff', accent: dark.accent }),
);
files['favicon.svg'] = favicon;
const small = svg(
  16,
  16,
  `<rect width="16" height="16" rx="3" fill="${light.ink}"/>${stack(5, 14, 6, dark.accent)}`,
);

const png = (source, width) =>
  new Resvg(source, { fitTo: { mode: 'width', value: width } })
    .render()
    .asPng();

// The ICO holds PNG images: a 6-byte header, a 16-byte entry per image.
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size, at);
    header.writeUInt8(size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}
files['favicon.ico'] = ico([
  { size: 16, data: png(small, 16) },
  { size: 32, data: png(favicon, 32) },
  { size: 48, data: png(favicon, 48) },
]);
files['icon-512.png'] = png(favicon, 512);
// iOS rounds the corners itself, so the touch icon is a full square.
files['apple-touch-icon.png'] = png(
  svg(
    32,
    32,
    tile(0) +
      `<g transform="translate(4 4) scale(.75)">${mark({ ink: '#ffffff', accent: dark.accent })}</g>`,
  ),
  180,
);

// The OG image, 1200 x 630: the lockup, the page's headline and lede, and
// the agent prompt under a hairline, as the page sets them.
function og() {
  const head = ['Self-hosted GitHub Actions', 'runners for up to 10× less.']
    .map(
      (line, i) =>
        outline(sans, line, 82, 80, 278 + i * 88, {
          spacing: -82 * 0.036,
          axes: bold,
        }).d,
    )
    .join('');
  const lede = outline(
    sans,
    'Each job runs on its own spot VM in your AWS, GCP or Azure account.',
    28,
    80,
    420,
    {
      axes: { wght: 400 },
    },
  );
  const note = outline(
    mono,
    '# Paste into Claude Code, Codex, or another coding agent',
    20,
    80,
    506,
  );
  const prompt = outline(
    mono,
    'set up https://backmesh.com/SKILL.md',
    30,
    80,
    556,
  );
  return svg(
    1200,
    630,
    `<rect width="1200" height="630" fill="#ffffff"/>` +
      `<g transform="translate(80 64) scale(1.6)">${lockup(light)}</g>` +
      `<path d="${head}" fill="${light.ink}"/>` +
      `<path d="${lede.d}" fill="${light.soft}"/>` +
      `<rect x="80" y="462" width="1040" height="1" fill="${light.hair}"/>` +
      `<path d="${note.d}" fill="${light.soft}"/>` +
      `<path d="${prompt.d}" fill="${light.ink}"/>` +
      `<rect x="80" y="578" width="${n(prompt.width)}" height="2" fill="${light.ink}"/>`,
  );
}
files['og.png'] = png(og(), 1200);

for (const [name, data] of Object.entries(files)) {
  writeFileSync(new URL(name, out), data);
}
console.log(`Wrote ${Object.keys(files).length} files to public/brand/.`);
