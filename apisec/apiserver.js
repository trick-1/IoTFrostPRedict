// server.js
// Standalone Node.js (Express) API using the official MongoDB driver.
// Node 18+ (tested on Node 20). Loads config from environment (use .env locally).
// NOTE: The sections on HTTP/SSL and middleware were written with the use of  generative AI (OSS-GSS-120B)
//
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();

/* ================================
   Config
=================================== */
const PORT = Number(process.env.PORT || 3000);

// Mongo
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;
const COLLECTION_NAME = process.env.COLLECTION_NAME;

// Auth
// Use one of:
//  - API_KEYS: comma-separated plaintext keys
//  - API_KEY: single plaintext key
//  - API_KEY_HASHES: comma-separated SHA-256 hex digests (if set, we compare against hashes)
const API_KEYS = (process.env.API_KEYS || process.env.API_KEY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const API_KEY_HASHES = (process.env.API_KEY_HASHES || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PROTECT_HEALTH = /^true$/i.test(process.env.PROTECT_HEALTH || "false");

// HTTPS / TLS
const HTTPS_ENABLE = /^true$/i.test(process.env.HTTPS_ENABLE || "false");
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const HTTP_REDIRECT_HTTPS = /^true$/i.test(process.env.HTTP_REDIRECT_HTTPS || "false");

// Trust proxy (so req.secure works with x-forwarded-proto)
// Default to true if redirect is enabled; otherwise off unless explicitly set.
const TRUST_PROXY = /^true$/i.test(
  process.env.TRUST_PROXY || (HTTP_REDIRECT_HTTPS ? "true" : "false")
);

// Basic validation
if (!MONGODB_URI || !DB_NAME || !COLLECTION_NAME) {
  console.error("Missing required env: MONGODB_URI, DB_NAME, COLLECTION_NAME");
  process.exit(1);
}

/* ================================
   Mongo client (cached)
=================================== */
const cached = {
  clientPromise: null,
  client: null,
  db: null,
};

async function getDb() {
  if (cached.db) return cached.db;

  if (!cached.clientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 5,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
      retryWrites: true,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    cached.client = client;
    cached.clientPromise = client.connect();
  }

  const client = await cached.clientPromise;
  cached.db = client.db(DB_NAME);
  return cached.db;
}

/* ================================
   Helpers
=================================== */
function ok(res, body, statusCode = 200) {
  res
    .status(statusCode)
    .set({
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    })
    .send(JSON.stringify(body));
}

function err(res, message, statusCode = 500) {
  ok(res, { error: message }, statusCode);
}

// Constant-time equality
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Extract API key from headers
function extractApiKey(req) {
  const h = req.headers;
  if (h["x-api-key"]) return String(h["x-api-key"]);
  const auth = h["authorization"];
  if (auth && /^ApiKey\s+/i.test(auth)) return auth.replace(/^ApiKey\s+/i, "");
  return null;
}

// API-key auth middleware
function requireApiKey({ protectHealth = false } = {}) {
  const allowlist = new Set(API_KEYS);
  const hashList = new Set(API_KEY_HASHES);
  const useHashes = hashList.size > 0;

  return (req, res, next) => {
    if (!protectHealth && req.path === "/health") return next();

    const provided = extractApiKey(req);
    if (!provided) return err(res, "Missing API key", 401);

    if (useHashes) {
      const digest = crypto.createHash("sha256").update(provided).digest("hex");
      for (const h of hashList) if (safeEqual(digest, h)) return next();
    } else {
      for (const k of allowlist) if (safeEqual(provided, k)) return next();
    }
    return err(res, "Invalid API key", 403);
  };
}

/* ================================
   HTTPS/TLS loader
=================================== */
const TLS = (() => {
  if (!HTTPS_ENABLE) return {};
  const fromPath = (p) => (p ? fs.readFileSync(path.resolve(p)) : undefined);
  const fromB64 = (b64) => (b64 ? Buffer.from(b64, "base64") : undefined);

  const key =
    fromPath(process.env.HTTPS_KEY_PATH) || fromB64(process.env.HTTPS_KEY_B64);
  const cert =
    fromPath(process.env.HTTPS_CERT_PATH) || fromB64(process.env.HTTPS_CERT_B64);
  const ca =
    fromPath(process.env.HTTPS_CA_PATH) || fromB64(process.env.HTTPS_CA_B64);
  const passphrase = process.env.HTTPS_PASSPHRASE || undefined;

  if (!key || !cert) {
    console.error("HTTPS_ENABLE=true but key/cert not provided (via *_PATH or *_B64).");
    process.exit(1);
  }
  return { key, cert, ca, passphrase };
})();

/* ================================
   Global middleware (order matters)
=================================== */
// Respect reverse proxies (so req.secure works with x-forwarded-proto)
if (TRUST_PROXY) app.enable("trust proxy");

// Optional HTTP → HTTPS redirect (runs before auth)
if (HTTP_REDIRECT_HTTPS && HTTPS_ENABLE) {
  app.use((req, res, next) => {
    const isSecure =
      req.secure ||
      req.headers["x-forwarded-proto"] === "https" ||
      (req.socket && req.socket.encrypted);
    if (isSecure) return next();

    const host = req.headers.host || "";
    const bareHost = host.split(":")[0];
    const url = new URL(req.originalUrl || req.url, `https://${bareHost}`);
    url.port = String(HTTPS_PORT);
    return res.redirect(301, url.toString());
  });
}

// API-key protection (health can be open unless PROTECT_HEALTH=true)
app.use(requireApiKey({ protectHealth: PROTECT_HEALTH }));

/* ================================
   Data helpers
=================================== */

/** Latest doc overall, sorted by a field (string field name). */
async function fetchLatest(sortField = "time") {
  const db = await getDb();
  const coll = db.collection(COLLECTION_NAME);
  const docs = await coll.find({}).sort({ [sortField]: -1 }).limit(1).toArray();
  return docs[0] ?? null;
}

/** Latest doc per device.
 * Chooses sensor key by deviceInfo.deviceName → sensorField → sensorId.
 * Ensures __sortTime is a Date by converting either numeric ts or string timeField via $toDate.
 */
async function fetchLatestAllPerDevice({ sensorField = "sensorId", timeField = "time" } = {}) {
  const db = await getDb();
  const coll = db.collection(COLLECTION_NAME);

  const pipeline = [
    {
      $addFields: {
        __sortTime: {
          $toDate: {
            $ifNull: ["$ts", `$${timeField}`] // numeric millis or ISO string
          }
        },
        __sensorKey: {
          $ifNull: ["$deviceInfo.deviceName", { $ifNull: [`$${sensorField}`, "$sensorId"] }],
        },
      },
    },
    { $sort: { __sortTime: -1 } },
    { $group: { _id: "$__sensorKey", doc: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$doc" } },
    { $project: { __sortTime: 0, __sensorKey: 0 } },
  ];

  const items = await coll.aggregate(pipeline, { allowDiskUse: true }).toArray();
  return { sensorField: "deviceInfo.deviceName", timeField, items };
}

/** Time-series over a range: returns raw docs (consumer normalizes).
 * from/to: Date | null
 * order: 1 asc, -1 desc
 * limit: max docs (0 for unlimited; still bounded by TIMESERIES_LIMIT_MAX)
 */
async function fetchTimeSeries({
  sensorField = "sensorId",
  timeField = "time",
  from = null, // Date | null
  to = null,   // Date | null
  order = 1,   // 1 asc, -1 desc
  limit = 0    // 0 = no limit
} = {}) {
  const db = await getDb();
  const coll = db.collection(COLLECTION_NAME);

  const timeMatch = {};
  if (from) timeMatch.$gte = from;
  if (to)   timeMatch.$lte = to;

  const pipeline = [
    {
      $addFields: {
        __sortTime: {
          $toDate: {
            $ifNull: ["$ts", `$${timeField}`] // convert numeric ms or ISO string to Date
          }
        },
        __sensorKey: {
          $ifNull: ["$deviceInfo.deviceName", { $ifNull: [`$${sensorField}`, "$sensorId"] }],
        },
      },
    },
    ...(Object.keys(timeMatch).length ? [{ $match: { __sortTime: timeMatch } }] : []),
    { $sort: { __sortTime: order } },
    ...(limit && limit > 0 ? [{ $limit: limit }] : []),
    { $project: { __sortTime: 0 } }
  ];

  const items = await coll.aggregate(pipeline, { allowDiskUse: true }).toArray();
  return { sensorField, timeField, items };
}

/* ================================
   Routes
=================================== */

// Health
app.get("/health", async (req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    ok(res, { ok: true, runtime: "nodejs", now: new Date().toISOString() });
  } catch (e) {
    err(res, `DB ping failed: ${e.message}`, 500);
  }
});

// Latest overall
app.get("/sensors/latest", async (req, res) => {
  try {
    const sortField = (req.query.sortField || "time").toString();
    const latest = await fetchLatest(sortField);
    ok(res, { sortField, latest });
  } catch (e) {
    console.error(e);
    err(res, e.message ?? "Server error");
  }
});

// Latest per device
app.get("/sensors/latest-all", async (req, res) => {
  try {
    const sensorField = (req.query.sensorField || "sensorId").toString();
    const timeField = (req.query.timeField || "time").toString();
    const result = await fetchLatestAllPerDevice({ sensorField, timeField });
    ok(res, result);
  } catch (e) {
    console.error(e);
    err(res, e.message ?? "Server error");
  }
});

/** NEW: Time-series over a range
 * Query params:
 *  - from: ISO datetime (optional)
 *  - to:   ISO datetime (optional)
 *  - sensorField: string (default "sensorId")
 *  - timeField:   string (default "time")
 *  - order: "asc" | "desc" (default "asc")
 *  - limit: integer (optional; server enforces a sane max)
 */
app.get("/sensors/timeseries", async (req, res) => {
  try {
    const sensorField = (req.query.sensorField || "sensorId").toString();
    const timeField   = (req.query.timeField   || "time").toString();

    const orderStr = (req.query.order || "asc").toString().toLowerCase();
    const order = orderStr === "desc" ? -1 : 1;

    const LIMIT_MAX = Number(process.env.TIMESERIES_LIMIT_MAX || 50000);
    const limitRaw = req.query.limit ? Number(req.query.limit) : 0;
    const limit = isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, LIMIT_MAX) : 0;

    let from = null, to = null;
    if (req.query.from) {
      const d = new Date(req.query.from);
      if (Number.isNaN(+d)) return err(res, "Invalid 'from' ISO datetime", 400);
      from = d;
    }
    if (req.query.to) {
      const d = new Date(req.query.to);
      if (Number.isNaN(+d)) return err(res, "Invalid 'to' ISO datetime", 400);
      to = d;
    }

    const result = await fetchTimeSeries({ sensorField, timeField, from, to, order, limit });
    ok(res, result);
  } catch (e) {
    console.error(e);
    err(res, e.message ?? "Server error");
  }
});

// Catch-all 404
app.use((req, res) => err(res, "Not found", 404));

/* ================================
   Start servers
=================================== */
const httpServer = app.listen(PORT, () => {
  console.log(`HTTP listening on http://0.0.0.0:${PORT}`);
  if (HTTP_REDIRECT_HTTPS && HTTPS_ENABLE) {
    console.log(" HTTP requests will be redirected to HTTPS.");
  }
});

let httpsServer = null;
if (HTTPS_ENABLE) {
  httpsServer = https.createServer(
    {
      key: TLS.key,
      cert: TLS.cert,
      ca: TLS.ca,
      passphrase: TLS.passphrase,
      // minVersion: "TLSv1.2",
    },
    app
  );
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`HTTPS listening on https://0.0.0.0:${HTTPS_PORT}`);
  });
}

/* ================================
   Graceful shutdown
=================================== */
async function shutdown(signal) {
  console.log(`\n${signal} received: closing servers...`);
  const closeServer = (srv) =>
    new Promise((resolve) => (srv ? srv.close(resolve) : resolve()));

  await closeServer(httpServer);
  await closeServer(httpsServer);

  try {
    if (cached.client) await cached.client.close();
    console.log("Closed HTTP/HTTPS and MongoDB connections. Bye!");
    process.exit(0);
  } catch (e) {
    console.error("Error during shutdown:", e);
    process.exit(1);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
