// Usage:
//   node genkey.js            # prints a base64url key (recommended)
//   node genkey.js hex        # prints a hex key
//   node genkey.js hash <key> # prints SHA-256 hash of an existing key (hex)

const crypto = require("crypto");

const mode = process.argv[2];

if (!mode) {
  // default: generate base64url key (32 bytes ~ 256-bit)
  const key = crypto.randomBytes(32).toString("base64url");
  console.log("API key (base64url):", key);
  console.log("\n.env example:");
  console.log(`API_KEYS=${key}`);
  process.exit(0);
}

if (mode === "hex") {
  const key = crypto.randomBytes(32).toString("hex");
  console.log("API key (hex):", key);
  console.log("\n.env example:");
  console.log(`API_KEYS=${key}`);
  process.exit(0);
}

if (mode === "hash") {
  const raw = process.argv[3];
  if (!raw) {
    console.error("Usage: node genkey.js hash <key>");
    process.exit(1);
  }
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  console.log("SHA-256(key):", digest);
  console.log("\nStore hashed keys like so (preferred if you can't store plaintext):");
  console.log(`API_KEY_HASHES=${digest}`);
  console.log("Then clients send the *raw* key in x-api-key.");
  process.exit(0);
}

console.error("Unknown mode. Use: (no args) | hex | hash <key>");
process.exit(1);
