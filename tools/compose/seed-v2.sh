#!/usr/bin/env bash
# Run the idempotent compose demo seed from any repository working directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

docker compose -f "${COMPOSE_FILE}" run --rm --no-deps seed
