/* Balaton Routing – versenypontok, helymeghatározás, térképes választás, saját pontok.
 * A többbójás (több szakaszos) útvonaltervezés szándékosan nincs ebben a körben. */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'balatonrouting.savedPoints.v1';
  var DEFAULT_RACE = 'byc-szolo';
  var SNAP_GEO_M = 300;
  var ACCURACY_SOFT_M = 150;
  var ACCURACY_HARD_M = 800;
  var DATA_URL = 'data/races.json';

  var state = {
    races: [],
    raceById: {},
    markById: {},
    currentRaceId: DEFAULT_RACE,
    saved: [],
    markLayer: null,
    pickPopup: null,
    suppressClick: false,
    ready: false,
    installed: false
  };

  var css = [
    '#pointsCard .race-block { margin-bottom: 10px; }',
    '#raceMeta { line-height: 1.45; overflow-wrap: anywhere; }',
    '#raceMeta a { color: #fbbf24; font-weight: 600; text-decoration: none; }',
    '#raceMeta a:hover { text-decoration: underline; }',
    '#savePointBlock { margin-top: 12px; padding-top: 12px; border-top: 1px solid #1e293b; scroll-margin-top: 80px; }',
    '#savePointHint { font-size: 0.85rem; color: #94a3b8; margin: 0 0 8px; line-height: 1.45; }',
    '#savePointRow { margin-top: 4px; align-items: flex-end; }',
    '#savePointBtn { width: 100%; min-height: 44px; font-weight: 700; }',
    '#savePointStatus { margin-top: 6px; }',
    '#savedPointsList { list-style: none; margin: 6px 0 0; padding: 0; }',
    '#savedPointsList li { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 6px 0; font-size: 0.88rem; }',
    '#savedPointsList li span { flex: 1; min-width: 0; }',
    '#savedPointsList .saved-actions { display: flex; gap: 6px; flex-wrap: wrap; }',
    '#savedPointsList button { width: auto; margin: 0; padding: 6px 10px; font-size: 0.78rem; background: #334155; color: #e2e8f0; }',
    '#savedPointsList button:hover { background: #475569; }',
    '#savedPointsList button.saved-del { background: #7f1d1d; }',
    '#savedPointsList button.saved-del:hover { background: #991b1b; }',
    '@media (max-width: 600px) { #savePointRow { align-items: stretch; } #savePointRow > div { width: 100%; } #savePointBtn { width: 100%; } #savedPointsList li { flex-direction: column; align-items: stretch; } }',
    '.map-pick-popup { font-size: 0.88rem; color: #0f172a; min-width: 200px; }',
    '.map-pick-popup p { margin: 0 0 8px; }',
    '.map-pick-popup .pick-actions { display: flex; gap: 6px; flex-wrap: wrap; }',
    '.map-pick-popup button { width: auto; flex: 1; margin: 0; padding: 8px 10px; font-size: 0.82rem; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }',
    '.map-pick-popup .pick-start { background: #3b82f6; color: #fff; }',
    '.map-pick-popup .pick-goal { background: #0f766e; color: #fff; }',
    '.map-pick-popup .pick-save { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }',
    '.map-pick-popup .pick-save label { font-size: 0.78rem; font-weight: 600; color: #0f172a; }',
    '.map-pick-popup .pick-save input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.88rem; }',
    '.map-pick-popup .pick-save-btn { background: #d97706; color: #fff; width: 100%; flex: none; }',
    '.mark-popup { font-size: 0.86rem; color: #0f172a; }',
    '.mark-popup .rounding { color: #334155; margin: 4px 0 8px; }',
    '.leaflet-div-icon.race-mark-icon { background: transparent; border: none; }',
    '.race-mark-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(15,23,42,0.45); }',
  ].join('\n');

  function $(id) { return document.getElementById(id); }

  function destPoint(lat, lon, bearingDeg, distM) {
    var R = 6371000;
    var br = bearingDeg * Math.PI / 180;
    var p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    var ang = distM / R;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(ang) + Math.cos(p1) * Math.sin(ang) * Math.cos(br));
    var l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(ang) * Math.cos(p1), Math.cos(ang) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * 180 / Math.PI, lon: ((l2 * 180 / Math.PI) + 540) % 360 - 180 };
  }

  function haversineM(aLat, aLon, bLat, bLon) {
    var R = 6371000;
    var p1 = aLat * Math.PI / 180, p2 = bLat * Math.PI / 180;
    var dph = (bLat - aLat) * Math.PI / 180, dl = (bLon - aLon) * Math.PI / 180;
    var h = Math.sin(dph / 2) * Math.sin(dph / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function inLakeBbox(lat, lon) {
    return isFinite(lat) && isFinite(lon) && lat >= 46.6 && lat <= 47.2 && lon >= 17.1 && lon <= 18.3;
  }

  function isOnWater(lat, lon) {
    return typeof global.onWater === 'function' && global.onWater(lat, lon);
  }

  function nearestNavigable(lat, lon, maxM) {
    maxM = maxM == null ? SNAP_GEO_M : maxM;
    if (!inLakeBbox(lat, lon)) return null;
    if (isOnWater(lat, lon)) return { lat: lat, lon: lon, snapped: false, distM: 0 };
    var step = 20;
    for (var r = step; r <= maxM; r += step) {
      var n = Math.max(8, Math.round((2 * Math.PI * r) / step));
      for (var i = 0; i < n; i++) {
        var p = destPoint(lat, lon, (360 * i) / n, r);
        if (isOnWater(p.lat, p.lon)) return { lat: p.lat, lon: p.lon, snapped: true, distM: r };
      }
    }
    return null;
  }

  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      state.saved = Array.isArray(arr) ? arr.filter(function (p) {
        return p && p.id && p.name && isFinite(p.lat) && isFinite(p.lon);
      }) : [];
    } catch (e) {
      state.saved = [];
    }
  }

  function persistSaved() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved));
  }

  function injectCss() {
    if ($('marks-css')) return;
    var el = document.createElement('style');
    el.id = 'marks-css';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function registerMark(m, raceId) {
    if (!m || !m.id || !isFinite(m.lat) || !isFinite(m.lon)) return;
    state.markById[m.id] = Object.assign({ raceId: raceId }, m);
    if (typeof global.presets === 'object') {
      global.presets[m.id] = { lat: m.lat, lon: m.lon, name: m.name, raceId: raceId };
    }
  }

  function registerAllPresets() {
    state.races.forEach(function (race) {
      (race.marks || []).forEach(function (m) { registerMark(m, race.id); });
      (race.convenience || []).forEach(function (m) { registerMark(m, race.id); });
    });
    state.saved.forEach(function (p) {
      if (typeof global.presets === 'object') {
        global.presets[p.id] = { lat: p.lat, lon: p.lon, name: p.name, saved: true };
      }
    });
  }

  function currentRace() {
    return state.raceById[state.currentRaceId] || state.raceById[DEFAULT_RACE];
  }

  function fillRaceSelect() {
    var sel = $('raceSelect');
    if (!sel) return;
    sel.innerHTML = '';
    state.races.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.label;
      sel.appendChild(opt);
    });
    sel.value = state.currentRaceId;
  }

  function renderRaceMeta() {
    var race = currentRace();
    var meta = $('raceMeta');
    if (!race || !meta) return;
    var parts = [];
    if (race.year) parts.push('Év: ' + race.year);
    if (race.sourceUrl) {
      var label = race.sourceLabel || 'Hivatalos forrás';
      parts.push('<a href="' + race.sourceUrl + '" target="_blank" rel="noopener">' + label + '</a>');
    }
    if (race.verifyNote) parts.push(race.verifyNote);
    meta.innerHTML = parts.join(' · ');
  }

  function optionEl(id, name) {
    var o = document.createElement('option');
    o.value = id;
    o.textContent = name;
    return o;
  }

  function rebuildPointSelects(keepStart, keepTarget) {
    var startSel = $('startSelect');
    var targetSel = $('targetSelect');
    if (!startSel || !targetSel) return;
    var startVal = keepStart != null ? keepStart : startSel.value;
    var targetVal = keepTarget != null ? keepTarget : targetSel.value;
    var race = currentRace();

    startSel.innerHTML = '';
    startSel.appendChild(optionEl('', 'Válassz kezdőpontot…'));
    if (race && race.includeFured && race.convenience) {
      race.convenience.forEach(function (m) {
        startSel.appendChild(optionEl(m.id, m.name));
      });
    }
    (race && race.marks || []).forEach(function (m) {
      startSel.appendChild(optionEl(m.id, m.name));
    });
    if (state.saved.length) {
      var ogS = document.createElement('optgroup');
      ogS.label = 'Saját pontok';
      state.saved.forEach(function (p) { ogS.appendChild(optionEl(p.id, p.name)); });
      startSel.appendChild(ogS);
    }
    if (startVal && [].some.call(startSel.options, function (o) { return o.value === startVal; })) {
      startSel.value = startVal;
    } else {
      startSel.value = '';
    }

    targetSel.innerHTML = '';
    (race && race.marks || []).forEach(function (m) {
      targetSel.appendChild(optionEl(m.id, m.name));
    });
    if (race && race.includeFured && race.convenience) {
      race.convenience.forEach(function (m) {
        targetSel.appendChild(optionEl(m.id, m.name));
      });
    }
    if (state.saved.length) {
      var ogT = document.createElement('optgroup');
      ogT.label = 'Saját pontok';
      state.saved.forEach(function (p) { ogT.appendChild(optionEl(p.id, p.name)); });
      targetSel.appendChild(ogT);
    }
    targetSel.appendChild(optionEl('manual', 'Manuális / térkép'));
    if (targetVal && [].some.call(targetSel.options, function (o) { return o.value === targetVal; })) {
      targetSel.value = targetVal;
    } else if (race && race.marks && race.marks.length) {
      targetSel.value = race.marks[0].id;
    } else {
      targetSel.value = 'manual';
    }
    if (typeof global.onTargetChange === 'function') global.onTargetChange();
  }

  function markColor(m) {
    if (m.role === 'start_and_finish' || m.role === 'start_line' || m.role === 'finish_line') return '#22c55e';
    if (m.role === 'gate') return '#a855f7';
    if (m.role === 'convenience') return '#94a3b8';
    return '#f59e0b';
  }

  function clearMarkLayer() {
    if (state.markers && global.map) {
      state.markers.forEach(function (mk) {
        try { global.map.removeLayer(mk); } catch (e) {}
      });
    }
    if (state.markLayer && global.map && state.markLayer.remove) {
      try { global.map.removeLayer(state.markLayer); } catch (e) {}
    }
    state.markers = [];
    state.markLayer = null;
  }

  function renderRaceMarks() {
    if (!global.map || typeof L === 'undefined') return;
    clearMarkLayer();
    var race = currentRace();
    if (!race) return;
    /* BYC Szóló: existing start/finish presets only, no course-mark overlay. */
    if (race.id === DEFAULT_RACE) return;
    var bounds = [];
    var markers = [];
    var toShow = (race.marks || []).concat(race.includeFured ? (race.convenience || []) : []);
    toShow.forEach(function (m) {
      if (!isFinite(m.lat) || !isFinite(m.lon)) return;
      var icon = L.divIcon({
        className: 'race-mark-icon',
        html: '<div class="race-mark-dot" style="background:' + markColor(m) + '"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
      var mk = L.marker([m.lat, m.lon], { icon: icon, keyboard: true, title: m.name });
      var round = m.rounding_hu ? '<div class="rounding">' + m.rounding_hu + '</div>' : '';
      var html = '<div class="mark-popup"><strong>' + escapeHtml(m.name) + '</strong>' + round +
        '<div class="pick-actions map-pick-popup">' +
        '<button type="button" class="pick-start" data-mark="' + m.id + '" data-role="start">Kezdőpontnak</button>' +
        '<button type="button" class="pick-goal" data-mark="' + m.id + '" data-role="goal">Célnak</button>' +
        '</div></div>';
      mk.bindPopup(html);
      mk.on('popupopen', function (ev) {
        var root = ev.popup.getElement();
        if (!root) return;
        root.querySelectorAll('button[data-mark]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (btn.getAttribute('data-role') === 'start') setStartFromKey(m.id);
            else setTargetFromKey(m.id);
            global.map.closePopup();
          });
        });
      });
      mk.addTo(global.map);
      markers.push(mk);
      bounds.push([m.lat, m.lon]);
    });
    state.markers = markers;
    state.markLayer = {
      getBounds: function () {
        return bounds.length && typeof L !== 'undefined' ? L.latLngBounds(bounds) : null;
      }
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function setStartFromKey(key) {
    var sel = $('startSelect');
    if (sel) {
      if (![].some.call(sel.options, function (o) { return o.value === key; })) {
        /* keep value usable even if the option is hidden in another race list */
        sel.appendChild(optionEl(key, (global.presets[key] && global.presets[key].name) || key));
      }
      sel.value = key;
    }
    if (typeof global.applyStartPosition === 'function') global.applyStartPosition();
  }

  function setTargetFromKey(key) {
    var sel = $('targetSelect');
    if (sel) {
      if (![].some.call(sel.options, function (o) { return o.value === key; })) {
        sel.appendChild(optionEl(key, (global.presets[key] && global.presets[key].name) || key));
      }
      sel.value = key;
    }
    if (typeof global.onTargetChange === 'function') global.onTargetChange();
    updateTargetMarkerFromSelection();
  }

  function setStartFromLatLon(lat, lon, label) {
    if (!inLakeBbox(lat, lon)) {
      tellSafe('A pont nincs a Balaton környékén.');
      return false;
    }
    var sel = $('startSelect');
    if (sel) sel.value = '';
    global.currentPos = { lat: lat, lon: lon, name: label || 'Térkép' };
    if (typeof global.updatePositionMarker === 'function') global.updatePositionMarker();
    var st = $('locStatus');
    if (st) st.textContent = (label ? label + ': ' : '') + lat.toFixed(5) + ', ' + lon.toFixed(5);
    return true;
  }

  function setTargetFromLatLon(lat, lon, label) {
    if (!inLakeBbox(lat, lon)) {
      tellSafe('A pont nincs a Balaton környékén.');
      return false;
    }
    var sel = $('targetSelect');
    if (sel) sel.value = 'manual';
    if ($('manualLat')) $('manualLat').value = String(lat);
    if ($('manualLon')) $('manualLon').value = String(lon);
    if (typeof global.onTargetChange === 'function') global.onTargetChange();
    var tStatus = $('targetStatus');
    if (tStatus) tStatus.textContent = (label || 'Térkép') + ': ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
    updateTargetMarkerFromSelection();
    return true;
  }

  function updateTargetMarkerFromSelection() {
    if (typeof global.getTarget !== 'function' || !global.map) return;
    var t = global.getTarget();
    if (!t) return;
    if (global.targetMarker) global.map.removeLayer(global.targetMarker);
    global.targetMarker = L.marker([t.lat, t.lon]).addTo(global.map).bindPopup(t.name || 'Cél');
  }

  function tellSafe(msg) {
    if (typeof global.tell === 'function') global.tell(msg);
    else alert(msg);
  }

  function selectRace(id, opts) {
    opts = opts || {};
    if (!state.raceById[id]) id = DEFAULT_RACE;
    state.currentRaceId = id;
    var sel = $('raceSelect');
    if (sel && sel.value !== id) sel.value = id;
    renderRaceMeta();
    rebuildPointSelects(opts.keepStart, opts.keepTarget);
    renderRaceMarks();
    if (!opts.silent && typeof global.map !== 'undefined' && global.map && state.markLayer) {
      try {
        var b = state.markLayer.getBounds && state.markLayer.getBounds();
        if (b && b.isValid()) global.map.fitBounds(b.pad(0.35));
      } catch (e) {}
    }
  }

  function raceIdOfKey(key) {
    if (state.markById[key]) return state.markById[key].raceId;
    if (key && String(key).indexOf('saved_') === 0) return null;
    return null;
  }

  function renderSavedList() {
    var box = $('savedPointsList');
    if (!box) return;
    box.innerHTML = '';
    if (!state.saved.length) {
      var empty = document.createElement('li');
      empty.textContent = 'Még nincs mentett pont.';
      box.appendChild(empty);
      return;
    }
    state.saved.forEach(function (p) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = p.name + ' (' + Number(p.lat).toFixed(5) + ', ' + Number(p.lon).toFixed(5) + ')';
      var actions = document.createElement('div');
      actions.className = 'saved-actions';
      var useStart = document.createElement('button');
      useStart.type = 'button';
      useStart.textContent = 'Kezdőpont';
      useStart.addEventListener('click', function () { setStartFromKey(p.id); });
      var useGoal = document.createElement('button');
      useGoal.type = 'button';
      useGoal.textContent = 'Cél';
      useGoal.addEventListener('click', function () { setTargetFromKey(p.id); });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'saved-del';
      del.textContent = 'Törlés';
      del.addEventListener('click', function () { deletePoint(p.id); });
      actions.appendChild(useStart);
      actions.appendChild(useGoal);
      actions.appendChild(del);
      li.appendChild(span);
      li.appendChild(actions);
      box.appendChild(li);
    });
  }

  function setSaveStatus(msg) {
    var el = $('savePointStatus');
    if (el) el.textContent = msg || '';
  }

  function savePoint(name, lat, lon) {
    name = String(name || '').trim();
    if (!name) { tellSafe('Adj nevet a pontnak.'); return null; }
    if (!isFinite(lat) || !isFinite(lon) || !inLakeBbox(lat, lon)) {
      tellSafe('Nincs menthető pozíció. Állíts be kezdőpontot vagy célt, vagy koppints a térképre.');
      return null;
    }
    var id = 'saved_' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    var rec = { id: id, name: name, lat: Number(lat), lon: Number(lon), created: Date.now() };
    state.saved.push(rec);
    persistSaved();
    if (typeof global.presets === 'object') {
      global.presets[id] = { lat: rec.lat, lon: rec.lon, name: rec.name, saved: true };
    }
    var keepS = $('startSelect') && $('startSelect').value;
    var keepT = $('targetSelect') && $('targetSelect').value;
    rebuildPointSelects(keepS, keepT);
    renderSavedList();
    setSaveStatus('Elmentve: ' + rec.name + ' (' + rec.lat.toFixed(5) + ', ' + rec.lon.toFixed(5) + ').');
    return rec;
  }

  function deletePoint(id) {
    state.saved = state.saved.filter(function (p) { return p.id !== id; });
    persistSaved();
    if (global.presets) delete global.presets[id];
    var keepS = $('startSelect') && $('startSelect').value === id ? '' : ($('startSelect') && $('startSelect').value);
    var keepT = $('targetSelect') && $('targetSelect').value === id ? 'manual' : ($('targetSelect') && $('targetSelect').value);
    rebuildPointSelects(keepS, keepT);
    renderSavedList();
    setSaveStatus('');
  }

  function currentSaveCandidate() {
    if (global.currentPos && isFinite(global.currentPos.lat)) {
      return { lat: global.currentPos.lat, lon: global.currentPos.lon, source: 'kezdőpont' };
    }
    if (typeof global.getTarget === 'function') {
      var t = global.getTarget();
      if (t) return { lat: t.lat, lon: t.lon, source: 'cél' };
    }
    return null;
  }

  function improvedGetLocation() {
    var status = $('locStatus');
    if (!navigator.geolocation) {
      if (status) status.textContent = 'A böngésző nem támogatja a helymeghatározást.';
      tellSafe('A böngésző nem támogatja a helymeghatározást.');
      return;
    }
    if (status) status.textContent = 'Keresés…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var acc = pos.coords.accuracy;
      if (!inLakeBbox(lat, lon)) {
        if (status) status.textContent = 'A mért pozíció nem a Balaton környékén van.';
        tellSafe('A mért pozíció nem a Balaton környékén van (' + lat.toFixed(5) + ', ' + lon.toFixed(5) + '). Állíts be pontot a listából vagy a térképen.');
        return;
      }
      var useLat = lat, useLon = lon, extra = '';
      if (!isOnWater(lat, lon)) {
        var snap = nearestNavigable(lat, lon, SNAP_GEO_M);
        if (!snap) {
          if (status) status.textContent = 'A mért pont nincs a tavon.';
          tellSafe('A mért pozíció a tó partján vagy kívül van, és 300 m-en belül nincs hajózható pont. Válassz pontot a térképen.');
          return;
        }
        useLat = snap.lat;
        useLon = snap.lon;
        extra = ' A mért pont parton volt; a legközelebbi vízi pontot használom, kb. ' + Math.round(snap.distM) + ' m-re.';
      }
      if (isFinite(acc) && acc > ACCURACY_HARD_M) {
        if (status) status.textContent = 'A helymeghatározás túl pontatlan (±' + Math.round(acc) + ' m).';
        tellSafe('A helymeghatározás túl pontatlan (±' + Math.round(acc) + ' m). Próbáld újra nyílt ég alatt, vagy válassz pontot a térképen.');
        return;
      }
      if (isFinite(acc) && acc > ACCURACY_SOFT_M) {
        extra += ' A pontosság kb. ±' + Math.round(acc) + ' m, érdemes ellenőrizni a térképen.';
      }
      setStartFromLatLon(useLat, useLon, 'Jelenlegi pozíció');
      if (status) status.textContent = 'Jelenlegi pozíció: ' + useLat.toFixed(5) + ', ' + useLon.toFixed(5) + extra;
    }, function (err) {
      var msg;
      if (err && err.code === 1) msg = 'A helymeghatározást a böngésző vagy a készülék elutasította. Engedélyezd a helyhozzáférést, vagy válassz pontot a térképen.';
      else if (err && err.code === 2) msg = 'A pozíció nem állapítható meg. Próbáld újra, vagy koppints a térképre.';
      else if (err && err.code === 3) msg = 'A helymeghatározás időtúllépés miatt nem sikerült.';
      else msg = 'Helymeghatározási hiba' + (err && err.message ? ': ' + err.message : '.');
      if (status) status.textContent = msg;
      tellSafe(msg);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function showPickPopup(latlng) {
    if (!global.map) return;
    if (state.pickPopup) global.map.closePopup(state.pickPopup);
    var lat = latlng.lat, lon = latlng.lng;
    var html = '<div class="map-pick-popup"><p>' + lat.toFixed(5) + ', ' + lon.toFixed(5) + '</p>' +
      '<div class="pick-actions">' +
      '<button type="button" class="pick-start" id="pickAsStart">Kezdőpontnak</button>' +
      '<button type="button" class="pick-goal" id="pickAsGoal">Célnak</button>' +
      '</div>' +
      '<div class="pick-save">' +
      '<label for="pickSaveName">Pont neve</label>' +
      '<input id="pickSaveName" type="text" maxlength="80" placeholder="pl. a kikötőnk" autocomplete="off">' +
      '<button type="button" class="pick-save-btn" id="pickAsSaved">Mentés pontként</button>' +
      '</div></div>';
    state.pickPopup = L.popup({ closeButton: true, className: 'marks-pick' })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(global.map);
    setTimeout(function () {
      var s = $('pickAsStart'), g = $('pickAsGoal'), sv = $('pickAsSaved'), nameEl = $('pickSaveName');
      if (s) s.addEventListener('click', function () {
        setStartFromLatLon(lat, lon, 'Térkép');
        global.map.closePopup();
      });
      if (g) g.addEventListener('click', function () {
        setTargetFromLatLon(lat, lon, 'Térkép');
        global.map.closePopup();
      });
      function doSave() {
        var rec = savePoint(nameEl ? nameEl.value : '', lat, lon);
        if (rec) global.map.closePopup();
        else if (nameEl) nameEl.focus();
      }
      if (sv) sv.addEventListener('click', doSave);
      if (nameEl) nameEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); doSave(); }
      });
    }, 0);
  }

  function bindMapPicks() {
    if (!global.map) return;
    global.map.on('click', function (e) {
      if (state.suppressClick) { state.suppressClick = false; return; }
      showPickPopup(e.latlng);
    });
    global.map.on('contextmenu', function (e) {
      if (e.originalEvent) e.originalEvent.preventDefault();
      showPickPopup(e.latlng);
    });
    var timer = null;
    var startPt = null;
    var container = global.map.getContainer();
    container.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      startPt = { x: t.clientX, y: t.clientY };
      var ll = global.map.mouseEventToLatLng(t);
      timer = setTimeout(function () {
        timer = null;
        state.suppressClick = true;
        showPickPopup(ll);
      }, 550);
    }, { passive: true });
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    container.addEventListener('touchend', cancel);
    container.addEventListener('touchcancel', cancel);
    container.addEventListener('touchmove', function (e) {
      if (!timer || !startPt || !e.touches[0]) return;
      var dx = e.touches[0].clientX - startPt.x, dy = e.touches[0].clientY - startPt.y;
      if (dx * dx + dy * dy > 100) cancel();
    }, { passive: true });
  }

  function wrapShareAndRoute() {
    if (Array.isArray(global.SHARE_KEYS) && global.SHARE_KEYS.indexOf('race') === -1) {
      global.SHARE_KEYS.push('race');
    }

    var origBuild = global.buildShareQuery;
    if (typeof origBuild === 'function') {
      global.buildShareQuery = function (opts) {
        var o = opts || {};
        /* If a known preset key is selected, prefer the key even if routing snapped the coords. */
        if (o.fromKey == null && $('startSelect') && $('startSelect').value && global.presets && global.presets[$('startSelect').value]) {
          o.fromKey = $('startSelect').value;
          var p = global.presets[o.fromKey];
          o.fromPos = { lat: p.lat, lon: p.lon };
        }
        if (o.toKey == null && $('targetSelect') && $('targetSelect').value && $('targetSelect').value !== 'manual' && global.presets && global.presets[$('targetSelect').value]) {
          o.toKey = $('targetSelect').value;
        }
        var qs = origBuild(o);
        if (state.currentRaceId) {
          var params = new URLSearchParams(qs);
          params.set('race', state.currentRaceId);
          var parts = [];
          params.forEach(function (v, k) {
            var ev = encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3A/gi, ':');
            parts.push(k + '=' + ev);
          });
          return parts.join('&');
        }
        return qs;
      };
    }

    var origApply = global.applyShareParams;
    if (typeof origApply === 'function') {
      global.applyShareParams = async function () {
        var q = new URLSearchParams(location.search);
        var race = q.get('race');
        var from = q.get('from');
        var to = q.get('to');
        var inferred = race && state.raceById[race] ? race : null;
        if (!inferred && from && state.markById[from]) inferred = state.markById[from].raceId;
        if (!inferred && to && state.markById[to]) inferred = state.markById[to].raceId;
        if (inferred) selectRace(inferred, { silent: true, keepStart: '', keepTarget: 'manual' });
        var result = await origApply.apply(this, arguments);
        /* Restore named keys even if the option list was rebuilt. */
        if (from && global.presets && global.presets[from]) setStartFromKey(from);
        else if (from && typeof global.parseLatLonParam === 'function') {
          var c = global.parseLatLonParam(from);
          if (c) setStartFromLatLon(c.lat, c.lon, 'Megosztott kezdőpont');
        }
        if (to && to !== 'manual' && global.presets && global.presets[to]) setTargetFromKey(to);
        else if (to && typeof global.parseLatLonParam === 'function') {
          var c2 = global.parseLatLonParam(to);
          if (c2) setTargetFromLatLon(c2.lat, c2.lon, 'Megosztott cél');
        }
        return result;
      };
    }

    global.getLocation = improvedGetLocation;
  }

  function bindUi() {
    var raceSel = $('raceSelect');
    if (raceSel) {
      raceSel.addEventListener('change', function () {
        selectRace(raceSel.value);
      });
    }
    var startSel = $('startSelect');
    var targetSel = $('targetSelect');
    if (targetSel) {
      targetSel.addEventListener('change', function () {
        updateTargetMarkerFromSelection();
      });
    }
    var saveBtn = $('savePointBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var name = $('savePointName') ? $('savePointName').value : '';
        var cand = currentSaveCandidate();
        if (!cand) { tellSafe('Előbb állíts be kezdőpontot vagy célt.'); return; }
        var rec = savePoint(name, cand.lat, cand.lon);
        if (rec && $('savePointName')) $('savePointName').value = '';
      });
    }
    /* geoBtn uses onclick="getLocation()"; getLocation is replaced in wrapShareAndRoute. */
  }

  function loadData() {
    if (global.RACE_MARK_DATA && global.RACE_MARK_DATA.races) {
      return Promise.resolve(global.RACE_MARK_DATA);
    }
    return fetch(DATA_URL, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('races.json HTTP ' + res.status);
      return res.json();
    });
  }

  function install() {
    if (state.installed) return Promise.resolve(api);
    injectCss();
    loadSaved();
    return loadData().then(function (data) {
      state.races = (data && data.races) || [];
      state.raceById = {};
      state.races.forEach(function (r) { state.raceById[r.id] = r; });
      registerAllPresets();
      fillRaceSelect();
      selectRace(DEFAULT_RACE, { silent: true });
      wrapShareAndRoute();
      bindUi();
      bindMapPicks();
      renderSavedList();
      state.installed = true;
      state.ready = true;
      return api;
    }).catch(function (err) {
      global.__marksInstallError = String(err && err.stack || err);
      throw err;
    });
  }

  var api = {
    install: install,
    selectRace: selectRace,
    currentRaceId: function () { return state.currentRaceId; },
    currentRace: currentRace,
    nearestNavigable: nearestNavigable,
    setStartFromKey: setStartFromKey,
    setTargetFromKey: setTargetFromKey,
    setStartFromLatLon: setStartFromLatLon,
    setTargetFromLatLon: setTargetFromLatLon,
    savePoint: savePoint,
    deletePoint: deletePoint,
    savedPoints: function () { return state.saved.slice(); },
    markById: function (id) { return state.markById[id]; },
    getLocation: improvedGetLocation,
    isReady: function () { return state.ready; },
    STORAGE_KEY: STORAGE_KEY
  };

  global.BalatonMarks = api;
})(typeof window !== 'undefined' ? window : this);
