#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -x "${ROOT_DIR}/scripts/relay.mjs" ]]; then
  echo "relay entrypoint must be executable: ${ROOT_DIR}/scripts/relay.mjs" >&2
  exit 1
fi
mkdir -p "${HOME}/.local/bin"
ln -sf "${ROOT_DIR}/scripts/relay.mjs" "${HOME}/.local/bin/relay"
