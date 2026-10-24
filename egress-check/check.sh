#!/usr/bin/env bash
# Builds the egress check image and runs it. Results land in egress-check/out/.
# Usage: egress-check/check.sh [idle-seconds]   (default 360)
set -euo pipefail
cd "$(dirname "$0")"

export EGRESS_IDLE_SECONDS="${1:-360}"
docker compose build
status=0
docker compose run --rm t3 || status=$?
docker compose down --remove-orphans >/dev/null 2>&1 || true
exit "$status"
