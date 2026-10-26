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

// docs/topics.json holds { version, topics: [...], notebooks: [...] } — topics and notebooks added from the app
const normalize = d => ({ topics: Array.isArray(d && d.topics) ? d.topics : [], notebooks: Array.isArray(d && d.notebooks) ? d.notebooks : [] });

async function fetchRemote() {
  const res = await fetch(`${API}?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders('application/vnd.github.object+json'), cache: 'no-store' });
  if (res.status === 404) return { data: normalize(null), sha: null };
  if (!res.ok) throw new Error('GitHub ' + res.status);
  const meta = await res.json();
  let text;
  if (meta.encoding === 'base64' && meta.content) text = b64decode(meta.content);
  else { // over 1MB: the object response has no inline content
    const raw = await fetch(`${API}?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders('application/vnd.github.raw+json'), cache: 'no-store' });
    if (!raw.ok) throw new Error('GitHub ' + raw.status);
    text = await raw.text();
  }
  return { data: normalize(JSON.parse(text)), sha: meta.sha };
}

async function writeRemote(data, sha, message) {
  if (!settings.get().githubToken) throw new Error('חסר טוקן של GitHub בהגדרות');
  const body = { message, branch: BRANCH, content: b64encode(JSON.stringify({ version: 2, ...data }, null, 1)) };
  if (sha) body.sha = sha;
  const res = await fetch(API, { method: 'PUT', headers: { ...ghHeaders('application/vnd.github+json'), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) return false; // someone else wrote first; caller retries on fresh data
  if (res.status === 401 || res.status === 403) throw new Error('הטוקן של GitHub לא מאשר כתיבה (' + res.status + ')');
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return true;
}

const upsert = (list, item) => { const i = list.findIndex(x => x.id === item.id); if (i >= 0) list[i] = item; else list.push(item); return list; };

export const store = {
  cached() { const c = readLocal(CACHE_KEY, null); return normalize(Array.isArray(c) ? { topics: c } : c); },
  async refresh() { const { data } = await fetchRemote(); writeLocal(CACHE_KEY, data); return data; },
  async update(mutate, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, sha } = await fetchRemote();
      const next = mutate({ topics: data.topics.slice(), notebooks: data.notebooks.slice() });
      if (await writeRemote(next, sha, message)) { writeLocal(CACHE_KEY, next); return next; }
    }
    throw new Error('השמירה נכשלה, נסו שוב');
  },
  saveTopic(topic) { return this.update(d => ({ ...d, topics: upsert(d.topics, topic) }), `Topic: ${topic.title}`); },
  removeTopic(id) { return this.update(d => ({ ...d, topics: d.topics.filter(t => t.id !== id) }), `Remove topic ${id}`); },
  saveNotebook(nb) { return this.update(d => ({ ...d, notebooks: upsert(d.notebooks, nb) }), `Notebook: ${nb.title}`); },
  removeNotebook(id) { return this.update(d => ({ topics: d.topics.filter(t => t.notebook !== id), notebooks: d.notebooks.filter(n => n.id !== id) }), `Remove notebook ${id}`); }
};

/* ===== sanitizing model-written HTML before it goes into the page ===== */
export function sanitize(html) {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['id'] });
}
// SVG drawing fragments (cover doodles): returns only the inner markup of a cleaned <svg>
export function sanitizeSvg(fragment) {
  const clean = DOMPurify.sanitize(`<svg xmlns="http://www.w3.org/2000/svg">${fragment || ''}</svg>`, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['style', 'script', 'foreignObject', 'image', 'use'], FORBID_ATTR: ['id', 'href', 'xlink:href'] });
  const m = clean.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
  return m ? m[1] : '';
}

/* ===== one-shot JSON calls (structured outputs): notebook covers, exams, grading ===== */
function makeClient() {
  const key = settings.get().anthropicKey;
  if (!key) throw new Error('חסר מפתח API של Claude בהגדרות ⚙️');
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

async function jsonCall({ system, content, schema, effort, onProgress }) {
  const client = makeClient();
  let message;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content }]
    });
    let chars = 0;
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') { chars += ev.delta.text.length; onProgress && onProgress(chars); }
    }
    message = await stream.finalMessage();
  } catch (e) { throw new Error(describeError(e)); }
  if (message.stop_reason === 'refusal') throw new Error('Claude לא יכול לעזור עם הבקשה הזאת.');
  if (message.stop_reason === 'max_tokens') throw new Error('התשובה של Claude נקטעה באמצע. נסו לבחור פחות עמודים.');
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); } catch { throw new Error('התשובה של Claude לא הגיעה בצורה תקינה. נסו שוב.'); }
}

const COVER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'fill', 'ring', 'paper', 'top_svg', 'bottom_svg'],
  properties: {
    title: { type: 'string', description: 'Notebook title in Hebrew, 1–3 short words' },
    fill: { type: 'string', description: 'Light pastel hex color for the title letters, e.g. #f7a8c4' },
    ring: { type: 'string', description: 'Darker saturated hex color of the same hue for outlines and the page-count badge, e.g. #d94f84' },
    paper: { type: 'string', enum: ['lines', 'grid'], description: 'grid for math/science/technical subjects that need drawing or calculation, lines otherwise' },
    top_svg: { type: 'string', description: 'SVG elements (no <svg> wrapper) for the top strip, viewBox 0 0 300 110' },
    bottom_svg: { type: 'string', description: 'SVG elements (no <svg> wrapper) for the bottom strip, viewBox 0 0 300 110' }
  }
};

export function designNotebook(subject, examples, onProgress) {
  const system = `You design covers for hand-decorated Hebrew school notebooks. Each cover is lined paper with a bubble-letter title in the middle and two doodle strips: one above the title and one below it. Each strip is an SVG drawing area of viewBox 0 0 300 110.

Draw 2–4 doodles per strip that clearly say the subject at a glance (e.g. history: scroll, ancient column, hourglass, map, quill; biology: cell, leaf, DNA, microscope). Keep the empty corners free: the app adds decorative corner brackets at the top-right (x 200–300, y 0–90) of the top strip and the bottom-left (x 0–100, y 20–110) of the bottom strip, so place doodles roughly in x 20–200 on the top strip and x 100–290 on the bottom strip.

Style: thick friendly outlines stroke="#2a2a3c" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round", flat bright fills (pinks, yellows, blues, greens, purples), no gradients, no text except a short word or symbol when it really helps (font-family="Rubik, Arial, sans-serif", font-weight 900). Allowed elements: g, path, rect, circle, ellipse, line, polyline, polygon, text. No <svg>, <style>, <image>, ids or scripts.

Here are covers already on the shelf; match their look and density:
${examples}`;
  return jsonCall({ system, content: `המקצוע של המחברת החדשה: ${subject}`, schema: COVER_SCHEMA, effort: 'medium', onProgress });
}

const EXAM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'questions'],
  properties: {
    title: { type: 'string', description: 'Exam title in Hebrew, e.g. "מבחן בחשמל בנושא: חוק אוהם ומעגלים טוריים"' },
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'topic', 'page', 'question', 'options', 'correct', 'answer', 'drawing'],
        properties: {
          type: { type: 'string', enum: ['mc', 'open'] },
          topic: { type: 'string', description: 'The notebook topic the question tests' },
          page: { type: 'integer', description: 'Notebook page the question is based on' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: 'mc: exactly 4 options, without letters. open: empty array' },
          correct: { type: 'integer', description: 'mc: index 0–3 of the correct option. open: -1' },
          answer: { type: 'string', description: 'mc: one-line explanation of why the answer is right. open: the complete model answer a teacher would accept, with key points' },
          drawing: { type: 'boolean', description: 'true when a good answer needs a drawing, graph, circuit or worked calculation' }
        }
      }
    }
  }
};

// count: a number the student chose, or null to let Claude size the exam to the material
export async function makeExam({ notebookTitle, mode, material, count }, onProgress) {
  const n = count ? `exactly ${count} questions` : 'as many questions as the material calls for (see the rules)';
  const kinds = mode === 'mc' ? `${n}, all multiple choice (type "mc")`
    : mode === 'open' ? `${n}, all open/written (type "open")`
    : `${n}, about half multiple choice ("mc") and half open ("open"), multiple choice first`;
  const system = `You are an experienced Israeli high-school teacher writing a real exam in Hebrew for the student's own notebook material.

Rules:
- Read every page of the material first. List for yourself every distinct thing worth testing: each concept, definition, fact, formula, process step, cause/effect, comparison, table row, diagram and warning. A dense notebook page usually holds 4–8 of these.
- Write about 2 questions for each of those items, and make the two questions on the same item test it in completely different ways (e.g. a definition vs. a calculation, recognizing vs. applying, a cause vs. a consequence, reading a table vs. using it). Every page and section must be covered; do not skip parts of the material.
- When the student did not fix the number of questions, the material decides it: typically 8–14 questions for two dense pages, fewer only for very short material, never more than 30. If the material holds more than 30 testable items, choose the most important ones and still spread the questions over all pages.
- Base every question only on the material provided.
- Multiple choice: exactly 4 options, one clearly correct, three plausible distractors built from typical mistakes. Vary the position of the correct answer.
- Open questions: clear, answerable in a few lines (or a short calculation / sketch), like a real exam.
- Order questions by topic order in the notebook. Write naturally, as on a printed exam, without numbering the questions yourself.`;
  const content = `מחברת: ${notebookTitle}\nסוג המבחן: ${kinds}.\n\nהחומר (לפי עמודים במחברת):\n\n${material}`;
  const exam = await jsonCall({ system, content, schema: EXAM_SCHEMA, effort: 'medium', onProgress });
  exam.questions = (exam.questions || []).filter(q => q.question && (q.type === 'open' || (Array.isArray(q.options) && q.options.length === 4 && q.correct >= 0 && q.correct <= 3))).slice(0, 30);
  if (!exam.questions.length) throw new Error('לא התקבלו שאלות. נסו שוב.');
  return exam;
}

const GRADE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['number', 'verdict', 'feedback'],
        properties: {
          number: { type: 'integer' },
          verdict: { type: 'string', enum: ['correct', 'partial', 'wrong'] },
          feedback: { type: 'string', description: 'One or two short sentences in Hebrew to the student: what was right, what was missing or wrong' }
        }
      }
    }
  }
};

// items: [{ number, question, answer (model answer), studentText, images: [dataURL] }]
export async function gradeOpen(items, onProgress) {
  const system = `You grade open questions on a Hebrew school exam, fairly, like a good teacher.

For each question compare the student's answer (text and/or attached drawings or photos of handwritten work) with the model answer:
- "correct": the answer is right and covers the key points; wording can differ, small slips that don't change the meaning are fine.
- "partial": on the right track but missing an important part, or a correct method with a calculation mistake.
- "wrong": incorrect, irrelevant, or empty.
Give short, encouraging, specific feedback in Hebrew.`;
  const content = [];
  for (const it of items) {
    content.push({ type: 'text', text: `שאלה ${it.number}: ${it.question}\nתשובת המורה: ${it.answer}\nתשובת התלמיד: ${it.studentText ? it.studentText : '(לא נכתב טקסט)'}${it.images.length ? `\n(מצורפים ${it.images.length} ציורים/צילומים של התלמיד לשאלה ${it.number})` : ''}` });
    for (const url of it.images) content.push({ type: 'image', source: { type: 'base64', media_type: url.slice(5, url.indexOf(';')), data: url.split(',')[1] } });
  }
  const out = await jsonCall({ system, content, schema: GRADE_SCHEMA, effort: 'medium', onProgress });
  return out.results || [];
}

// photo -> downscaled JPEG data URL (for exam answers)
export async function photoToDataUrl(file) { const b = await fileToBlock(file); return `data:${b.source.media_type};base64,${b.source.data}`; }

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

  client() { return makeClient(); }

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
