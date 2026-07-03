#!/usr/bin/env bash
# build-payload.sh — assemble a self-contained NLM runtime tarball.
#
# Produces:
#   nlm-payload-<version>-darwin-<arch>.tar.gz
#   latest.json
#
# Both files land in the repository root (the caller's cwd when invoked as
# ./scripts/build-payload.sh). They are build artifacts; do not commit them.
#
# Environment:
#   NLM_PAYLOAD_CACHE  Directory for caching the downloaded Node tarball.
#                      Defaults to .payload-cache/ in the repo root.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")"
ARCH="$(uname -m)"

# Node version: current LTS matching the engines floor (>=22.0.0).
NODE_VERSION="22.23.1"
NODE_TARBALL="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

CACHE_DIR="${NLM_PAYLOAD_CACHE:-.payload-cache}"
PAYLOAD_NAME="nlm-payload-${VERSION}-darwin-${ARCH}.tar.gz"
STAGING="$(mktemp -d)"

cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

echo "Building NLM payload v${VERSION} darwin-${ARCH} ..."
echo ""

# --- Download and cache the Node runtime tarball ---
mkdir -p "$CACHE_DIR"
NODE_CACHE="${CACHE_DIR}/${NODE_TARBALL}"
if [[ ! -f "$NODE_CACHE" ]]; then
  echo "Downloading ${NODE_URL} ..."
  curl -fL --progress-bar -o "$NODE_CACHE" "$NODE_URL"
else
  echo "Using cached ${NODE_TARBALL}"
fi

# --- Extract Node into staging ---
echo "Extracting Node runtime ..."
tar -xzf "$NODE_CACHE" -C "$STAGING"
mv "$STAGING/node-v${NODE_VERSION}-darwin-${ARCH}" "$STAGING/node"

# --- Build the app ---
echo "Building dist/ ..."
cd "$REPO_DIR"
npm run build

# --- Stage app with production deps only ---
echo "Staging app/ (npm ci --omit=dev) ..."
mkdir -p "$STAGING/app"
cp -r dist "$STAGING/app/dist"
cp -r migrations "$STAGING/app/migrations"
cp package.json package-lock.json "$STAGING/app/"
cd "$STAGING/app"
npm ci --omit=dev
cd "$REPO_DIR"

# --- Write run.sh ---
cat > "$STAGING/run.sh" <<'RUNSH'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/node/bin/node" "$DIR/app/dist/cli/nlm.js" start "$@"
RUNSH
chmod +x "$STAGING/run.sh"

# --- Optional codesigning (required for payloads bundled inside notarized apps) ---
# Set NLM_PAYLOAD_SIGN_IDENTITY to a Developer ID Application identity to sign
# every Mach-O binary in the payload with hardened runtime + secure timestamp.
if [ -n "${NLM_PAYLOAD_SIGN_IDENTITY:-}" ]; then
  echo "Signing payload binaries ..."
  find "$STAGING" -type f \( -name node -o -name "*.node" -o -name "*.dylib" \) | while read -r bin; do
    if file "$bin" | grep -q "Mach-O"; then
      codesign --force --options runtime --timestamp -s "$NLM_PAYLOAD_SIGN_IDENTITY" "$bin"
    fi
  done
fi

# --- Create tarball ---
echo "Creating ${PAYLOAD_NAME} ..."
tar -czf "$REPO_DIR/$PAYLOAD_NAME" -C "$STAGING" .

# --- Compute sha256 ---
SHA256="$(shasum -a 256 "$REPO_DIR/$PAYLOAD_NAME" | awk '{print $1}')"

# --- Emit latest.json ---
cat > "$REPO_DIR/latest.json" <<JSON
{
  "version": "${VERSION}",
  "darwin-${ARCH}": {
    "url": "https://github.com/pbmagnet4/nlm-memory/releases/download/v${VERSION}/${PAYLOAD_NAME}",
    "sha256": "${SHA256}"
  }
}
JSON

echo ""
echo "Done."
echo "  Payload:  ${PAYLOAD_NAME}"
echo "  SHA256:   ${SHA256}"
echo "  Manifest: latest.json"
