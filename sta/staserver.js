// sta-server.js (CommonJS)
// Sense–Think–Act demo: poll a frost predictor every 15 min (configurable),
// decide an action per sensor, and serve a live-updating web page via SSE.
//
// Requires: `npm i express` (Node 18+; uses global fetch)

const express = require('express');
const path = require('path');

// ---------- Config (override via env) ----------
const CFG = Object.freeze({
  PORT: Number(process.env.PORT || 3010),

  // Predictor URL (your ONNX/LightGBM predictor HTTP endpoint)
  // e.g. through your HTTPS webserver proxy:
  //   https://ec2-13-211-237-240.ap-southeast-2.compute.amazonaws.com:8443/predict
  // or direct to the predictor:
  //   http://localhost:8060/predict
  PREDICT_URL: process.env.PREDICT_URL || 'http://localhost:8060/predict',

  // Optional Basic auth for talking to the predictor (if protected)
  PREDICT_BASIC_USER: process.env.PREDICT_BASIC_USER || '',
  PREDICT_BASIC_PASS: process.env.PREDICT_BASIC_PASS || '',

  LOOKBACK_HOURS: Number(process.env.LOOKBACK_HOURS || 24),

  // Forward prediction controls (if your predictor supports them)
  FORWARD: /^true$/i.test(process.env.FORWARD || 'true'),
  HORIZON_HOURS: Number(process.env.HORIZON_HOURS || 8),

  // Decision threshold (probability >= threshold => frost)
  FROST_THRESHOLD: Number(process.env.FROST_THRESHOLD || 0.8),

  // Refresh cadence
  UPDATE_INTERVAL_MS: Number(process.env.UPDATE_INTERVAL_MS || 15 * 60 * 1000),

  TITLE: process.env.TITLE || 'Sense–Think–Act: Frost Control',
});

// ---------- Small helpers ----------
function toIso(t) { return new Date(t).toISOString(); }
function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function pct(x, digits = 1) {
  if (x == null || !Number.isFinite(Number(x))) return '';
  return (Number(x) * 100).toFixed(digits) + '%';
}
function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
function badge(text, kind) {
  const cls = kind === 'warn' ? 'warn' : 'ok';
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

// ---------- Shared state ----------
const STATE = {
  lastRunAt: null,     // ISO
  forward: CFG.FORWARD,
  horizonHours: CFG.HORIZON_HOURS,
  items: [],           // [{sensorName, time, score, decision, reason}]
  error: null,
};

// ---------- Poll predictor (Sense + Think) ----------
async function pollPredictor() {
  const now = Date.now();
  const from = toIso(now - CFG.LOOKBACK_HOURS * 3600 * 1000);
  const to   = toIso(now);

  const url = new URL(CFG.PREDICT_URL);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  if (CFG.FORWARD) {
    url.searchParams.set('forward', 'true');
    url.searchParams.set('horizonHours', String(CFG.HORIZON_HOURS));
  }

  const headers = {};
  if (CFG.PREDICT_BASIC_USER && CFG.PREDICT_BASIC_PASS) {
    headers['Authorization'] = 'Basic ' + b64(`${CFG.PREDICT_BASIC_USER}:${CFG.PREDICT_BASIC_PASS}`);
  }

  let json;
  try {
    const r = await fetch(url.toString(), { headers, cache: 'no-store' });
    const text = await r.text();
    if (!r.ok) throw new Error(`Predictor ${r.status}: ${text}`);
    json = JSON.parse(text);
  } catch (e) {
    STATE.lastRunAt = toIso(Date.now());
    STATE.error = e?.message || String(e);
    STATE.items = [];
    broadcast();
    return;
  }

  // Normalize points -> decisions
  const rows = Array.isArray(json.points) ? json.points : [];
  const items = rows.map(p => {
    const score = safeNumber(p.score);
    const frost = score != null && score >= CFG.FROST_THRESHOLD;

    let decision, reason;
    if (score == null) {
      decision = 'UNKNOWN';
      reason   = 'No probability available from predictor';
    } else if (frost) {
      decision = 'TAKE ACTION';
      reason   = `Frost risk ${pct(score)} ≥ ${pct(CFG.FROST_THRESHOLD)}${json.forward ? ` (forward ${json.horizonHours}h)` : ''}`;
    } else {
      decision = 'NO ACTION';
      reason   = `Frost risk ${pct(score)} < ${pct(CFG.FROST_THRESHOLD)}`;
    }

    return {
      sensorName: p.sensorName || 'unknown',
      time: p.time || '',
      score,
      decision,
      reason,
    };
  });

  // Keep latest by sensor (by time)
  const latestBySensor = new Map();
  for (const it of items) {
    const prev = latestBySensor.get(it.sensorName);
    const tms  = it.time ? Date.parse(it.time) : 0;
    if (!prev || tms > Date.parse(prev.time || 0)) latestBySensor.set(it.sensorName, it);
  }

  STATE.lastRunAt = toIso(Date.now());
  STATE.error = null;
  STATE.items = Array.from(latestBySensor.values())
    .sort((a,b)=> String(a.sensorName).localeCompare(String(b.sensorName)));

  broadcast();
}

// ---------- Schedule polling ----------
setInterval(pollPredictor, CFG.UPDATE_INTERVAL_MS);
pollPredictor(); // run once at boot

// ---------- HTTP server ----------
const app = express();

// Main page (simple HTML)
app.get('/', (_req, res) => {
  res.type('html').send(renderPage(STATE));
});

// JSON status (useful for curl/tests)
app.get('/status', (_req, res) => {
  res.json({
    title: CFG.TITLE,
    lastRunAt: STATE.lastRunAt,
    forward: STATE.forward,
    horizonHours: STATE.horizonHours,
    lookbackHours: CFG.LOOKBACK_HOURS,
    threshold: CFG.FROST_THRESHOLD,
    count: STATE.items.length,
    error: STATE.error,
    items: STATE.items,
  });
});

// SSE live updates
const clients = new Set();
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Initial snapshot
  res.write(`event: snapshot\ndata: ${JSON.stringify(ssePayload())}\n\n`);

  const client = { res };
  clients.add(client);
  req.on('close', () => clients.delete(client));
});

function ssePayload() {
  return {
    lastRunAt: STATE.lastRunAt,
    forward: STATE.forward,
    horizonHours: STATE.horizonHours,
    threshold: CFG.FROST_THRESHOLD,
    error: STATE.error,
    items: STATE.items,
  };
}

function broadcast() {
  const payload = `event: update\ndata: ${JSON.stringify(ssePayload())}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); } catch { /* ignore */ }
  }
}

// ---------- Page template ----------
function renderPage(state) {
  const rows = (state.items.length
    ? state.items.map(it => {
        const frost = it.decision === 'HEAT_ON';
        const score = (it.score == null) ? '' : pct(it.score, 1);
        return `
      <tr>
        <td>${escapeHtml(it.sensorName)}</td>
        <td>${escapeHtml(it.time || '')}</td>
        <td>${escapeHtml(score)}</td>
        <td>${frost ? badge('FROST', 'warn') : badge('No frost', 'ok')}</td>
        <td><code>${escapeHtml(it.decision)}</code></td>
        <td>${escapeHtml(it.reason)}</td>
      </tr>`;
      }).join('')
    : `<tr><td colspan="6">${state.error ? escapeHtml(state.error) : 'No data yet…'}</td></tr>`);

  const forwardTxt = state.forward ? `Yes (${state.horizonHours}h)` : 'No';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(CFG.TITLE)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,sans-serif;margin:2rem;line-height:1.45}
h1{margin:0 0 .25rem}
.muted{color:#666;margin:0 0 1rem}
.badge{display:inline-block;padding:.15rem .45rem;border-radius:999px;font-size:.8rem;font-weight:600}
.ok{background:#e6f7ef;color:#065f46;border:1px solid #a7f3d0}
.warn{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{border:1px solid #e5e7eb;padding:.5rem;text-align:left} th{background:#f9fafb}
#meta{margin:.5rem 0 0}
#err{margin:.5rem 0 0;color:#b91c1c}
@media (prefers-color-scheme: dark){
  th,td{border-color:#374151} th{background:#111827}
}
</style>
</head>
<body>
  <h1>${escapeHtml(CFG.TITLE)}</h1>
  <p class="muted">Forward prediction: <b>${escapeHtml(forwardTxt)}</b>. Lookback: <b>${CFG.LOOKBACK_HOURS}h</b>. Refresh: <b>${Math.round(CFG.UPDATE_INTERVAL_MS/60000)} min</b>. Threshold: <b>${pct(CFG.FROST_THRESHOLD)}</b>.</p>

  <div id="meta" class="muted">Last update: <span id="lastRun">${escapeHtml(state.lastRunAt || '—')}</span></div>
  <div id="err">${state.error ? escapeHtml(state.error) : ''}</div>

  <table>
    <thead>
      <tr>
        <th>Sensor</th>
        <th>Prediction time (UTC)</th>
        <th>Probability</th>
        <th>Status</th>
        <th>Decision</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody id="tbody">
      ${rows}
    </tbody>
  </table>

<script>
(function(){
  const tbody = document.getElementById('tbody');
  const lastRun = document.getElementById('lastRun');
  const err = document.getElementById('err');

  function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function pct(x){ return (x==null || !isFinite(x)) ? '' : (Number(x)*100).toFixed(1) + '%'; }
  function badge(text, kind){ return '<span class="badge '+(kind==='warn'?'warn':'ok')+'">'+esc(text)+'</span>'; }

  function render(payload){
    if (payload.lastRunAt) lastRun.textContent = payload.lastRunAt;
    err.textContent = payload.error ? String(payload.error) : '';
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6">'+ (payload.error ? esc(payload.error) : 'No data yet…') +'</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(it=>{
      const frost = it.decision === 'HEAT_ON';
      const score = (it.score == null) ? '' : pct(it.score);
      return '<tr>'
        + '<td>'+esc(it.sensorName||'unknown')+'</td>'
        + '<td>'+esc(it.time||'')+'</td>'
        + '<td>'+esc(score)+'</td>'
        + '<td>'+ (frost ? badge('FROST','warn') : badge('No frost','ok')) +'</td>'
        + '<td><code>'+esc(it.decision)+'</code></td>'
        + '<td>'+esc(it.reason||'')+'</td>'
        + '</tr>';
    }).join('');
  }

  try{
    const es = new EventSource('/events');
    es.addEventListener('snapshot', ev => render(JSON.parse(ev.data)));
    es.addEventListener('update',   ev => render(JSON.parse(ev.data)));
    es.onerror = () => { /* browser will auto-reconnect */ };
  }catch(_){
    // Fallback: poll /status every 30s (if SSE not available)
    setInterval(async ()=>{
      try{
        const r = await fetch('/status', {cache:'no-store'});
        if (!r.ok) return;
        const j = await r.json();
        render(j);
      }catch(_){}
    }, 30000);
  }
})();
</script>
</body></html>`;
}

// ---------- Start ----------
app.listen(CFG.PORT, () => {
  console.log(`[sta] listening on http://0.0.0.0:${CFG.PORT}`);
  console.log(`[sta] predictor: ${CFG.PREDICT_URL} (forward=${CFG.FORWARD}, horizon=${CFG.HORIZON_HOURS}h)`);
});
