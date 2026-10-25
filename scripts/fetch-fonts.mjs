// Downloads the Google Fonts used by the notebooks (incl. the Hebrew subset) into docs/fonts,
// so the app looks the same with no internet connection.
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Amatic+SC:wght@700&family=Playpen+Sans+Hebrew:wght@400;600&family=Rubik:wght@400;500;700;900&display=swap';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const OUT = new URL('../docs/fonts/', import.meta.url);

await mkdir(OUT, { recursive: true });
let css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text();
const urls = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map(m => m[1]))];

for (const url of urls) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const name = createHash('sha1').update(url).digest('hex').slice(0, 12) + '.woff2';
  await writeFile(new URL(name, OUT), buf);
  css = css.replaceAll(url, name);
}
await writeFile(new URL('fonts.css', OUT), css);
console.log(`saved ${urls.length} font files`);
