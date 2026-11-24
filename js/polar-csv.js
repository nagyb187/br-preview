// Balaton Routing – polár CSV feldolgozó és ellenőrző.
// Közös modul: a böngészőben (js/feedback.js) és a Cloudflare Workerben
// (worker/src/index.js) is ugyanez fut, így az előnézet és a szerver
// ugyanazt a szabályt alkalmazza. Külső függőség nincs.
//
// Formátum: első sor fejléc: "TWA\TWS" (bármilyen szöveg) után a valós
// szélsebességek (TWS, csomó). Minden további sor: valós széliránytól
// mért szög (TWA, fok), majd a hajósebességek (csomó) az egyes TWS-ekhez.
// Elválasztó: vessző, pontosvessző vagy tabulátor. Pontosvesszőnél és
// tabulátornál tizedesvessző is használható. Üres cella = nincs adat.
// A "#"-tal kezdődő sorok megjegyzések.

export const POLAR_LIMITS = Object.freeze({
  maxBytes: 20000,
  maxRows: 60,
  maxCols: 40,
  minRows: 2,
  minCols: 2,
  twaMin: 0,
  twaMax: 180,
  twsMin: 0,
  twsMax: 40,
  speedMin: 0,
  speedMax: 25
});

function detectSeparator(line) {
  if (line.includes('\t')) return '\t';
  if (line.includes(';')) return ';';
  return ',';
}

function parseNum(raw, sep) {
  let s = String(raw).trim();
  if (s === '') return { empty: true };
  if (sep !== ',') s = s.replace(',', '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { bad: true };
  return { value: Number(s) };
}

const fmt = (n) => String(Math.round(n * 100) / 100);

/**
 * Feldolgozza és ellenőrzi a polár CSV-t.
 * @returns {{ok:boolean, errors:string[], warnings:string[], tws:number[], twa:number[],
 *            speeds:(number|null)[][], separator:string, normalized:string}}
 * Az errors listában lévő hibák blokkolják a beküldést, a warnings csak jelzés.
 */
export function parsePolarCsv(text) {
  const L = POLAR_LIMITS;
  const errors = [];
  const warnings = [];
  const out = { ok: false, errors, warnings, tws: [], twa: [], speeds: [], separator: ',', normalized: '' };

  if (typeof text !== 'string' || text.trim() === '') {
    errors.push('Üres a polár: illeszd be vagy töltsd fel a CSV-t.');
    return out;
  }
  if (new TextEncoder().encode(text).length > L.maxBytes) {
    errors.push(`Túl nagy a fájl (legfeljebb ${Math.round(L.maxBytes / 1000)} kB lehet).`);
    return out;
  }
  // BOM és sorvégek kezelése
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  if (lines.length < L.minRows + 1) {
    errors.push(`Legalább egy fejlécsor és ${L.minRows} szögsor kell.`);
    return out;
  }
  if (lines.length > L.maxRows + 1) {
    errors.push(`Túl sok sor (legfeljebb ${L.maxRows} szögsor).`);
    return out;
  }

  const sep = detectSeparator(lines[0]);
  out.separator = sep;
  const header = lines[0].split(sep).map((c) => c.trim());
  const twsCells = header.slice(1);
  if (twsCells.length < L.minCols) errors.push(`Legalább ${L.minCols} szélsebesség-oszlop kell a fejlécben.`);
  if (twsCells.length > L.maxCols) {
    errors.push(`Túl sok oszlop (legfeljebb ${L.maxCols} szélsebesség).`);
    return out;
  }

  const tws = [];
  twsCells.forEach((c, i) => {
    const p = parseNum(c, sep);
    if (p.empty || p.bad) {
      errors.push(`Fejléc ${i + 2}. oszlop: „${c.slice(0, 20)}” nem szám (szélsebesség csomóban).`);
      tws.push(NaN);
    } else if (p.value <= L.twsMin || p.value > L.twsMax) {
      errors.push(`Fejléc: ${fmt(p.value)} kt szélsebesség kívül esik a 0–${L.twsMax} kt tartományon.`);
      tws.push(p.value);
    } else tws.push(p.value);
  });
  for (let i = 1; i < tws.length; i++) {
    if (!(tws[i] > tws[i - 1])) {
      errors.push('A fejlécben a szélsebességeknek szigorúan növekvő sorrendben kell lenniük.');
      break;
    }
  }

  const twa = [];
  const speeds = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(sep).map((c) => c.trim());
    const rowNo = r + 1;
    const a = parseNum(cells[0], sep);
    let angle = NaN;
    if (a.empty || a.bad) errors.push(`${rowNo}. sor: a szög („${String(cells[0]).slice(0, 20)}”) nem szám.`);
    else if (a.value < L.twaMin || a.value > L.twaMax) errors.push(`${rowNo}. sor: ${fmt(a.value)}° kívül esik a 0–180° tartományon.`);
    else angle = a.value;
    twa.push(angle);
    if (cells.length - 1 > tws.length) errors.push(`${rowNo}. sor: több érték van, mint ahány szélsebesség a fejlécben.`);
    const row = [];
    for (let c = 0; c < tws.length; c++) {
      const p = parseNum(cells[c + 1] ?? '', sep);
      if (p.empty) row.push(null);
      else if (p.bad) { errors.push(`${rowNo}. sor, ${c + 2}. oszlop: „${String(cells[c + 1]).slice(0, 20)}” nem szám.`); row.push(null); }
      else if (p.value < L.speedMin || p.value > L.speedMax) { errors.push(`${rowNo}. sor, ${c + 2}. oszlop: ${fmt(p.value)} kt hajósebesség kívül esik a 0–${L.speedMax} kt tartományon.`); row.push(null); }
      else row.push(p.value);
    }
    speeds.push(row);
    if (errors.length > 30) { errors.push('Túl sok hiba, a további sorokat nem ellenőriztem.'); break; }
  }
  for (let i = 1; i < twa.length; i++) {
    if (Number.isFinite(twa[i]) && Number.isFinite(twa[i - 1]) && !(twa[i] > twa[i - 1])) {
      errors.push('A szögeknek (első oszlop) szigorúan növekvő sorrendben kell lenniük, ismétlés nélkül.');
      break;
    }
  }
  const filled = speeds.reduce((n, row) => n + row.filter((v) => v !== null && v > 0).length, 0);
  if (!errors.length && filled < 4) errors.push('Túl kevés kitöltött sebességérték (legalább 4 kell).');

  // Gyanús értékek (nem blokkolnak, csak jelzik)
  if (!errors.length) {
    const flag = (m) => { if (warnings.length < 15) warnings.push(m); };
    for (let r = 0; r < twa.length; r++) {
      if (twa[r] < 25 && speeds[r].some((v) => v !== null && v > 0)) flag(`${fmt(twa[r])}°-os sor: 25° alatt egy vitorlás jellemzően nem halad, ezt a sort érdemes üresen hagyni.`);
      for (let c = 0; c < tws.length; c++) {
        const v = speeds[r][c];
        if (v === null) continue;
        if (tws[c] >= 4 && v > tws[c] * 1.5) flag(`${fmt(twa[r])}° / ${fmt(tws[c])} kt: ${fmt(v)} kt gyanúsan gyors (több mint a szél másfélszerese).`);
        // Kiugró érték a szomszédos szögekhez képest
        const up = r > 0 ? speeds[r - 1][c] : null;
        const dn = r < twa.length - 1 ? speeds[r + 1][c] : null;
        if (up !== null && dn !== null && up > 0 && dn > 0 && twa[r - 1] >= 25) {
          const avg = (up + dn) / 2;
          if (Math.abs(v - avg) > Math.max(0.35 * avg, 1)) flag(`${fmt(twa[r])}° / ${fmt(tws[c])} kt: ${fmt(v)} kt kiugrik a szomszédos szögekhez (${fmt(up)}, ${fmt(dn)}) képest.`);
        }
        // Erősödő szélben jelentős lassulás
        const prev = c > 0 ? speeds[r][c - 1] : null;
        if (prev !== null && prev > 0 && v < prev * 0.8) flag(`${fmt(twa[r])}°: ${fmt(tws[c - 1])} → ${fmt(tws[c])} kt szélben a sebesség ${fmt(prev)}-ról ${fmt(v)} kt-ra esik.`);
      }
    }
  }

  out.tws = tws;
  out.twa = twa;
  out.speeds = speeds;
  out.ok = errors.length === 0;
  if (out.ok) {
    const rows = [['TWA\\TWS', ...tws.map(fmt)].join(',')];
    for (let r = 0; r < twa.length; r++) rows.push([fmt(twa[r]), ...speeds[r].map((v) => (v === null ? '' : fmt(v)))].join(','));
    out.normalized = rows.join('\n');
  }
  return out;
}
