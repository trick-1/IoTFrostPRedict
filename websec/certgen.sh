#!/usr/bin/env bash
set -euo pipefail

# === Config (edit as needed) ===
DOMAIN="${1:-localhost}"      # first arg or default
ALT_IPS=("127.0.0.1" "::1")   # add/remove as you like
DAYS="${DAYS:-825}"           # Chrome max for self-signed
OUTDIR="${OUTDIR:-./certs}"

mkdir -p "$OUTDIR"

# Build subjectAltName list (DNS + IPs)
SAN="DNS:${DOMAIN},DNS:localhost"
for ip in "${ALT_IPS[@]}"; do SAN+=",IP:${ip}"; done

# Create a minimal OpenSSL config on the fly (so SANs work)
CNF="$(mktemp)"
trap 'rm -f "$CNF"' EXIT
cat > "$CNF" <<EOF
[req]
default_bits       = 2048
distinguished_name = dn
x509_extensions    = v3_req
req_extensions     = v3_req
prompt             = no

[dn]
CN = ${DOMAIN}
O  = Dev Local
C  = AU

[v3_req]
keyUsage         = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = ${SAN}
EOF

# Generate key + self-signed cert
openssl req -x509 -nodes -newkey rsa:2048 \
  -days "${DAYS}" \
  -keyout "${OUTDIR}/server.key" \
  -out    "${OUTDIR}/server.crt" \
  -config "${CNF}"

echo "✔ Generated:"
echo "   ${OUTDIR}/server.key"
echo "   ${OUTDIR}/server.crt"
echo
echo "Use with:"
echo "  SSL_KEY_PATH='${OUTDIR}/server.key' SSL_CERT_PATH='${OUTDIR}/server.crt' node webserver.js"
