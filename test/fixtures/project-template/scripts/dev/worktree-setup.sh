#!/usr/bin/env bash
set -euo pipefail

mkdir -p src
if [[ "${FAKE_SETUP_FAIL:-0}" == "1" ]]; then
  echo "setup failed" >&2
  exit 1
fi

if [[ ! -f src/index.ts ]]; then
  printf 'export const fixture = true;\n' > src/index.ts
fi
