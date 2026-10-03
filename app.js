'use strict';

// ---------- Analysis (pure functions, also used by tests) ----------

const HOUR = 3600e3;
const MAX_GAP = 3 * HOUR; // readings further apart than this aren't joined in charts/time stats

function sortReadings(readings) {
  return readings.slice().sort((a, b) => a.t - b.t);
}

// Split readings into charge / discharge sessions. A session ends when the charging
// flag flips, or when the level moves the wrong way (an unlogged charge or drain).
function buildSessions(readings) {
  const sessions = [];
  let cur = null;
  for (const r of readings) {
    const wrongWay = cur && (cur.charging ? r.level < cur.last.level - 1 : r.level > cur.last.level + 1);
    if (!cur || r.charging !== cur.charging || wrongWay || r.t - cur.last.t > 12 * HOUR) {
      if (cur) sessions.push(finishSession(cur));
      cur = { charging: r.charging, first: r, last: r, count: 1 };
    } else {
      cur.last = r;
      cur.count++;
    }
  }
  if (cur) sessions.push(finishSession(cur));
  return sessions;
}

function finishSession(s) {
  const hours = (s.last.t - s.first.t) / HOUR;
  const delta = s.last.level - s.first.level;
  return {
    charging: s.charging,
    start: s.first.t,
    end: s.last.t,
    startLevel: s.first.level,
    endLevel: s.last.level,
    hours,
    count: s.count,
    rate: hours > 0 ? Math.abs(delta) / hours : null, // %/h
  };
}

// Average discharge rate (%/h), weighted by time, over sessions long enough to be meaningful.
function avgDischargeRate(sessions, minHours = 0.5) {
  let drop = 0;
  let hours = 0;
  for (const s of sessions) {
    if (s.charging || s.hours < minHours || s.startLevel <= s.endLevel) continue;
    drop += s.startLevel - s.endLevel;
    hours += s.hours;
  }
  return hours > 0 ? drop / hours : null;
}

// Every percent gained counts toward a full cycle, including charges that happened between logs.
function equivalentCycles(readings) {
  let gained = 0;
  for (let i = 1; i < readings.length; i++) {
    const d = readings[i].level - readings[i - 1].level;
    if (d > 0) gained += d;
  }
  return gained / 100;
}

// Fraction of logged time spent in each level band, ignoring long gaps.
function timeInBands(readings) {
  let total = 0, high = 0, low = 0, hot = 0, tempTime = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const dt = readings[i].t - a.t;
    if (dt <= 0 || dt > MAX_GAP) continue;
    total += dt;
    if (a.level > 80) high += dt;
    if (a.level < 20) low += dt;
    if (a.temp != null) {
      tempTime += dt;
      if (a.temp >= 40) hot += dt;
    }
  }
  return {
    hours: total / HOUR,
    high: total ? high / total : 0,
    low: total ? low / total : 0,
    hot: tempTime ? hot / tempTime : null,
  };
}

// Estimate hours until empty (discharging) or full (charging) from the current session.
function estimateRemaining(readings, sessions, fallbackRate) {
  if (!readings.length) return null;
  const now = readings[readings.length - 1];
  const s = sessions[sessions.length - 1];
  let rate = null;
  if (s && s.hours >= 0.25 && s.rate) {
    // Use the most recent ~3 hours of the session for a responsive estimate.
    const from = Math.max(s.start, now.t - 3 * HOUR);
    const ref = readings.find((r) => r.t >= from);
    const h = (now.t - ref.t) / HOUR;
    if (h >= 0.25 && ref.level !== now.level) rate = Math.abs(now.level - ref.level) / h;
    else rate = s.rate;
  }
  if (!rate && !now.charging) rate = fallbackRate;
  if (!rate) return null;
  return now.charging ? (100 - now.level) / rate : now.level / rate;
}

// ---------- Parsing / export ----------

function parseImport(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    const readings = Array.isArray(data) ? data : data.readings || [];
    return { readings: readings.map(normalize).filter(Boolean), health: Array.isArray(data) ? [] : data.health || [] };
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const col = (names) => header.findIndex((h) => names.includes(h));
  const iT = col(['timestamp', 'time', 'timestamp_iso', 't']);
  const iL = col(['percentage', 'level', 'battery']);
  const iS = col(['status', 'charging']);
  const iP = col(['plugged']);
  const iTemp = col(['temperature', 'temp']);
  const iCur = col(['current', 'current_ua']);
  const iH = col(['health']);
  if (iT < 0 || iL < 0) throw new Error('CSV needs a timestamp and a percentage/level column');
  const readings = lines.map((line) => {
    const c = line.split(',').map((v) => v.trim());
    const status = (c[iS] || '').toUpperCase();
    const plugged = (c[iP] || '').toUpperCase();
    return normalize({
      t: c[iT],
      level: c[iL],
      charging: status === 'CHARGING' || status === 'FULL' || status === 'TRUE' || (plugged !== '' && plugged !== 'UNPLUGGED'),
      temp: iTemp >= 0 ? c[iTemp] : null,
      current: iCur >= 0 ? c[iCur] : null,
      health: iH >= 0 ? c[iH] : null,
      src: 'import',
    });
  }).filter(Boolean);
  return { readings, health: [] };
}

function normalize(r) {
  const t = typeof r.t === 'number' ? r.t : /^\d+$/.test(String(r.t)) ? Number(r.t) : Date.parse(r.t);
  const level = Number(r.level);
  if (!Number.isFinite(t) || !Number.isFinite(level) || level < 0 || level > 100) return null;
  const out = { t, level: Math.round(level), charging: r.charging === true || r.charging === 'true' };
  const temp = r.temp === '' || r.temp == null ? NaN : Number(r.temp);
  const current = r.current === '' || r.current == null ? NaN : Number(r.current);
  if (Number.isFinite(temp)) out.temp = temp;
  if (Number.isFinite(current)) out.current = current;
  if (r.health) out.health = String(r.health);
  if (r.src) out.src = r.src;
  return out;
}

// Merge readings, dropping exact-timestamp duplicates.
function mergeReadings(existing, incoming) {
  const map = new Map(existing.map((r) => [r.t, r]));
  for (const r of incoming) if (!map.has(r.t)) map.set(r.t, r);
  return sortReadings([...map.values()]);
}

function toCSV(readings) {
  const rows = ['timestamp,percentage,status,temperature,current,health'];
  for (const r of readings) {
    rows.push([new Date(r.t).toISOString(), r.level, r.charging ? 'CHARGING' : 'DISCHARGING', r.temp ?? '', r.current ?? '', r.health ?? ''].join(','));
  }
  return rows.join('\n') + '\n';
}

if (typeof module !== 'undefined') {
  module.exports = { buildSessions, avgDischargeRate, equivalentCycles, timeInBands, estimateRemaining, parseImport, mergeReadings, toCSV, normalize };
}

// ---------- UI ----------

if (typeof document !== 'undefined') {
  const KEY = 'bt.readings.v1';
  const HKEY = 'bt.health.v1';
  const AUTO_LOG_MS = 5 * 60e3;

  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { alert('Could not save: ' + e.message); } };

  let readings = sortReadings(load(KEY));
  let health = load(HKEY);
  let rangeH = 24;
  let battery = null;

  const $ = (id) => document.getElementById(id);
  const pct = (x) => Math.round(x * 100) + '%';
  const fmtH = (h) => {
    if (h == null || !Number.isFinite(h)) return '–';
    if (h < 1) return Math.round(h * 60) + ' min';
    const H = Math.floor(h), M = Math.round((h - H) * 60);
    return M ? `${H}h ${M}m` : `${H}h`;
  };
  const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function addReading(r) {
    const last = readings[readings.length - 1];
    // Skip duplicates logged within a minute with no change.
    if (last && r.t - last.t < 60e3 && last.level === r.level && last.charging === r.charging) return;
    readings.push(r);
    save(KEY, readings);
    render();
  }

  function logFromBattery() {
    if (!battery) return;
    addReading({ t: Date.now(), level: Math.round(battery.level * 100), charging: battery.charging, src: 'app' });
  }

  async function initBattery() {
    if (!navigator.getBattery) {
      $('api-warning').hidden = false;
      render();
      return;
    }
    battery = await navigator.getBattery();
    battery.addEventListener('levelchange', logFromBattery);
    battery.addEventListener('chargingchange', logFromBattery);
    logFromBattery();
    setInterval(logFromBattery, AUTO_LOG_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) logFromBattery(); });
  }

  function renderNow(sessions, avgRate) {
    const last = readings[readings.length - 1];
    const level = battery ? Math.round(battery.level * 100) : last?.level;
    const charging = battery ? battery.charging : last?.charging;
    if (level == null) return;
    $('level').textContent = level;
    $('gauge-fill').style.height = level + '%';
    $('gauge').classList.toggle('low', level < 20 && !charging);
    $('state').textContent = (charging ? 'Charging' : 'On battery') + (battery ? '' : ` · last logged ${fmtTime(last.t)}`);
    const eta = estimateRemaining(readings, sessions, avgRate);
    let tip = '';
    if (charging && level >= 80) tip = ' · consider unplugging around 80–85% to slow wear';
    $('eta').textContent = eta ? (charging ? `Full in ~${fmtH(eta)}` : `~${fmtH(eta)} remaining at current drain`) + tip : tip.replace(/^ · /, '');
  }

  function renderChart() {
    const el = $('chart');
    const W = el.clientWidth || 600, H = el.clientHeight || 200;
    const pad = { l: 28, r: 6, t: 8, b: 20 };
    const now = Date.now();
    const t0 = now - rangeH * HOUR;
    const pts = readings.filter((r) => r.t >= t0);
    const x = (t) => pad.l + ((t - t0) / (now - t0)) * (W - pad.l - pad.r);
    const y = (l) => pad.t + (1 - l / 100) * (H - pad.t - pad.b);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Battery level over the last ${rangeH} hours">`;
    svg += `<rect class="band" x="${pad.l}" y="${y(80)}" width="${W - pad.l - pad.r}" height="${y(20) - y(80)}"/>`;
    for (const l of [0, 20, 50, 80, 100]) {
      svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(l)}" y2="${y(l)}"/>`;
      svg += `<text class="axis" x="${pad.l - 4}" y="${y(l) + 3}" text-anchor="end">${l}</text>`;
    }
    // Roughly one label per 80px so they don't collide on narrow screens.
    const ticks = Math.max(2, Math.min(rangeH === 168 ? 7 : 6, Math.floor((W - pad.l - pad.r) / 80)));
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + (i / ticks) * (now - t0);
      const d = new Date(t);
      const label = rangeH <= 24 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
      svg += `<text class="axis" x="${x(t)}" y="${H - 5}" text-anchor="${anchor}">${label}</text>`;
    }
    if (pts.length < 2) {
      svg += `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Not enough readings in this range yet</text>`;
    } else {
      // Charging shading
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (a.charging && b.t - a.t <= MAX_GAP) svg += `<rect class="chg" x="${x(a.t)}" y="${pad.t}" width="${Math.max(1, x(b.t) - x(a.t))}" height="${H - pad.t - pad.b}"/>`;
      }
      // Level line, broken across long gaps
      let path = '';
      pts.forEach((p, i) => {
        const gap = i === 0 || p.t - pts[i - 1].t > MAX_GAP;
        path += `${gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.level).toFixed(1)}`;
      });
      svg += `<path class="line" d="${path}"/>`;
    }
    el.innerHTML = svg + '</svg>';
  }

  function tile(k, v, s = '') {
    return `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  }

  function renderStats(sessions, avgRate) {
    const weekAgo = Date.now() - 168 * HOUR;
    const week = readings.filter((r) => r.t >= weekAgo);
    const weekSessions = sessions.filter((s) => s.end >= weekAgo);
    const bands = timeInBands(week);
    const charges = weekSessions.filter((s) => s.charging && s.endLevel > s.startLevel + 5).length;
    const cycles = equivalentCycles(readings);
    const days = readings.length > 1 ? (readings[readings.length - 1].t - readings[0].t) / (24 * HOUR) : 0;
    const temps = week.filter((r) => r.temp != null).map((r) => r.temp);
    const fullDay = avgRate ? 100 / avgRate : null;
    let html = '';
    html += tile('Avg drain', avgRate ? avgRate.toFixed(1) + '%/h' : '–', fullDay ? `≈ ${fmtH(fullDay)} from 100% to 0%` : 'needs some discharge data');
    html += tile('Charges (7d)', charges, weekSessions.length ? `${(charges / 7).toFixed(1)} per day` : '');
    html += tile('Cycles logged', cycles.toFixed(1), days >= 1 ? `over ${Math.round(days)} days` : 'equivalent full cycles');
    html += tile('Time above 80%', bands.hours ? pct(bands.high) : '–', 'last 7 days (lower is better)');
    html += tile('Time below 20%', bands.hours ? pct(bands.low) : '–', 'last 7 days (lower is better)');
    html += temps.length
      ? tile('Temperature', Math.max(...temps).toFixed(1) + '°C', `peak this week · ${bands.hot != null ? pct(bands.hot) : '–'} of time ≥ 40°C`)
      : tile('Logged time', fmtH(bands.hours), 'last 7 days');
    $('stats').innerHTML = html;
  }

  function renderSessions(sessions) {
    const recent = sessions.filter((s) => s.hours >= 0.1).slice(-8).reverse();
    $('sessions').innerHTML = recent.length
      ? recent.map((s) => `<li><span><span class="tag ${s.charging ? 'c' : ''}">${s.charging ? 'Charge' : 'Drain'}</span> ${s.startLevel}% → ${s.endLevel}%<br><span class="muted small">${fmtTime(s.start)} · ${fmtH(s.hours)}</span></span><span class="muted">${s.rate ? s.rate.toFixed(1) + '%/h' : ''}</span></li>`).join('')
      : '<li class="muted">Sessions show up after the app has logged for a while.</li>';
  }

  function renderHealth() {
    $('health').innerHTML = health.length
      ? health.map((h, i) => `<li><span>${h.date}${h.cycles !== '' && h.cycles != null ? ` · ${h.cycles} cycles` : ''}${h.status ? ` · ${escapeHTML(h.status)}` : ''}</span><button data-i="${i}" aria-label="Remove">×</button></li>`).join('')
      : '<li class="muted">No entries yet.</li>';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    const sessions = buildSessions(readings);
    const avgRate = avgDischargeRate(sessions);
    renderNow(sessions, avgRate);
    renderChart();
    renderStats(sessions, avgRate);
    renderSessions(sessions);
    renderHealth();
    $('count').textContent = `${readings.length} readings stored on this device.`;
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Events
  $('range').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    rangeH = Number(b.dataset.h);
    for (const x of $('range').children) x.classList.toggle('on', x === b);
    renderChart();
  });
  $('log-now').addEventListener('click', () => (battery ? logFromBattery() : alert('Battery API not available in this browser.')));
  $('export-csv').addEventListener('click', () => download(`battery-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(readings), 'text/csv'));
  $('export-json').addEventListener('click', () => download(`battery-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ readings, health }, null, 1), 'application/json'));
  $('import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = parseImport(await file.text());
      const before = readings.length;
      readings = mergeReadings(readings, data.readings);
      if (data.health.length) health = health.concat(data.health);
      save(KEY, readings);
      save(HKEY, health);
      render();
      alert(`Imported ${readings.length - before} new readings.`);
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    e.target.value = '';
  });
  $('clear').addEventListener('click', () => {
    if (!confirm('Delete all readings and health entries from this device? Export first if you want a backup.')) return;
    readings = [];
    health = [];
    save(KEY, readings);
    save(HKEY, health);
    render();
  });
  $('health-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    health.push({ date: f.get('date'), cycles: f.get('cycles'), status: f.get('status').trim() });
    health.sort((a, b) => b.date.localeCompare(a.date));
    save(HKEY, health);
    e.target.reset();
    e.target.date.valueAsDate = new Date();
    renderHealth();
  });
  $('health').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    health.splice(Number(b.dataset.i), 1);
    save(HKEY, health);
    renderHealth();
  });
  window.addEventListener('resize', renderChart);

  document.querySelector('#health-form [name=date]').valueAsDate = new Date();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  initBattery().catch(() => { $('api-warning').hidden = false; render(); });
  render();
}
