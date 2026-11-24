// Balaton Routing – Visszajelzés űrlap (Hiba / Javaslat / Polár beküldése).
// Önálló modul: a modális ablakot maga építi fel, az index.html-ben csak a
// lábléc-link és a <script> tag van. A GitHub token NINCS itt: a beküldés a
// Cloudflare Workerhez megy, a jegyet az nyitja meg a saját titkos kulcsával.
import { parsePolarCsv, POLAR_LIMITS } from './polar-csv.js';

const scriptEl = document.currentScript || document.querySelector('script[data-feedback-worker]');
const CFG = {
  workerUrl: (scriptEl && scriptEl.dataset.feedbackWorker) || '',
  siteKey: (scriptEl && scriptEl.dataset.turnstileSitekey) || ''
};
const CONFIGURED = /^https:\/\//.test(CFG.workerUrl) && CFG.siteKey && !CFG.siteKey.startsWith('TODO');
const MAIL = 'info@nbsailing.hu';
const TEMPLATE_URL = 'polars/template.csv';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function envSummary() {
  const ua = navigator.userAgent;
  let browser = 'ismeretlen böngésző';
  const m = ua.match(/(Edg|OPR|Firefox|FxiOS|CriOS|Chrome|Version)\/(\d+)/);
  if (m) browser = ({ Edg: 'Edge', OPR: 'Opera', FxiOS: 'Firefox', CriOS: 'Chrome', Version: 'Safari' }[m[1]] || m[1]) + ' ' + m[2];
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'egyéb';
  return `${browser}, ${os}, ${window.innerWidth}×${window.innerHeight}`;
}

const html = `
<div class="fb-backdrop" id="fbBackdrop" hidden>
  <div class="fb-modal" role="dialog" aria-modal="true" aria-labelledby="fbTitle">
    <div class="fb-head">
      <h2 id="fbTitle">Visszajelzés</h2>
      <button type="button" class="fb-close" id="fbClose" aria-label="Bezárás">×</button>
    </div>
    <div class="fb-tabs" role="tablist">
      <button type="button" role="tab" class="fb-tab" data-tab="bug" aria-selected="true">🐞 Hiba</button>
      <button type="button" role="tab" class="fb-tab" data-tab="feedback" aria-selected="false">💡 Javaslat</button>
      <button type="button" role="tab" class="fb-tab" data-tab="polar" aria-selected="false">⛵ Polár beküldése</button>
    </div>
    <form id="fbForm" class="fb-body" novalidate>
      <p class="fb-public">A beküldött szöveg <b>nyilvános</b> GitHub-hibajegyként jelenik meg a
        <a href="https://github.com/nagyb187/balatonroute/issues" target="_blank" rel="noopener">balatonroute</a> oldalán.
        GitHub-fiók nem kell. Ne írj bele személyes adatot (e-mail-címet, telefonszámot). <a href="adatkezeles.html#visszajelzes" target="_blank" rel="noopener">Adatkezelés</a></p>

      <div class="fb-pane" data-pane="bug feedback">
        <label for="fbTitleIn">Rövid cím</label>
        <input id="fbTitleIn" name="title" maxlength="120" autocomplete="off" placeholder="pl. Nem jelenik meg az útvonal">
        <label for="fbDesc" data-text-bug="Mi történt? Mit vártál helyette?" data-text-feedback="Mit javasolsz, vagy mi a véleményed?">Mi történt? Mit vártál helyette?</label>
        <textarea id="fbDesc" name="description" maxlength="4000" rows="5"></textarea>
      </div>
      <div class="fb-pane" data-pane="bug">
        <label for="fbSteps">Hogyan lehet előidézni? <span class="fb-opt">(nem kötelező)</span></label>
        <textarea id="fbSteps" name="steps" maxlength="4000" rows="3" placeholder="pl. Elan 310, Szóló Rajt → Szóló Aliga, holnap 9:00, AROME"></textarea>
        <label class="chk fb-chk"><input type="checkbox" id="fbEnv" checked> <span>Böngésző-adatok csatolása: <span id="fbEnvText" class="fb-env"></span></span></label>
      </div>

      <div class="fb-pane" data-pane="polar">
        <div class="fb-row">
          <div><label for="fbBoatType">Hajótípus</label><input id="fbBoatType" maxlength="80" placeholder="pl. Elan 310" autocomplete="off"></div>
          <div><label for="fbBoatName">Hajónév <span class="fb-opt">(nem kötelező)</span></label><input id="fbBoatName" maxlength="80" placeholder="pl. Szélvész" autocomplete="off"></div>
        </div>
        <label class="chk fb-chk"><input type="checkbox" id="fbConsent"> <span>A hajó tulajdonosa vagyok, vagy engedélyem van rá, és hozzájárulok, hogy a <b>hajó neve</b> megjelenjen a nyilvános jegyben és a nyilvános polárlistában. <span class="fb-opt">(Ha nem jelölöd be, a nevet el sem küldjük, csak a típus látszik.)</span></span></label>
        <p id="fbNameHint" class="fb-hint" hidden>A hajónevet csak a fenti hozzájárulással küldjük el. Most csak a típus kerül a jegybe.</p>
        <label for="fbSource">A polár forrása</label>
        <select id="fbSource">
          <option value="orc">ORC-bizonyítvány</option>
          <option value="gyarto">Gyártói / tervezői polár</option>
          <option value="meres">Saját mérés (pl. műszerlog)</option>
          <option value="becsles">Becslés / tapasztalat</option>
          <option value="egyeb">Egyéb</option>
        </select>
        <label for="fbCsv">Polár CSV <span class="fb-opt">– sorok: szög (TWA, °), oszlopok: szélsebesség (TWS, csomó)</span></label>
        <textarea id="fbCsv" class="fb-mono" rows="7" spellcheck="false" placeholder="TWA\\TWS,6,8,10,12,14,16,20&#10;52,4.87,5.76,6.41,6.73,6.87,6.92,6.96&#10;60,5.16,6.07,6.62,6.90,7.05,7.12,7.15&#10;…"></textarea>
        <div class="fb-csv-tools">
          <label class="fb-file">📄 CSV feltöltése<input type="file" id="fbFile" accept=".csv,.txt,text/csv,text/plain"></label>
          <a href="${TEMPLATE_URL}" download="balatonrouting-polar-sablon.csv">⬇ Sablon letöltése</a>
        </div>
        <div id="fbPreview" class="fb-preview" aria-live="polite"></div>
        <label for="fbNotes">Megjegyzés <span class="fb-opt">(nem kötelező, pl. vitorlázat, terhelés)</span></label>
        <textarea id="fbNotes" maxlength="4000" rows="2" placeholder="Nyilvános! Ne írj bele vitorlaszámot, nevet, telefonszámot."></textarea>
        <label class="chk fb-chk"><input type="checkbox" id="fbRights"> <span>Jogom van megosztani ezt a polárt, és hozzájárulok, hogy a tervezőben bárki használhassa.</span></label>
      </div>

      <label class="chk fb-chk fb-ack"><input type="checkbox" id="fbPublicAck"> <span><b>Megértettem, hogy a beküldés nyilvános lesz</b> (nyilvános GitHub-jegy). <span class="fb-opt">Kötelező.</span></span></label>
      <input type="text" name="website" id="fbHp" class="fb-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div id="fbTurnstile" class="fb-ts"></div>
      <div id="fbMsg" class="fb-msg" role="status" aria-live="polite"></div>
      <button type="submit" class="btn-primary" id="fbSubmit">Beküldés</button>
      <p class="fb-alt">Vagy írj: <a href="mailto:${MAIL}">${MAIL}</a></p>
    </form>
    <div id="fbDone" class="fb-body fb-done" hidden></div>
  </div>
</div>`;

let state = { tab: 'bug', tsWidget: null, tsToken: '', tsLoading: null, busy: false, lastFocus: null };
const $ = (id) => document.getElementById(id);

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (state.tsLoading) return state.tsLoading;
  state.tsLoading = new Promise((resolve, reject) => {
    window.__brTsOnload = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__brTsOnload';
    s.async = true; s.defer = true;
    s.onerror = () => { state.tsLoading = null; reject(new Error('turnstile')); };
    document.head.appendChild(s);
  });
  return state.tsLoading;
}

async function ensureTurnstile() {
  if (!CONFIGURED || state.tsWidget !== null) return;
  try {
    await loadTurnstile();
    state.tsWidget = window.turnstile.render('#fbTurnstile', {
      sitekey: CFG.siteKey, action: 'submit', theme: 'dark', language: 'hu', size: 'flexible',
      callback: (t) => { state.tsToken = t; },
      'expired-callback': () => { state.tsToken = ''; },
      'error-callback': () => { state.tsToken = ''; }
    });
  } catch {
    showMsg('error', `A robotellenőrzés nem töltődött be. Próbáld újra később, vagy írj: <a href="mailto:${MAIL}">${MAIL}</a>`);
  }
}

function showMsg(kind, htmlText) {
  const m = $('fbMsg');
  m.className = 'fb-msg' + (kind ? ' fb-' + kind : '');
  m.innerHTML = htmlText || '';
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.fb-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.fb-pane').forEach((p) => { p.hidden = !p.dataset.pane.split(' ').includes(tab); });
  const lbl = document.querySelector('label[for="fbDesc"]');
  lbl.textContent = lbl.dataset[tab === 'bug' ? 'textBug' : 'textFeedback'] || lbl.textContent;
  $('fbTitleIn').placeholder = tab === 'bug' ? 'pl. Nem jelenik meg az útvonal' : 'pl. Legyen többpontos pálya';
  showMsg('', '');
}

function renderPreview() {
  const text = $('fbCsv').value;
  const box = $('fbPreview');
  if (!text.trim()) { box.innerHTML = ''; return null; }
  const p = parsePolarCsv(text);
  let out = '';
  if (p.errors.length) {
    out += `<div class="fb-err"><b>Javítandó (${p.errors.length}):</b><ul>${p.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
  } else {
    out += `<div class="fb-ok">✓ Rendben: ${p.twa.length} szög × ${p.tws.length} szélsebesség (${p.tws[0]}–${p.tws[p.tws.length - 1]} kt).</div>`;
    if (p.warnings.length) out += `<div class="fb-warn"><b>Gyanús értékek</b> (beküldhető, de nézd át):<ul>${p.warnings.slice(0, 6).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    const head = `<tr><th>TWA\\TWS</th>${p.tws.map((t) => `<th>${t}</th>`).join('')}</tr>`;
    const rows = p.twa.map((a, r) => `<tr><th>${a}°</th>${p.speeds[r].map((v) => `<td>${v === null ? '–' : v.toFixed(2)}</td>`).join('')}</tr>`).join('');
    out += `<div class="fb-table-wrap"><table class="fb-table">${head}${rows}</table></div>`;
  }
  box.innerHTML = out;
  return p;
}

function collect() {
  const base = { type: state.tab, website: $('fbHp').value, turnstileToken: state.tsToken, publicAck: $('fbPublicAck').checked };
  if (state.tab === 'polar') {
    const consent = $('fbConsent').checked;
    // A hajónév csak hozzájárulással hagyja el a böngészőt.
    const d = { ...base, boatType: $('fbBoatType').value, source: $('fbSource').value,
      csv: $('fbCsv').value, notes: $('fbNotes').value, consent, rightsConfirmed: $('fbRights').checked };
    if (consent && $('fbBoatName').value.trim()) d.boatName = $('fbBoatName').value;
    return d;
  }
  const d = { ...base, title: $('fbTitleIn').value, description: $('fbDesc').value };
  if (state.tab === 'bug') { d.steps = $('fbSteps').value; if ($('fbEnv').checked) d.env = envSummary(); }
  return d;
}

function clientCheck(d) {
  if (d.type === 'polar') {
    if (d.boatType.trim().length < 2) return 'Add meg a hajótípust.';
    const p = renderPreview();
    if (!p) return 'Illeszd be vagy töltsd fel a polár CSV-t.';
    if (!p.ok) return 'A polár CSV hibás, lásd fent a javítandókat.';
    if (!d.rightsConfirmed) return 'Erősítsd meg, hogy megoszthatod a polárt.';
  } else {
    if (d.title.trim().length < 3) return 'Adj meg egy rövid címet.';
    if (d.description.trim().length < 10) return 'Írd le néhány mondatban (legalább 10 karakter).';
  }
  if (!d.publicAck) return 'Jelöld be, hogy megértetted: a beküldés nyilvános lesz.';
  if (!CONFIGURED) return `Az online beküldés még nincs bekapcsolva. Addig írj: <a href="mailto:${MAIL}">${MAIL}</a>`;
  if (!d.turnstileToken) return 'Várd meg, amíg a robotellenőrzés (fent) zöld pipát mutat.';
  return '';
}

async function submit(ev) {
  ev.preventDefault();
  if (state.busy) return;
  const d = collect();
  const problem = clientCheck(d);
  if (problem) { showMsg('error', problem); return; }
  state.busy = true;
  const btn = $('fbSubmit');
  btn.disabled = true; btn.textContent = 'Küldés…';
  showMsg('', '');
  try {
    const r = await fetch(CFG.workerUrl.replace(/\/$/, '') + '/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d), credentials: 'omit'
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      const det = Array.isArray(j.details) && j.details.length ? `<ul>${j.details.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
      showMsg('error', esc(j.message || 'A beküldés nem sikerült.') + det + ` <br>Vagy írj: <a href="mailto:${MAIL}">${MAIL}</a>`);
      if (window.turnstile && state.tsWidget !== null) { window.turnstile.reset(state.tsWidget); state.tsToken = ''; }
      return;
    }
    const url = /^https:\/\/github\.com\//.test(j.url) ? j.url : 'https://github.com/nagyb187/balatonroute/issues';
    $('fbForm').hidden = true;
    const done = $('fbDone');
    done.hidden = false;
    done.innerHTML = `<div class="fb-success"><div class="fb-big">✓</div><h3>Köszönjük, megkaptuk!</h3>
      <p>Létrejött a <b>#${Number(j.number) || ''}</b> számú jegy. Ott követheted, mi lesz vele${d.type === 'polar' ? ' – a polár ellenőrzés után kerül a listába' : ''}.</p>
      <p><a class="fb-issue-link" href="${esc(url)}" target="_blank" rel="noopener">Jegy megnyitása a GitHubon ↗</a></p>
      <button type="button" class="btn-secondary" id="fbAgain">Újabb beküldés</button></div>`;
    $('fbAgain').onclick = resetForm;
  } catch {
    showMsg('error', `Nincs kapcsolat a szerverrel. Próbáld újra, vagy írj: <a href="mailto:${MAIL}">${MAIL}</a>`);
  } finally {
    state.busy = false; btn.disabled = false; btn.textContent = 'Beküldés';
  }
}

function resetForm() {
  $('fbForm').reset();
  $('fbPreview').innerHTML = '';
  $('fbNameHint').hidden = true;
  $('fbDone').hidden = true;
  $('fbForm').hidden = false;
  showMsg('', '');
  if (window.turnstile && state.tsWidget !== null) { window.turnstile.reset(state.tsWidget); state.tsToken = ''; }
}

export function openFeedback(tab) {
  state.lastFocus = document.activeElement;
  $('fbBackdrop').hidden = false;
  document.body.classList.add('fb-open');
  if (tab) setTab(tab);
  $('fbEnvText').textContent = envSummary();
  ensureTurnstile();
  setTimeout(() => document.querySelector('.fb-tab[aria-selected="true"]').focus(), 0);
}

function closeFeedback() {
  $('fbBackdrop').hidden = true;
  document.body.classList.remove('fb-open');
  if (location.hash === '#visszajelzes') history.replaceState(null, '', location.pathname + location.search);
  if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
}

function init() {
  document.body.insertAdjacentHTML('beforeend', html);
  setTab('bug');
  document.querySelectorAll('.fb-tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('fbClose').addEventListener('click', closeFeedback);
  $('fbBackdrop').addEventListener('click', (e) => { if (e.target.id === 'fbBackdrop') closeFeedback(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('fbBackdrop').hidden) closeFeedback(); });
  $('fbForm').addEventListener('submit', submit);
  const nameHint = () => { $('fbNameHint').hidden = !($('fbBoatName').value.trim() && !$('fbConsent').checked); };
  $('fbBoatName').addEventListener('input', nameHint);
  $('fbConsent').addEventListener('change', nameHint);
  let t;
  $('fbCsv').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderPreview, 250); });
  $('fbFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > POLAR_LIMITS.maxBytes) { showMsg('error', 'Túl nagy a fájl (legfeljebb 20 kB).'); e.target.value = ''; return; }
    $('fbCsv').value = await f.text();
    renderPreview();
  });
  document.querySelectorAll('[data-open-feedback]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); openFeedback(a.dataset.openFeedback || undefined);
  }));
  const fromHash = () => { if (location.hash === '#visszajelzes') openFeedback(); };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  window.brOpenFeedback = openFeedback;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
