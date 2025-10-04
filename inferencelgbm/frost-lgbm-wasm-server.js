// Frost predictor (LightGBM ONNX via onnxruntime-web WASM)
// Node 18+ (ESM)

import 'dotenv/config';
import express from 'express';
import morgan  from 'morgan';
import fs      from 'node:fs/promises';
import path    from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetch as undiciFetch } from 'undici';
import * as ort from 'onnxruntime-web';

// ------------------------------------------------------------------
// WASM runtime wiring: use absolute file:// URL so ORT doesn't do dist/dist
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ORT_WASM_DIR = path.join(__dirname, 'dist');                 // your local dist/
ort.env.wasm.wasmPaths = pathToFileURL(ORT_WASM_DIR + '/').href;   // e.g. file:///.../dist/
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;

// Ensure fetch exists (Node 18 has global fetch; undiciFetch is fine fallback)
globalThis.fetch = globalThis.fetch || undiciFetch;

// ------------------------------------------------------------------
// Config
const CFG = Object.freeze({
  PORT: Number(process.env.PORT || 8060),

  API_BASE: (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, ''),
  API_KEY:  process.env.API_KEY || '',
  SERIES_PATH: process.env.SERIES_PATH || '/sensors/timeseries',

  SENSOR_FIELD: process.env.SENSOR_FIELD || 'sensorId',
  TIME_FIELD:   process.env.TIME_FIELD   || 'time',

  ONNX_MODEL: process.env.ONNX_MODEL || path.join(__dirname, 'frost_lgbm.onnx'),
  FEATURES_JSON: process.env.FEATURES_JSON || path.join(__dirname, 'features.json'),
  SCALER_JSON:   process.env.SCALER_JSON   || path.join(__dirname, 'scaler_light.json'),

  FORWARD_WINDOW_H: Number(process.env.FORWARD_WINDOW_H || 8),
  DEFAULT_FWD_HORIZON_H: Number(process.env.DEFAULT_FWD_HORIZON_H || 8),
});

// ------------------------------------------------------------------
// Default 36 features (used if features.json absent)
const DEFAULT_FEATURES_36 = [
  'temperature', 'humidity', 'dewpoint', 'td_spread',
  'temp_mean_3h', 'temp_min_3h', 'temp_max_3h',
  'hum_mean_3h',  'hum_min_3h',  'hum_max_3h',
  'temp_mean_6h', 'temp_min_6h', 'temp_max_6h',
  'hum_mean_6h',  'hum_min_6h',  'hum_max_6h',
  'temp_mean_12h','temp_min_12h','temp_max_12h',
  'hum_mean_12h', 'hum_min_12h', 'hum_max_12h',
  'temp_lag_1h','temp_lag_3h','temp_lag_6h',
  'hum_lag_1h','hum_lag_3h','hum_lag_6h',
  'hr_bin_0', 'hr_bin_1', 'hr_bin_2', 'hr_bin_3'
];

let session = null;
let FEATURE_NAMES = DEFAULT_FEATURES_36.slice();
let SCALER = null;

// ------------------------------------------------------------------
// Boot: load features.json (optional), scaler (optional), ONNX
async function boot() {
  try {
    const fraw = await fs.readFile(CFG.FEATURES_JSON, 'utf8');
    const j = JSON.parse(fraw);
    if (Array.isArray(j.feature_names) && j.feature_names.length === 36) {
      FEATURE_NAMES = j.feature_names.slice();
      console.log('[boot] Using feature order from features.json');
    } else {
      console.log('[boot] features.json present but not 36 names; using defaults.');
    }
  } catch {
    console.log('[boot] features.json not found; using default 36 features.');
  }

  try {
    const sraw = await fs.readFile(CFG.SCALER_JSON, 'utf8');
    const s = JSON.parse(sraw);
    if (Array.isArray(s.mean) && Array.isArray(s.scale)) {
      SCALER = { mean: s.mean.map(Number), scale: s.scale.map(x => (x ? Number(x) : 1)) };
      console.log('[boot] Loaded scaler stats');
    }
  } catch {
    console.log('[boot] scaler_light.json not found; using raw inputs (no scaling).');
  }

  const bytes = new Uint8Array(await fs.readFile(CFG.ONNX_MODEL));
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  console.log('[onnx] loaded OK');
  console.log('  inputs :', session.inputNames);
  console.log('  outputs:', session.outputNames);
}
await boot();

// ------------------------------------------------------------------
// Helpers
const toNum = v => (v == null || !isFinite(Number(v)) ? null : Number(v));

function dewpointC(tC, rhPct) {
  if (tC == null || rhPct == null) return null;
  const a = 17.62, b = 243.12;
  const gamma = (a * tC) / (b + tC) + Math.log(Math.max(1e-6, rhPct / 100));
  return (b * gamma) / (a - gamma);
}

function hourBin4(dateIso) {
  const d = new Date(dateIso);
  const h = d.getUTCHours();
  const bin = Math.floor(h / 6); // 0..3
  return [0,1,2,3].map(i => (i === bin ? 1 : 0));
}

function normKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function getCI(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const nk = normKey(key);
  for (const [k,v] of Object.entries(obj)) if (normKey(k) === nk) return v;
  return undefined;
}
function fromTopOrObject(doc, name) {
  const vObj = getCI(doc?.object, name);
  if (vObj !== undefined) return vObj;
  return getCI(doc, name);
}
function pickTime(doc, tf) {
  return doc?.[tf] || doc?.time || doc?.iso || (doc?.ts ? new Date(doc.ts).toISOString() : null);
}
function pickSensor(doc, sf) {
  return doc?.deviceInfo?.deviceName || doc?.[sf] || doc?.sensorId || doc?.deviceName || doc?._id || 'unknown';
}

function extractTempHum(doc) {
  let t =
    fromTopOrObject(doc, 'TempC_SHT') ??
    fromTopOrObject(doc, 'TempC1') ??
    fromTopOrObject(doc, 'temperature_c') ??
    fromTopOrObject(doc, 'temperature') ??
    fromTopOrObject(doc, 'temp_c') ??
    fromTopOrObject(doc, 'temp');
  t = toNum(t);

  let h =
    fromTopOrObject(doc, 'Hum_SHT') ??
    fromTopOrObject(doc, 'relative_humidity') ??
    fromTopOrObject(doc, 'humidity') ??
    fromTopOrObject(doc, 'rh');
  h = toNum(h);

  return { t, h };
}

function toNumberArray(typed) {
  const n = typed.length;
  const out = new Array(n);
  for (let i=0;i<n;i++) {
    const v = typed[i];
    out[i] = (typeof v === 'bigint') ? Number(v) : Number(v);
  }
  return out;
}

function extractProbs(runOutput) {
  const names = session.outputNames;
  let probName =
    names.find(n => /prob/i.test(n)) ||
    names.find(n => {
      const o = runOutput[n];
      return o && Array.isArray(o.dims) && o.dims.length === 2;
    }) ||
    names[0];

  const out  = runOutput[probName] || runOutput[names[0]];
  const dims = out.dims || [];
  const data = toNumberArray(out.data);

  if (dims.length === 2) {
    const N = dims[0] || 0, C = dims[1] || 0;
    if (C === 2) {
      const probs = new Array(N);
      for (let i=0;i<N;i++) probs[i] = data[i*2 + 1]; // P(class=1)
      return probs;
    }
    if (C === 1) return data.slice(0, N);
    // Multiclass → max prob (rare for binary LGBM)
    const probs = new Array(N);
    for (let i=0;i<N;i++) {
      let best = -Infinity;
      for (let j=0;j<C;j++) best = Math.max(best, data[i*C + j]);
      probs[i] = best;
    }
    return probs;
  }

  if (dims.length === 1) {
    const N = dims[0] || data.length;
    return data.slice(0, N);
  }
  return data;
}

function applyScaler(vec) {
  if (!SCALER) return vec;
  const { mean, scale } = SCALER;
  if (mean.length !== vec.length || scale.length !== vec.length) return vec;
  return vec.map((v, i) => (v - mean[i]) / (scale[i] || 1));
}

// ------------------------------------------------------------------
// Fetch timeseries from your API
async function fetchTimeSeries({ from, to }) {
  const url = new URL(CFG.SERIES_PATH, CFG.API_BASE);
  if (from) url.searchParams.set('from', from);
  if (to)   url.searchParams.set('to',   to);
  url.searchParams.set('sensorField', CFG.SENSOR_FIELD);
  url.searchParams.set('timeField',   CFG.TIME_FIELD);

  const r = await fetch(url, { headers: { 'x-api-key': CFG.API_KEY } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`API ${r.status}: ${txt}`);
  const j = JSON.parse(txt);
  // Accept {points}, {items}, or bare array
  return Array.isArray(j) ? j : (j.points || j.items || []);
}

// ------------------------------------------------------------------
// Build 36-dim vector from a window (sorted asc), refIso stamps the time
function buildFeatureVectorFromWindow(rows, refIso) {
  const n = rows.length;
  const last = rows[n - 1];

  const tempNow = last?.tC ?? null;
  const humNow  = last?.hPct ?? null;
  const dpNow   = (tempNow != null && humNow != null) ? dewpointC(tempNow, humNow) : null;
  const tdSpread = (tempNow != null && dpNow != null) ? (tempNow - dpNow) : null;

  function sliceHours(h) {
    if (!n) return [];
    const cutoff = last.t - h*3600*1000;
    let i = n - 1;
    while (i >= 0 && rows[i].t >= cutoff) i--;
    return rows.slice(i + 1);
  }
  function stats(arr, key) {
    if (!arr.length) return { mean:null,min:null,max:null };
    let sum=0,cnt=0,min=Infinity,max=-Infinity;
    for (const r of arr) {
      const v = r[key];
      if (v == null || !isFinite(v)) continue;
      sum += v; cnt++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!cnt) return { mean:null,min:null,max:null };
    return { mean: sum/cnt, min, max };
  }
  function lag(hours, key) {
    if (!n) return null;
    const target = last.t - hours*3600*1000;
    for (let i = n-1; i >= 0; i--) {
      if (rows[i].t <= target) {
        const v = rows[i][key];
        return (v == null || !isFinite(v)) ? null : v;
      }
    }
    return null;
  }

  const w3  = sliceHours(3);
  const w6  = sliceHours(6);
  const w12 = sliceHours(12);

  const t3  = stats(w3,  'tC');
  const h3  = stats(w3,  'hPct');
  const t6  = stats(w6,  'tC');
  const h6  = stats(w6,  'hPct');
  const t12 = stats(w12, 'tC');
  const h12 = stats(w12, 'hPct');

  const tLag1 = lag(1, 'tC');
  const tLag3 = lag(3, 'tC');
  const tLag6 = lag(6, 'tC');
  const hLag1 = lag(1, 'hPct');
  const hLag3 = lag(3, 'hPct');
  const hLag6 = lag(6, 'hPct');

  const hrBins = hourBin4(refIso);

  const feats = {
    temperature: tempNow,
    humidity: humNow,
    dewpoint: dpNow,
    td_spread: tdSpread,

    temp_mean_3h: t3.mean, temp_min_3h: t3.min, temp_max_3h: t3.max,
    hum_mean_3h:  h3.mean, hum_min_3h:  h3.min, hum_max_3h:  h3.max,

    temp_mean_6h: t6.mean, temp_min_6h: t6.min, temp_max_6h: t6.max,
    hum_mean_6h:  h6.mean, hum_min_6h:  h6.min, hum_max_6h:  h6.max,

    temp_mean_12h: t12.mean, temp_min_12h: t12.min, temp_max_12h: t12.max,
    hum_mean_12h:  h12.mean, hum_min_12h:  h12.min, hum_max_12h:  h12.max,

    temp_lag_1h: tLag1, temp_lag_3h: tLag3, temp_lag_6h: tLag6,
    hum_lag_1h: hLag1, hum_lag_3h: hLag3, hum_lag_6h: hLag6,

    hr_bin_0: hrBins[0], hr_bin_1: hrBins[1], hr_bin_2: hrBins[2], hr_bin_3: hrBins[3],
  };

  const rawVec = FEATURE_NAMES.map(name => {
    const v = feats[name];
    const num = Number(v);
    return Number.isFinite(num) ? num : 0; // simple impute
  });

  const vec = applyScaler(rawVec);
  if (vec.length !== 36) {
    console.warn(`[fe] Built ${vec.length} features but expected 36; padding/truncating.`);
    if (vec.length < 36) while (vec.length < 36) vec.push(0);
    else vec.length = 36;
  }
  return vec;
}

// Build batches per sensor
function buildBatches(rawItems, { asForward, horizonH }) {
  const by = new Map();
  for (const doc of rawItems) {
    const tIso = pickTime(doc, CFG.TIME_FIELD);
    const sid  = pickSensor(doc, CFG.SENSOR_FIELD);
    if (!tIso || !sid) continue;
    const { t, h } = extractTempHum(doc);
    if (t == null && h == null) continue;
    const ms = new Date(tIso).getTime();
    if (!isFinite(ms)) continue;
    (by.get(sid) || by.set(sid, []).get(sid)).push({ t: ms, iso: tIso, tC: t, hPct: h });
  }
  for (const arr of by.values()) arr.sort((a,b)=>a.t - b.t);

  const vecs = [];
  const metas = [];

  for (const [sensor, arr] of by.entries()) {
    if (!arr.length) continue;
    const lastIso = arr[arr.length - 1].iso;

    if (!asForward) {
      const vec = buildFeatureVectorFromWindow(arr, lastIso);
      vecs.push(vec);
      metas.push({ sensor, timeIso: lastIso });
      continue;
    }

    const cutoff = arr[arr.length - 1].t - CFG.FORWARD_WINDOW_H*3600*1000;
    const w = arr.filter(r => r.t >= cutoff);
    const fwdIso = new Date(arr[arr.length - 1].t + horizonH*3600*1000).toISOString();

    const src = w.length ? w : arr;
    const vec = buildFeatureVectorFromWindow(src, fwdIso);

    vecs.push(vec);
    metas.push({ sensor, timeIso: fwdIso });
  }

  if (!vecs.length) {
    return { tensor: new ort.Tensor('float32', new Float32Array(0), [0, 36]), metas };
  }
  const data = Float32Array.from(vecs.flat());
  return { tensor: new ort.Tensor('float32', data, [vecs.length, 36]), metas };
}

// ------------------------------------------------------------------
// HTTP server
const app = express();
app.use(morgan('tiny'));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    model: CFG.ONNX_MODEL,
    features: FEATURE_NAMES,
    scaler: !!SCALER,
    wasmPaths: ort.env.wasm.wasmPaths,
    runtime: 'onnxruntime-web (wasm)'
  });
});

app.get('/predict', async (req, res) => {
  try {
    const from = req.query.from ? String(req.query.from) : undefined;
    const to   = req.query.to   ? String(req.query.to)   : undefined;

    const forward  = /^true$/i.test(String(req.query.forward || 'false'));
    const horizonH = Number(req.query.horizonHours || CFG.DEFAULT_FWD_HORIZON_H);

    const items = await fetchTimeSeries({ from, to });
    const { tensor, metas } = buildBatches(items, { asForward: forward, horizonH });

    if (tensor.dims[0] === 0) {
      return res.status(200).json({ forward, horizonHours: horizonH, count: 0, points: [] });
    }

    const inputName = session.inputNames[0]; // e.g., "float_input"
    const feeds = { [inputName]: tensor };
    const out = await session.run(feeds);
    const probs = extractProbs(out);

    const points = metas.map((m, i) => {
      const s = Number(probs[i]);
      return {
        sensorName: m.sensor,
        time: m.timeIso,
        score: Number.isFinite(s) ? s : null
      };
    });

    res.status(200).json({
      forward,
      horizonHours: horizonH,
      featureCount: 36,
      count: points.length,
      points
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || 'Server error' });
  }
});

app.get('/', (_req, res) => {
  res.status(200).type('text').send('Frost LGBM predictor (WASM) – try GET /predict?from=...&to=...');
});

app.listen(CFG.PORT, () => {
  console.log(`[frost-lgbm-wasm] http://0.0.0.0:${CFG.PORT}`);
  console.log(`[frost-lgbm-wasm] ORT wasm dir: ${ORT_WASM_DIR}`);
});
