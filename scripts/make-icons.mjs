// Renders docs/icons/icon.svg into the PNG sizes iOS, the web manifest and the Windows installer need.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const svg = await readFile(new URL('../docs/icons/icon.svg', import.meta.url));
const out = p => new URL('../' + p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const render = (size, file) => sharp(svg, { density: 300 }).resize(size, size).flatten({ background: '#f7a8c4' }).png().toFile(out(file));

await render(180, 'docs/icons/apple-touch-icon.png');
await render(192, 'docs/icons/icon-192.png');
await render(512, 'docs/icons/icon-512.png');
// maskable: Android/desktop may crop to a circle, so keep the artwork inside the inner 80%
await sharp(await sharp(svg, { density: 300 }).resize(410, 410).png().toBuffer())
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background: '#f7a8c4' })
  .flatten({ background: '#f7a8c4' }).png().toFile(out('docs/icons/icon-maskable-512.png'));
await render(512, 'build/icon.png');
await render(1024, 'build/icon-1024.png'); // iPhone app (IPA) icon
console.log('icons done');
