// Claude chat + GitHub-synced topics for the notebooks app.
// Bundled by `npm run bundle` into docs/vendor/nb-ai.js, exposed as window.NBAI.
import Anthropic from '@anthropic-ai/sdk';
import DOMPurify from 'dompurify';

const REPO = 'shalevd31/notebooks';
const TOPICS_PATH = 'docs/topics.json';
const BRANCH = 'main';
const MODEL = 'claude-opus-5-5';

/* ===== settings: keys live only on this device (localStorage), or in the desktop app's local config file ===== */
const SETTINGS_KEY = 'nb-settings';
function readLocal(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function writeLocal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// pasted text from chat apps can carry line breaks and invisible direction marks (RTL text especially)
const clean = s => String(s || '').replace(/[\s​-‏‪-‮⁦-⁩﻿­]/g, '');

export const settings = {
  get() {
    const local = readLocal(SETTINGS_KEY, {});
    const desk = (typeof window !== 'undefined' && window.nbConfig) || {};
    return { anthropicKey: clean(local.anthropicKey || desk.anthropicKey), githubToken: clean(local.githubToken || desk.githubToken) };
  },
  set(patch) {
    const p = {};
    for (const k in patch) p[k] = clean(patch[k]);
    writeLocal(SETTINGS_KEY, { ...readLocal(SETTINGS_KEY, {}), ...p });
  },
  // one string holding both keys, so the phone needs a single paste
  toSetupCode(s = this.get()) { return 'NB1:' + b64encode(JSON.stringify({ a: s.anthropicKey, g: s.githubToken })); },
  fromSetupCode(code) {
    const m = clean(code).match(/NB1:([A-Za-z0-9+/]+=*)/i);
    let o = null;
    try { o = m && JSON.parse(b64decode(m[1])); } catch {}
    if (!o || !(o.a || o.g)) throw new Error('קוד ההגדרה לא תקין. העתיקו את כל השורה, מ-NB1: ועד הסוף.');
    this.set({ anthropicKey: o.a || '', githubToken: o.g || '' });
  }
};

function b64encode(str) { const bytes = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function b64decode(b64) { const bin = atob(b64.replace(/\s/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }

/* ===== topics store: docs/topics.json in the GitHub repo, cached on the device for offline use ===== */
const CACHE_KEY = 'nb-topics-cache';
const API = `https://api.github.com/repos/${REPO}/contents/${TOPICS_PATH}`;

function ghHeaders(accept) {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  const t = settings.get().githubToken;
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}

async function fetchRemote() {
  const res = await fetch(`${API}?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders('application/vnd.github.object+json'), cache: 'no-store' });
  if (res.status === 404) return { topics: [], sha: null };
  if (!res.ok) throw new Error('GitHub ' + res.status);
  const meta = await res.json();
  let text;
  if (meta.encoding === 'base64' && meta.content) text = b64decode(meta.content);
  else { // over 1MB: the object response has no inline content
    const raw = await fetch(`${API}?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders('application/vnd.github.raw+json'), cache: 'no-store' });
    if (!raw.ok) throw new Error('GitHub ' + raw.status);
    text = await raw.text();
  }
  const data = JSON.parse(text);
  return { topics: Array.isArray(data.topics) ? data.topics : [], sha: meta.sha };
}

async function writeRemote(topics, sha, message) {
  if (!settings.get().githubToken) throw new Error('חסר טוקן של GitHub בהגדרות');
  const body = { message, branch: BRANCH, content: b64encode(JSON.stringify({ version: 1, topics }, null, 1)) };
  if (sha) body.sha = sha;
  const res = await fetch(API, { method: 'PUT', headers: { ...ghHeaders('application/vnd.github+json'), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) return false; // someone else wrote first; caller retries on fresh data
  if (res.status === 401 || res.status === 403) throw new Error('הטוקן של GitHub לא מאשר כתיבה (' + res.status + ')');
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return true;
}

export const topics = {
  cached() { return readLocal(CACHE_KEY, []); },
  async refresh() { const { topics: list } = await fetchRemote(); writeLocal(CACHE_KEY, list); return list; },
  async update(mutate, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { topics: list, sha } = await fetchRemote();
      const next = mutate(list.slice());
      if (await writeRemote(next, sha, message)) { writeLocal(CACHE_KEY, next); return next; }
    }
    throw new Error('השמירה נכשלה, נסו שוב');
  },
  save(topic) { return this.update(list => { const i = list.findIndex(t => t.id === topic.id); if (i >= 0) list[i] = topic; else list.push(topic); return list; }, `Topic: ${topic.title}`); },
  remove(id) { return this.update(list => list.filter(t => t.id !== id), `Remove topic ${id}`); }
};

/* ===== sanitizing model-written HTML before it goes into the page ===== */
export function sanitize(html) {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['id'] });
}

/* ===== Claude chat ===== */
const PROPOSE_TOOL = {
  name: 'propose_topic',
  description: 'Show the user a finished notebook topic as rendered notebook pages, with a button to add it to the notebook. Call it whenever you have a complete draft or a revised version; the user sees the pages right away.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short topic title in Hebrew, as it should appear in the table of contents (e.g. "שנאי").' },
      pages_html: { type: 'string', description: 'One or more <article class="paper">…</article> elements, one per notebook page, using only the classes from the style guide.' }
    },
    required: ['title', 'pages_html'],
    additionalProperties: false
  },
  eager_input_streaming: true
};

function systemPrompt(exampleHtml) {
  return `You help a student build hand-made-looking Hebrew study notebooks. Each notebook (e.g. "המרת אנרגיה", "מתמטיקה") holds topics, and each topic is one or more notebook pages of exam-ready summary.

The student gives you material: typed notes, photos of notebook or textbook pages, PDFs, or just a subject name. Chat with them in Hebrew, briefly and warmly. If the material is enough, write the summary right away; ask a question only when something essential is missing. When the topic is ready, call propose_topic. When they ask for changes, call propose_topic again with the full revised pages.

Content: accurate, exam-focused, clearly organized. Keep the student's own facts and numbers; fix clear mistakes and say so in the chat. Use the student's level and terminology.

Page HTML rules (pages_html):
- Each page is <article class="paper">…</article>. Aim for what fits a real notebook page (roughly 18–26 lines); split longer topics into several pages. Do not add page numbers, the app adds them.
- Title of the first page: <div class="ttl"><span>…</span></div>
- Section headings: <h2><span class="b">1. …</span></h2>, rotating the highlighter classes y (yellow), p (pink), b (blue), g (green).
- Body lines: <p>…</p>. Bullets as "• " at the start of a <p>. Arrows "←" for consequences.
- Inline: <span class="y|p|b|g">highlight</span>, <span class="u">pink underline</span>, <b>bold</b>, <p class="warn"><b>!!</b> warning</p> for common mistakes.
- Formulas: <div class="formula"><span>V = I · R</span></div> (left-to-right automatically).
- Tables: <div class="tbl"><table><tr><th>…</th></tr><tr><td>…</td></tr></table></div>
- Side-by-side text + small diagram: <div class="mode"><div>…text…</div><svg viewBox="0 0 200 128">…</svg></div>
- Diagrams: <div class="fig"><svg viewBox="…" role="img" aria-label="…">…</svg></div> hand-drawn in style: stroke #2a2a3c, pens #e0628f (pink) and #3a9ad9 (blue), fills #fff59d #f8c8e0 #b9e3f7 #c9e8c0, Hebrew <text> labels. Add a diagram when it genuinely helps (circuits, graphs, structures).
- Memory tip at the end when useful: <div class="tip"><div>★ <b>טיפ לזכירה:</b> …</div></div>
- No other tags or classes, no style blocks, no scripts, no id attributes.

Here is an existing topic from this notebook set. Match its look, density and tone:

${exampleHtml}`;
}

async function fileToBlock(file) {
  if (file.type === 'application/pdf') {
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(file); });
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  // photos: scale down to keep requests small and fast
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const data = c.toDataURL('image/jpeg', 0.85).split(',')[1];
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

export class ChatSession {
  constructor({ notebookTitle, exampleHtml, existing }) {
    this.system = systemPrompt(exampleHtml);
    this.notebookTitle = notebookTitle;
    this.existing = existing || null;
    this.history = [];      // append-only: every assistant turn is stored exactly as returned
    this.pendingTools = []; // tool_use blocks that still need a tool_result in the next user turn
    this.lastRequest = null;
  }

  client() {
    const key = settings.get().anthropicKey;
    if (!key) throw new Error('חסר מפתח API של Claude בהגדרות ⚙️');
    return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  }

  // onEvent({type: 'thinking'|'text'|'writing'|'proposal'|'done'|'error', ...})
  async send(text, files, onEvent) {
    const content = [];
    for (const t of this.pendingTools) content.push(t);
    this.pendingTools = [];
    if (!this.history.length) {
      let intro = `המחברת: ${this.notebookTitle}.`;
      if (this.existing) intro += `\nזה הנושא הקיים "${this.existing.title}" שהתלמיד רוצה לשנות:\n\n${this.existing.html}`;
      content.push({ type: 'text', text: intro });
    }
    for (const f of files || []) content.push(await fileToBlock(f));
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    this.history.push({ role: 'user', content });
    return this.run(onEvent);
  }

  // re-issue the same turn after a failure (nothing from the failed attempt was appended)
  retry(onEvent) { return this.run(onEvent); }

  async run(onEvent) {
    let client;
    try { client = this.client(); } catch (e) { onEvent({ type: 'error', message: e.message }); return; }
    onEvent({ type: 'thinking' });
    let message;
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: this.system,
        tools: [PROPOSE_TOOL],
        messages: this.history
      });
      let written = 0;
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') onEvent({ type: 'text', text: ev.delta.text });
        else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') { written += ev.delta.partial_json.length; onEvent({ type: 'writing', chars: written }); }
      }
      message = await stream.finalMessage();
    } catch (e) {
      onEvent({ type: 'error', message: describeError(e), retryable: true });
      return;
    }

    this.history.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'refusal') { onEvent({ type: 'error', message: 'Claude לא יכול לעזור עם הבקשה הזאת. נסו לנסח אחרת.' }); }

    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const inp = block.input || {};
      const ok = block.name === 'propose_topic' && message.stop_reason !== 'max_tokens'
        && typeof inp.title === 'string' && inp.title.trim() && typeof inp.pages_html === 'string' && inp.pages_html.includes('<article');
      if (ok) {
        this.pendingTools.push({ type: 'tool_result', tool_use_id: block.id, content: 'The pages were shown to the student as a preview with an "add to notebook" button.' });
        onEvent({ type: 'proposal', title: inp.title.trim(), html: sanitize(inp.pages_html) });
      } else {
        this.pendingTools.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'The pages were cut off or malformed and could not be shown. Write them again, shorter if needed.' });
        onEvent({ type: 'error', message: 'הדפים נקטעו באמצע. כתבו "שוב" ו-Claude יכתוב אותם מחדש.' });
      }
    }
    onEvent({ type: 'done' });
  }
}

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'מפתח ה-API של Claude לא תקין. בדקו בהגדרות ⚙️';
  if (e instanceof Anthropic.PermissionDeniedError) return 'למפתח ה-API אין הרשאה (' + e.status + ')';
  if (e instanceof Anthropic.RateLimitError) return 'יותר מדי בקשות כרגע, או שנגמר הקרדיט בחשבון. נסו שוב עוד רגע.';
  if (e instanceof Anthropic.BadRequestError) return 'הבקשה נדחתה: ' + e.message;
  if (e instanceof Anthropic.APIConnectionError) return 'אין חיבור לאינטרנט, או ש-Claude לא זמין כרגע.';
  if (e instanceof Anthropic.APIError) return 'שגיאה מ-Claude (' + e.status + '). נסו שוב.';
  return 'משהו השתבש: ' + (e && e.message || e);
}
