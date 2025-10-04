mkdir -p certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=localhost"
# Then set:
# HTTPS_ENABLE=true
# HTTPS_KEY_PATH=./certs/server.key
# HTTPS_CERT_PATH=./certs/server.crt
