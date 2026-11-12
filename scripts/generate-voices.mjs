// Records every fixed DJ line as an audio clip so the radio can play human-sounding hosts.
// Reads the lines straight from index.html, so the app and the recordings never drift apart.
//
//   OPENAI_API_KEY=...      node scripts/generate-voices.mjs
//   ELEVENLABS_API_KEY=...  PROVIDER=elevenlabs node scripts/generate-voices.mjs
//   node scripts/generate-voices.mjs --dry      (list lines and character count, call nothing)
//
// Options (env): PROVIDER=openai|elevenlabs, FORCE=1 (re-record everything), ONLY=wave,xs (some hosts only)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dry = process.argv.includes('--dry');
const provider = (process.env.PROVIDER || (process.env.ELEVENLABS_API_KEY && !process.env.OPENAI_API_KEY ? 'elevenlabs' : 'openai')).toLowerCase();
const force = process.env.FORCE === '1' || process.env.FORCE === 'true';
const only = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const config = JSON.parse(fs.readFileSync(path.join(root, 'voices/config.json'), 'utf8'));

// Same hash the app uses to look a line up.
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const data = html.match(/<script id="data">([\s\S]*?)<\/script>/);
if (!data) throw new Error('Could not find the station data block in index.html');
const box = {};
vm.runInNewContext(data[1] + '\n;__out={PERSONAS,DEFAULT_STATIONS};', box);
const { PERSONAS, DEFAULT_STATIONS } = box.__out;

const perHost = [];
for (const st of DEFAULT_STATIONS) {
  const key = st.persona, p = PERSONAS[key];
  if (!p || (only.length && !only.includes(key))) continue;
  const L = p.lines, tod = Object.values(L.tod);
  // Most useful first: one intro, two station IDs, two talk breaks, then the rest.
  const lines = [L.intro[0], L.ident[0], L.ident[1], L.talk[0], L.talk[1], L.intro[1], L.ident[2], L.talk[2], ...tod,
    ...L.intro.slice(2), ...L.ident.slice(3), ...L.talk.slice(3)].filter(Boolean);
  perHost.push(lines.map(raw => {
    const text = raw.replace(/\{st\}/g, st.name).replace(/\{dj\}/g, p.name);
    const id = hash(key + '|' + text);
    return { key, text, id, file: `voices/${key}/${id}.mp3` };
  }));
}
const jobs = [];
for (let i = 0; perHost.some(h => i < h.length); i++) for (const h of perHost) if (h[i]) jobs.push(h[i]);
const chars = jobs.reduce((n, j) => n + j.text.length, 0);
console.log(`${jobs.length} lines, ${chars} characters, provider: ${provider}`);
if (dry) { for (const j of jobs) console.log(`[${j.key}] ${j.text}`); process.exit(0); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(url, init, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, init);
    if (r.ok) return r;
    const body = (await r.text()).slice(0, 400);
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(2000 * (i + 1)); continue; }
    throw new Error(`${new URL(url).host} answered ${r.status}: ${body}`);
  }
}

async function openai(job) {
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('OPENAI_API_KEY is not set');
  const c = config.openai, v = c.personas[job.key] || {};
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const body = { model: process.env.OPENAI_TTS_MODEL || c.model, voice: v.voice || 'alloy', input: job.text, response_format: 'mp3' };
  if (v.instructions) body.instructions = v.instructions;
  const r = await call(base + '/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return Buffer.from(await r.arrayBuffer());
}

let elVoices = null, elCast = null;
async function elevenVoice(personaKey) {
  const key = process.env.ELEVENLABS_API_KEY, base = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
  if (!elVoices) {
    const r = await call(base + '/v1/voices', { headers: { 'xi-api-key': key } });
    elVoices = (await r.json()).voices || [];
    if (!elVoices.length) throw new Error('This ElevenLabs account has no voices. Add some in the ElevenLabs voice library first.');
    console.log('ElevenLabs voices on this account: ' + elVoices.map(v => v.name).join(', '));
  }
  if (!elCast) {
    // Cast every host once: a named voice wins; otherwise score the account's voices against the
    // host's brief (gender, accent, character words) and never give two hosts the same voice if avoidable.
    elCast = {};
    const used = new Set(), text = v => JSON.stringify([v.name, v.labels || {}, v.description || '']).toLowerCase();
    for (const [key, c] of Object.entries(config.elevenlabs.personas)) {
      const want = (c.voice || '').trim().toLowerCase();
      let pick = want && elVoices.find(v => v.voice_id.toLowerCase() === want || v.name.toLowerCase() === want || v.name.toLowerCase().startsWith(want));
      if (!pick) {
        const score = v => {
          const t = text(v), g = ((v.labels || {}).gender || '').toLowerCase(), a = ((v.labels || {}).accent || '').toLowerCase();
          let n = used.has(v.voice_id) ? -6 : 0;
          if (c.gender && g) n += g === c.gender ? 5 : -5;
          (c.accent || []).forEach((x, i) => { if (a.includes(x)) n += 3 - i * 0.5; });
          (c.words || []).forEach(w => { if (t.includes(w)) n += 1; });
          return n;
        };
        pick = elVoices.slice().sort((x, y) => score(y) - score(x))[0];
      }
      used.add(pick.voice_id); elCast[key] = pick;
      console.log(`cast ${key}: ${pick.name} (${Object.values(pick.labels || {}).join(', ')})`);
    }
  }
  return elCast[personaKey] || elVoices[0];
}
async function elevenlabs(job) {
  const key = process.env.ELEVENLABS_API_KEY; if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
  const base = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
  const v = await elevenVoice(job.key);
  const r = await call(`${base}/v1/text-to-speech/${v.voice_id}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: job.text, model_id: process.env.ELEVENLABS_MODEL || config.elevenlabs.model })
  });
  return Buffer.from(await r.arrayBuffer());
}

const speak = provider === 'elevenlabs' ? elevenlabs : openai;
let made = 0, kept = 0, stopped = null;
const fresh = new Set();
for (const job of jobs) {
  const abs = path.join(root, job.file);
  if (!force && fs.existsSync(abs) && fs.statSync(abs).size > 1000) { kept++; fresh.add(job.file); continue; }
  try {
    const audio = await speak(job);
    if (audio.length < 1000) throw new Error(`The recording for "${job.text}" came back empty.`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, audio);
  } catch (e) { stopped = e; break; }
  made++; fresh.add(job.file);
  console.log(`recorded [${job.key}] ${job.text}`);
}
if (stopped && !made) { console.error('Nothing was recorded: ' + stopped.message); process.exit(1); }
if (stopped) console.log(`::warning::Stopped after ${made} new recordings (${jobs.length - made - kept} lines still to do): ${stopped.message}`);

// Drop recordings of lines that no longer exist, then write the manifest the app reads.
const wanted = force ? fresh : new Set(jobs.map(j => j.file));
if (!only.length) for (const dir of fs.readdirSync(path.join(root, 'voices'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(root, 'voices', dir.name))) {
    const rel = `voices/${dir.name}/${f}`;
    if (f.endsWith('.mp3') && !wanted.has(rel)) { fs.unlinkSync(path.join(root, rel)); console.log('removed stale ' + rel); }
  }
}
const clips = {};
for (const dir of fs.readdirSync(path.join(root, 'voices'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(root, 'voices', dir.name))) if (f.endsWith('.mp3')) clips[f.slice(0, -4)] = `voices/${dir.name}/${f}`;
}
fs.writeFileSync(path.join(root, 'voices/manifest.json'), JSON.stringify({ version: 1, provider, clips }, null, 1) + '\n');
console.log(`done: ${made} recorded, ${kept} already there, ${Object.keys(clips).length} clips in the manifest`);
