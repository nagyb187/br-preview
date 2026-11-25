// Worker egységtesztek: a GitHub API és a Turnstile siteverify mockolva (globalThis.fetch).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { cleanText, mdSafe, buildIssue, validateSubmission } from '../src/index.js';
import { parsePolarCsv } from '../../js/polar-csv.js';

const TEMPLATE = readFileSync(new URL('../../polars/template.csv', import.meta.url), 'utf8');
const ORIGIN = 'https://balatonrouting.hu';
const FAKE_TOKEN = 'github_pat_FAKE_TEST_TOKEN_1234567890';

let calls, turnstileReply, githubReply, limiterOk, kvStore;

function makeEnv(over = {}) {
  return {
    ALLOWED_ORIGIN: ORIGIN,
    GITHUB_REPO: 'nagyb187/balatonroute',
    TURNSTILE_HOSTNAMES: 'balatonrouting.hu',
    GITHUB_TOKEN: FAKE_TOKEN,
    TURNSTILE_SECRET: 'ts-secret',
    IP_SALT: 'salt',
    SUBMIT_LIMITER: { limit: async ({ key }) => { calls.limiter.push(key); return { success: limiterOk }; } },
    ...over
  };
}

beforeEach(() => {
  calls = { turnstile: [], github: [], limiter: [] };
  turnstileReply = { success: true, hostname: 'balatonrouting.hu', action: 'submit' };
  githubReply = { status: 201, body: { number: 42, html_url: 'https://github.com/nagyb187/balatonroute/issues/42' } };
  limiterOk = true;
  kvStore = new Map();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
      calls.turnstile.push(Object.fromEntries(init.body.entries()));
      return new Response(JSON.stringify(turnstileReply), { status: 200 });
    }
    if (u === 'https://api.github.com/repos/nagyb187/balatonroute/issues') {
      calls.github.push({ headers: init.headers, body: JSON.parse(init.body), method: init.method });
      return new Response(JSON.stringify(githubReply.body), { status: githubReply.status });
    }
    throw new Error('Unexpected fetch ' + u);
  };
});

function req(body, { origin = ORIGIN, method = 'POST', path = '/submit', ctype = 'application/json', ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (ctype) headers['Content-Type'] = ctype;
  return new Request('https://balatonrouting-feedback.example.workers.dev' + path, {
    method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
}

const bug = (over = {}) => ({ type: 'bug', title: 'Nem tölt be a térkép', description: 'Megnyitom az oldalt és üres marad a térkép.', steps: '1. Megnyitás iPhone-on', env: 'Safari 18, iOS, 390×844', turnstileToken: 'XXXX.test-token', publicAck: true, ...over });
const polar = (over = {}) => ({ type: 'polar', boatType: 'Elan 310', boatName: 'Szélvész', source: 'orc', consent: true, rightsConfirmed: true, csv: TEMPLATE, notes: 'Teljes vitorlázat', turnstileToken: 'XXXX.test-token', publicAck: true, ...over });

async function send(body, opts, env = makeEnv()) {
  const r = await worker.fetch(req(body, opts), env);
  return { status: r.status, headers: r.headers, json: r.status === 204 ? null : await r.json() };
}

// --- Sikeres utak ---
test('bug report creates issue with "hiba" label and returns number/url', async () => {
  const r = await send(bug());
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { ok: true, number: 42, url: 'https://github.com/nagyb187/balatonroute/issues/42' });
  assert.equal(calls.github.length, 1);
  const g = calls.github[0];
  assert.equal(g.method, 'POST');
  assert.equal(g.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.deepEqual(g.body.labels, ['hiba']);
  assert.equal(g.body.title, '[Hiba] Nem tölt be a térkép');
  assert.match(g.body.body, /Hogyan lehet előidézni/);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('feedback creates issue with "javaslat" label', async () => {
  const r = await send({ type: 'feedback', title: 'Sötét mód', description: 'Jó lenne egy világos téma is.', turnstileToken: 'XXXX.test-token', publicAck: true });
  assert.equal(r.status, 201);
  assert.deepEqual(calls.github[0].body.labels, ['javaslat']);
});

test('polar with consent gets "polár-kérés" + "publikálható-név" and CSV code block', async () => {
  const r = await send(polar());
  assert.equal(r.status, 201);
  const b = calls.github[0].body;
  assert.deepEqual(b.labels, ['polár-kérés', 'publikálható-név']);
  assert.equal(b.title, '[Polár-kérés] Elan 310 – Szélvész');
  assert.match(b.body, /```csv\nTWA\\TWS,6,8,10,12,14,16,20\n52,4\.87/);
  assert.match(b.body, /\*\*Név:\*\* Szélvész/);
  assert.match(b.body, /polárlistában:\*\* ✅ közzétehető/);
});

test('polar without consent: boat name is NOT in the public issue (title, body) and no label', async () => {
  await send(polar({ consent: false, boatName: 'Titkos Hajó' }));
  const b = calls.github[0].body;
  assert.deepEqual(b.labels, ['polár-kérés']);
  assert.equal(b.title, '[Polár-kérés] Elan 310');
  assert.ok(!JSON.stringify(b).includes('Titkos'), 'name must not appear anywhere in the issue payload');
  assert.match(b.body, /nincs hozzájárulás/);
});

test('consent must be literal true (string "true" is not consent) – name dropped', async () => {
  await send(polar({ consent: 'true', boatName: 'Titkos Hajó' }));
  const b = calls.github[0].body;
  assert.deepEqual(b.labels, ['polár-kérés']);
  assert.ok(!JSON.stringify(b).includes('Titkos'));
});

test('consent without a boat name: no label, no name line', async () => {
  await send(polar({ consent: true, boatName: '   ' }));
  const b = calls.github[0].body;
  assert.deepEqual(b.labels, ['polár-kérés']);
  assert.equal(b.title, '[Polár-kérés] Elan 310');
  assert.ok(!b.body.includes('**Név:**'));
});

test('validateSubmission drops the boat name without consent', () => {
  assert.equal(validateSubmission(polar({ consent: false, boatName: 'Szélvész' })).boatName, '');
  assert.equal(validateSubmission(polar({ consent: true, boatName: 'Szélvész' })).boatName, 'Szélvész');
});

// --- CORS / metódus / útvonal ---
test('preflight from allowed origin returns 204 with CORS headers', async () => {
  const r = await send(null, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(r.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
});

test('other origins are rejected and never reach Turnstile/GitHub', async () => {
  for (const o of ['https://evil.example', 'http://balatonrouting.hu', 'https://balatonrouting.hu.evil.example', null]) {
    const r = await send(bug(), { origin: o });
    assert.equal(r.status, 403, String(o));
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  }
  assert.equal(calls.turnstile.length + calls.github.length, 0);
});

test('GET and unknown paths are rejected', async () => {
  assert.equal((await send(null, { method: 'GET' })).status, 405);
  assert.equal((await send(bug(), { path: '/' })).status, 404);
});

test('non-JSON content type and broken JSON are rejected', async () => {
  assert.equal((await send(bug(), { ctype: 'text/plain' })).status, 415);
  assert.equal((await send('{nope', {})).status, 400);
});

test('oversized body is rejected with 413', async () => {
  const r = await send(bug({ description: 'x'.repeat(40000) }));
  assert.equal(r.status, 413);
  assert.equal(calls.github.length, 0);
});

// --- Turnstile ---
test('missing Turnstile token -> 400, failed -> 403, wrong hostname -> 403', async () => {
  assert.equal((await send(bug({ turnstileToken: undefined }))).status, 400);
  turnstileReply = { success: false, 'error-codes': ['invalid-input-response'] };
  assert.equal((await send(bug())).status, 403);
  turnstileReply = { success: true, hostname: 'evil.example' };
  assert.equal((await send(bug())).status, 403);
  assert.equal(calls.github.length, 0);
});

test('Turnstile receives secret, token and client IP', async () => {
  await send(bug());
  assert.equal(calls.turnstile[0].secret, 'ts-secret');
  assert.equal(calls.turnstile[0].response, 'XXXX.test-token');
  assert.equal(calls.turnstile[0].remoteip, '203.0.113.7');
});

// --- Rate limit ---
test('rate limiter rejection returns 429 before Turnstile/GitHub', async () => {
  limiterOk = false;
  const r = await send(bug());
  assert.equal(r.status, 429);
  assert.equal(calls.turnstile.length + calls.github.length, 0);
});

test('rate limiter key is a salted, daily-rotated hash, never the raw IP', async () => {
  await send(bug());
  assert.match(calls.limiter[0], /^[0-9a-f]{64}$/);
  assert.ok(!calls.limiter[0].includes('203.0.113.7'));
  const day = new Date().toISOString().slice(0, 10);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(`salt|${day}|203.0.113.7`).digest('hex');
  assert.equal(calls.limiter[0], expected, 'hash includes the UTC date (daily salt rotation)');
  const withoutDay = createHash('sha256').update('salt|203.0.113.7').digest('hex');
  assert.notEqual(calls.limiter[0], withoutDay);
});

test('missing rate limiter binding fails closed (503)', async () => {
  const r = await send(bug(), {}, makeEnv({ SUBMIT_LIMITER: undefined }));
  assert.equal(r.status, 503);
  assert.equal(calls.github.length, 0);
});

test('missing secrets fail closed (503)', async () => {
  assert.equal((await send(bug(), {}, makeEnv({ GITHUB_TOKEN: undefined }))).status, 503);
  assert.equal((await send(bug(), {}, makeEnv({ TURNSTILE_SECRET: '' }))).status, 503);
});

test('KV daily cap per IP', async () => {
  const kv = { get: async (k) => kvStore.get(k) ?? null, put: async (k, v) => { kvStore.set(k, v); } };
  const env = makeEnv({ FEEDBACK_KV: kv });
  for (let i = 0; i < 10; i++) assert.equal((await send(bug(), {}, env)).status, 201);
  const r = await send(bug(), {}, env);
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'daily_limit');
  assert.equal((await send(bug(), { ip: '198.51.100.1' }, env)).status, 201);
  assert.ok([...kvStore.keys()].every((k) => !k.includes('203.0.113.7')));
});

// --- Validálás ---
test('honeypot field rejects', async () => {
  assert.equal((await send(bug({ website: 'http://spam' }))).status, 400);
  assert.equal(calls.github.length, 0);
});

test('unknown type, short title/description, long title rejected', async () => {
  assert.equal((await send(bug({ type: 'admin' }))).json.error, 'bad_type');
  assert.equal((await send(bug({ title: 'x' }))).json.error, 'missing_title');
  assert.equal((await send(bug({ description: 'rövid' }))).json.error, 'missing_description');
  assert.equal((await send(bug({ title: 'x'.repeat(121) }))).json.error, 'too_long');
  assert.equal((await send(bug({ title: { a: 1 } }))).json.error, 'bad_field');
});

test('invalid polar CSV rejected with details', async () => {
  const r = await send(polar({ csv: 'TWA\\TWS,6,8\n40,5,6\n190,5,99\n' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad_csv');
  assert.ok(r.json.details.some((d) => d.includes('180')));
  assert.ok(r.json.details.some((d) => d.includes('25 kt')));
});

test('polar requires rights confirmation and boat type', async () => {
  assert.equal((await send(polar({ rightsConfirmed: false }))).json.error, 'missing_rights');
  assert.equal((await send(polar({ boatType: '' }))).json.error, 'missing_boat_type');
});

test('GitHub failure returns 502 without leaking token or GitHub body', async () => {
  githubReply = { status: 401, body: { message: 'Bad credentials ' + FAKE_TOKEN } };
  const r = await send(bug());
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(r.json).includes('Bad credentials'));
});

// --- Szövegtisztítás ---
test('sanitization: mentions, issue refs, HTML, control and bidi chars', async () => {
  await send(bug({ description: '@nagyb187 nézd meg #1 <img src=x onerror=alert(1)> \u202Eevil\u0007 ```\nvége' }));
  const body = calls.github[0].body.body;
  assert.ok(!/@nagyb187/.test(body), 'mention neutralized');
  assert.ok(body.includes('@\u200Bnagyb187'));
  assert.ok(body.includes('#\u200B1'));
  assert.ok(!body.includes('<img'));
  assert.ok(!body.includes('\u202E') && !body.includes('\u0007'));
  assert.ok(body.includes('> vége'), 'every line quoted so code fences cannot escape');
});

test('cleanText trims, strips controls and collapses single-line whitespace', () => {
  assert.equal(cleanText('  a\u0000b\n\tc  ', 50, { multiline: false }), 'ab c');
  assert.equal(mdSafe('<b>&'), '&lt;b&gt;&amp;');
});

// --- Polár CSV ---
test('template CSV parses cleanly', () => {
  const p = parsePolarCsv(TEMPLATE);
  assert.ok(p.ok, p.errors.join('; '));
  assert.deepEqual(p.tws, [6, 8, 10, 12, 14, 16, 20]);
  assert.equal(p.twa.length, 8);
  assert.equal(p.warnings.length, 0);
});

test('semicolon separator with decimal comma and empty cells', () => {
  const p = parsePolarCsv('TWA;6;10\n45;4,5;\n90;5,6;7,1\n120;5,4;6,9\n');
  assert.ok(p.ok, p.errors.join('; '));
  assert.deepEqual(p.speeds, [[4.5, null], [5.6, 7.1], [5.4, 6.9]]);
});

test('range and order errors', () => {
  const p = parsePolarCsv('TWA,6,45\n90,5,abc\n60,30,6\n');
  assert.ok(!p.ok);
  const all = p.errors.join('\n');
  assert.match(all, /45 kt szélsebesség kívül esik/);
  assert.match(all, /nem szám/);
  assert.match(all, /30 kt hajósebesség/);
  assert.match(all, /szigorúan növekvő/);
});

test('outlier warnings are flagged but do not block', () => {
  const p = parsePolarCsv('TWA,6,8,10\n20,1,1,1\n60,5,6,6.5\n90,9.5,6.4,7\n120,5,6,6.8\n');
  assert.ok(p.ok, p.errors.join('; '));
  const w = p.warnings.join('\n');
  assert.match(w, /25° alatt/);
  assert.match(w, /gyanúsan gyors/);
  assert.match(w, /kiugrik/);
  assert.match(w, /esik/);
});

test('size limits: too many rows / columns / bytes', () => {
  assert.ok(!parsePolarCsv('TWA,' + Array.from({ length: 41 }, (_, i) => i + 1).join(',') + '\n1,1\n2,2\n').ok);
  assert.ok(!parsePolarCsv('TWA,6,8\n' + Array.from({ length: 70 }, (_, i) => `${i + 1},5,6`).join('\n')).ok);
  assert.ok(!parsePolarCsv('x'.repeat(20001)).ok);
});

test('buildIssue output contains no raw CSV injection', () => {
  const sub = validateSubmission(polar());
  const issue = buildIssue(sub);
  assert.equal((issue.body.match(/```/g) || []).length, 2);
});

test('public-issue acknowledgement is required for every type (literal true only)', async () => {
  for (const mk of [bug, polar, (o) => ({ type: 'feedback', title: 'Sötét mód', description: 'Jó lenne egy világos téma is.', turnstileToken: 'XXXX.test-token', ...o })]) {
    for (const v of [undefined, false, 'true', 1]) {
      const r = await send(mk({ publicAck: v }));
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'missing_public_ack');
    }
  }
  assert.equal(calls.turnstile.length + calls.github.length, 0, 'rejected before Turnstile/GitHub');
});

test('issue footer records the public acknowledgement', async () => {
  await send(bug());
  assert.match(calls.github[0].body.body, /tudomásul vette, hogy a beküldés nyilvános/);
});
