#!/usr/bin/env bash
#
# Regenerates shared/types/api.ts from the backend's OpenAPI schema.
#
#   ./shared/generate-api-types.sh
#
# Reads the schema by importing the FastAPI app and calling app.openapi() — no
# server needed. Requires the backend's Python deps (pip install -r
# requirements.txt) and network access for npx.
#
# AUTH_JWT_SECRET only has to be present, not real: settings validate its length
# at import time. Set PYTHON=... to point at a virtualenv interpreter.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/shared/types/api.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"

AUTH_JWT_SECRET="${AUTH_JWT_SECRET:-generate-api-types-placeholder-secret}" \
  "${PYTHON:-python3}" -c \
  'import json, sys; from app import app; json.dump(app.openapi(), sys.stdout, indent=2)' \
  > "$TMP/openapi.json"

# --registry pins the public registry: a contributor whose npm points at a private
# one gets a 401 here otherwise, and that is what baked a private registry into
# the frontend lockfiles and broke CI once already.
npx --yes --registry=https://registry.npmjs.org/ openapi-typescript@7.13.0 "$TMP/openapi.json" -o "$TMP/api.ts"

{
  echo "// Regenerate with ./shared/generate-api-types.sh — do not edit by hand."
  cat "$TMP/api.ts"
} > "$OUT"

echo "wrote $OUT"
