#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${HOME}/.local/bin"
ln -sf "${ROOT_DIR}/scripts/relay.mjs" "${HOME}/.local/bin/relay"
