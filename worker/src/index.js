// Balaton Routing – visszajelzés- és polárbeküldő Worker.
//
// POST /submit  (JSON)  ->  GitHub issue a nagyb187/balatonroute tárolóban.
//
// Biztonság:
// - A GitHub token (GITHUB_TOKEN) kizárólag Cloudflare secret, sehol máshol nincs.
// - CORS: csak az ALLOWED_ORIGIN (https://balatonrouting.hu) hívhatja.
// - Turnstile ellenőrzés (TURNSTILE_SECRET secret) + hostname-ellenőrzés.
// - Rate limit: Workers Rate Limiting binding (SUBMIT_LIMITER, IP-hash szerint),
//   opcionálisan napi plafon KV-ben (FEEDBACK_KV: IP-hashenként és összesen).
// - Méretkorlátok, vezérlőkarakter-szűrés, @említések és HTML semlegesítése.
// - E-mail-címet nem gyűjtünk; IP-címet nem tárolunk (csak sózott hash, rövid TTL-lel).

import { parsePolarCsv, POLAR_LIMITS } from '../../js/polar-csv.js';

export const LIMITS = Object.freeze({
  bodyBytes: 32 * 1024,
  title: 120,
  text: 4000,
  short: 80,
  env: 300,
  perIpPerDay: 10,
  globalPerDay: 150
});

const TYPES = {
  bug: { label: 'hiba', prefix: 'Hiba' },
  feedback: { label: 'javaslat', prefix: 'Javaslat' },
  polar: { label: 'polár-kérés', prefix: 'Polár-kérés' }
};
const CONSENT_LABEL = 'publikálható-név';
const SOURCE_LABELS = {
  orc: 'ORC-bizonyítvány',
  gyarto: 'Gyártói / tervezői polár',
  meres: 'Saját mérés (pl. műszerlog)',
  becsles: 'Becslés / tapasztalat',
  egyeb: 'Egyéb'
};

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(env, status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(env),
      ...extra
    }
  });
}

// --- Szövegtisztítás ---------------------------------------------------------

/** Vezérlőkarakterek, bidi-trükkök eltávolítása, hossz-korlát. */
export function cleanText(v, max, { multiline = true } = {}) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'bad_field', 'Hibás mezőtípus.');
  let s = v.normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // C0/C1 vezérlők (a \n és \t kivételével), zero-width és bidi override karakterek
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  if (!multiline) s = s.replace(/\s+/g, ' ');
  s = s.trim();
  if (s.length > max) throw new HttpError(400, 'too_long', `Túl hosszú szöveg (legfeljebb ${max} karakter).`);
  return s;
}

/** Markdown-biztos változat: HTML-tagek, @említések, #hivatkozások semlegesítése. */
export function mdSafe(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // @felhasználó / @szervezet ne értesítsen senkit
    .replace(/@(?=[A-Za-z0-9-])/g, '@\u200B')
    // #123 ne hivatkozzon más jegyekre
    .replace(/#(?=\d)/g, '#\u200B');
}

/** Idézetblokk több sorból, hogy a beküldött szöveg ne törje meg a jegy szerkezetét. */
const quote = (s) => s.split('\n').map((l) => '> ' + mdSafe(l)).join('\n');

// --- Bemenet ellenőrzése -----------------------------------------------------

export function validateSubmission(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_json', 'Hibás kérés.');
  const type = data.type;
  if (!Object.hasOwn(TYPES, type)) throw new HttpError(400, 'bad_type', 'Ismeretlen beküldés-típus.');
  // Honeypot: emberi felhasználó nem tölti ki
  if (typeof data.website === 'string' && data.website.trim() !== '') throw new HttpError(400, 'rejected', 'A beküldés elutasítva.');

  // Kötelező, kifejezett tudomásulvétel/hozzájárulás a nyilvános közzétételhez (GDPR 6. cikk (1) a)).
  if (data.publicAck !== true) throw new HttpError(400, 'missing_public_ack', 'Jelöld be, hogy megértetted: a beküldés nyilvános lesz.');
  const env = cleanText(data.env, LIMITS.env, { multiline: false });
  if (type === 'bug' || type === 'feedback') {
    const title = cleanText(data.title, LIMITS.title, { multiline: false });
    const description = cleanText(data.description, LIMITS.text);
    const steps = type === 'bug' ? cleanText(data.steps, LIMITS.text) : '';
    if (title.length < 3) throw new HttpError(400, 'missing_title', 'Adj meg egy rövid címet.');
    if (description.length < 10) throw new HttpError(400, 'missing_description', 'Írd le néhány mondatban (legalább 10 karakter).');
    return { type, title, description, steps, env };
  }
  // polar
  const boatType = cleanText(data.boatType, LIMITS.short, { multiline: false });
  const consent = data.consent === true;
  // A hajónév csak kifejezett hozzájárulással kerülhet a (nyilvános) jegybe.
  // Hozzájárulás nélkül a beküldött nevet eldobjuk: nem kerül a jegybe, és sehol nem tároljuk.
  const boatName = consent ? cleanText(data.boatName, LIMITS.short, { multiline: false }) : '';
  const notes = cleanText(data.notes, LIMITS.text);
  const source = typeof data.source === 'string' && Object.hasOwn(SOURCE_LABELS, data.source) ? data.source : 'egyeb';
  if (boatType.length < 2) throw new HttpError(400, 'missing_boat_type', 'Add meg a hajótípust.');
  if (typeof data.csv !== 'string') throw new HttpError(400, 'missing_csv', 'Hiányzik a polár CSV.');
  if (data.csv.length > POLAR_LIMITS.maxBytes) throw new HttpError(400, 'csv_too_large', 'Túl nagy a polár CSV.');
  const polar = parsePolarCsv(data.csv);
  if (!polar.ok) {
    const e = new HttpError(400, 'bad_csv', 'A polár CSV hibás.');
    e.details = polar.errors.slice(0, 10);
    throw e;
  }
  if (data.rightsConfirmed !== true) throw new HttpError(400, 'missing_rights', 'Erősítsd meg, hogy megoszthatod a polárt.');
  return { type, boatType, boatName, notes, source, consent: consent && boatName !== '', polar, env };
}

// --- GitHub-jegy összeállítása -----------------------------------------------

export function buildIssue(sub) {
  const t = TYPES[sub.type];
  const labels = [t.label];
  const footer = '\n\n---\n<sub>A balatonrouting.hu webes űrlapjáról érkezett. A beküldő tudomásul vette, hogy a beküldés nyilvános. Nem GitHub-felhasználó, itt nem tud válaszolni.</sub>';
  const envLine = sub.env ? `\n\n**Környezet:** \`${sub.env.replace(/`/g, "'")}\`` : '';
  if (sub.type === 'bug' || sub.type === 'feedback') {
    let body = `### ${sub.type === 'bug' ? 'Mi történt?' : 'Javaslat / visszajelzés'}\n\n${quote(sub.description)}`;
    if (sub.steps) body += `\n\n### Hogyan lehet előidézni?\n\n${quote(sub.steps)}`;
    body += envLine + footer;
    return { title: `[${t.prefix}] ${sub.title}`, body, labels };
  }
  if (sub.consent) labels.push(CONSENT_LABEL);
  const name = sub.consent ? ` – ${sub.boatName}` : '';
  const p = sub.polar;
  let body = '### Hajó\n\n' +
    `- **Típus:** ${mdSafe(sub.boatType)}\n` +
    (sub.consent ? `- **Név:** ${mdSafe(sub.boatName)} _(a beküldő hozzájárult a közzétételhez)_\n` : '') +
    `- **Forrás:** ${SOURCE_LABELS[sub.source]}\n` +
    `- **Hajónév a nyilvános polárlistában:** ${sub.consent ? '✅ közzétehető' : '— nincs megadva / nincs hozzájárulás'}\n` +
    `- **Méret:** ${p.twa.length} szög × ${p.tws.length} szélsebesség (TWS ${p.tws[0]}–${p.tws[p.tws.length - 1]} kt)\n`;
  if (sub.notes) body += `\n### Megjegyzés\n\n${quote(sub.notes)}\n`;
  body += '\n### Automatikus ellenőrzés\n\n';
  body += p.warnings.length
    ? p.warnings.map((w) => `- ⚠️ ${mdSafe(w)}`).join('\n') + '\n'
    : '- ✅ Nem találtam gyanús értéket.\n';
  // A CSV normalizált (csak számok és vesszők), így a kódblokkot nem törheti meg.
  body += '\n### Polár (CSV, normalizálva)\n\n```csv\n' + p.normalized + '\n```';
  body += envLine + footer;
  return { title: `[${t.prefix}] ${sub.boatType}${name}`.slice(0, 200), body, labels };
}

// --- Védelmek ----------------------------------------------------------------

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(env, token, ip) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) {
    throw new HttpError(400, 'turnstile_missing', 'Erősítsd meg, hogy nem vagy robot.');
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  form.append('idempotency_key', crypto.randomUUID());
  let res;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    res = await r.json();
  } catch {
    throw new HttpError(502, 'turnstile_unavailable', 'Az ellenőrzés most nem érhető el, próbáld újra később.');
  }
  const hosts = String(env.TURNSTILE_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean);
  if (!res || res.success !== true) throw new HttpError(403, 'turnstile_failed', 'A robotellenőrzés nem sikerült, frissítsd és próbáld újra.');
  if (hosts.length && !hosts.includes(res.hostname)) throw new HttpError(403, 'turnstile_hostname', 'A robotellenőrzés nem sikerült.');
  if (res.action && res.action !== 'submit') throw new HttpError(403, 'turnstile_action', 'A robotellenőrzés nem sikerült.');
}

async function checkRateLimit(env, ipHash) {
  if (!env.SUBMIT_LIMITER || typeof env.SUBMIT_LIMITER.limit !== 'function') {
    // Fail closed: rate limit nélkül nem fogadunk be semmit.
    throw new HttpError(503, 'misconfigured', 'A beküldés átmenetileg nem elérhető.');
  }
  const { success } = await env.SUBMIT_LIMITER.limit({ key: ipHash });
  if (!success) throw new HttpError(429, 'rate_limited', 'Túl sok beküldés rövid idő alatt. Várj egy percet.');
}

async function checkDailyCaps(env, ipHash) {
  const kv = env.FEEDBACK_KV;
  if (!kv) return null;
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `d:${day}:${ipHash.slice(0, 32)}`;
  const allKey = `d:${day}:all`;
  const [ipN, allN] = await Promise.all([kv.get(ipKey), kv.get(allKey)]).then((v) => v.map((x) => Number(x) || 0));
  if (ipN >= LIMITS.perIpPerDay) throw new HttpError(429, 'daily_limit', 'Mára elérted a beküldési keretet. Holnap újra próbálhatod, vagy írj: info@nbsailing.hu');
  if (allN >= LIMITS.globalPerDay) throw new HttpError(429, 'global_limit', 'Ma már nagyon sok beküldés érkezett. Próbáld holnap, vagy írj: info@nbsailing.hu');
  return async () => {
    const opts = { expirationTtl: 2 * 24 * 3600 };
    await Promise.all([kv.put(ipKey, String(ipN + 1), opts), kv.put(allKey, String(allN + 1), opts)]);
  };
}

async function createIssue(env, issue) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'balatonrouting-feedback-worker',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(issue)
  });
  if (!r.ok) {
    // A GitHub válaszát (és a tokent) nem adjuk vissza a kliensnek.
    console.error('GitHub issue create failed', r.status);
    throw new HttpError(502, 'github_failed', 'A jegy létrehozása nem sikerült. Próbáld újra később, vagy írj: info@nbsailing.hu');
  }
  const j = await r.json();
  return { number: j.number, url: j.html_url };
}

// --- Belépési pont -----------------------------------------------------------

async function handleSubmit(request, env) {
  if (!env.GITHUB_TOKEN || !env.TURNSTILE_SECRET || !env.GITHUB_REPO || !env.ALLOWED_ORIGIN) {
    throw new HttpError(503, 'misconfigured', 'A beküldés átmenetileg nem elérhető.');
  }
  const ctype = request.headers.get('Content-Type') || '';
  if (!ctype.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'bad_content_type', 'Hibás kérés.');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > LIMITS.bodyBytes) throw new HttpError(413, 'too_large', 'Túl nagy beküldés.');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > LIMITS.bodyBytes) throw new HttpError(413, 'too_large', 'Túl nagy beküldés.');
  let data;
  try { data = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json', 'Hibás kérés.'); }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  // Napi sócsere: a titkos só mellé a mai (UTC) dátum is bekerül, így a kivonat naponta
  // más lesz, a korábbi napok kivonatai nem köthetők össze a maiakkal.
  const ipHash = await sha256Hex(`${env.IP_SALT || 'balatonrouting'}|${new Date().toISOString().slice(0, 10)}|${ip}`);
  await checkRateLimit(env, ipHash);
  const sub = validateSubmission(data);
  await verifyTurnstile(env, data.turnstileToken, ip);
  const commit = await checkDailyCaps(env, ipHash);
  const issue = buildIssue(sub);
  const created = await createIssue(env, issue);
  if (commit) await commit();
  return json(env, 201, { ok: true, number: created.number, url: created.url });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    try {
      if (url.pathname !== '/submit') throw new HttpError(404, 'not_found', 'Nem található.');
      if (origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'bad_origin', 'Nem engedélyezett forrás.');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Csak POST.');
      return await handleSubmit(request, env);
    } catch (e) {
      if (e instanceof HttpError) {
        const body = { ok: false, error: e.code, message: e.message };
        if (e.details) body.details = e.details;
        return json(env, e.status, body);
      }
      console.error('Unhandled error', e && e.name);
      return json(env, 500, { ok: false, error: 'internal', message: 'Váratlan hiba. Írj: info@nbsailing.hu' });
    }
  }
};
