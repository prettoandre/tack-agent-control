#!/usr/bin/env bash
# End-to-end run against a real runner (see docs/operations.md). Prints every command it runs.
#
# Required env:
#   TAC_E2E_TOKEN_FILE  file holding the runner token (chmod 600, outside the repo)
# Optional env:
#   TAC_E2E_PROJECTS / TAC_E2E_HOSTS  YAML files (default: examples/*.yaml)
#   TAC_E2E_DB          control sqlite path (default: ./tac-e2e.sqlite)
#   TAC_E2E_PROJECT     project to dispatch (default: tac-e2e)
#   TAC_E2E_PLAN        plan path in that repo (default: docs/superpowers/plans/2026-10-15-hello.md)
#   TAC_E2E_TIMEOUT_S   polling budget in seconds (default: 900)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TAC_E2E_TOKEN_FILE:?set TAC_E2E_TOKEN_FILE}"
PROJECTS=${TAC_E2E_PROJECTS:-examples/projects.yaml}
HOSTS=${TAC_E2E_HOSTS:-examples/hosts.yaml}
PROJECT=${TAC_E2E_PROJECT:-tac-e2e}
PLAN=${TAC_E2E_PLAN:-docs/superpowers/plans/2026-10-15-hello.md}
TIMEOUT_S=${TAC_E2E_TIMEOUT_S:-900}
export TAC_URL=http://127.0.0.1:7780

run() { printf '+ %s\n' "$*" >&2; "$@"; }

HOST_OK='"name":"devbox-homelab"[^}]*"state":"ok"'
if curl -fsS "$TAC_URL/api/hosts" >/dev/null 2>&1; then
  echo "+ control already listening on 127.0.0.1:7780, reusing it" >&2
else
  printf '+ start control (TAC_PROJECTS=%s TAC_HOSTS=%s, token from %s)\n' "$PROJECTS" "$HOSTS" "$TAC_E2E_TOKEN_FILE" >&2
  TAC_PROJECTS=$PROJECTS TAC_HOSTS=$HOSTS TAC_TOKEN_DEVBOX_HOMELAB=$(cat "$TAC_E2E_TOKEN_FILE") \
    TAC_ALLOWED_LOGINS=dev TAC_DEV_LOGIN=dev TAC_DB=${TAC_E2E_DB:-./tac-e2e.sqlite} \
    bun packages/control/src/main.ts &
  CONTROL_PID=$!
  trap 'kill "$CONTROL_PID" 2>/dev/null || true' EXIT
fi

printf '+ wait for GET /api/hosts to show devbox-homelab ok\n' >&2
for _ in $(seq 1 60); do
  if curl -fsS "$TAC_URL/api/hosts" 2>/dev/null | grep -Eq "$HOST_OK"; then break; fi
  sleep 2
done
curl -fsS "$TAC_URL/api/hosts" | grep -Eq "$HOST_OK" || { echo "host never became ok" >&2; exit 1; }

RUN=$(run bun packages/cli/src/tac.ts dispatch "$PROJECT" "$PLAN")
echo "run: $RUN  ui: http://127.0.0.1:7780"

LAST=""
DEADLINE=$((SECONDS + TIMEOUT_S))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  LINE=$(bun packages/cli/src/tac.ts show "$RUN" | head -1)
  STATE=$(echo "$LINE" | awk '{print $2}')
  if [ "$STATE" != "$LAST" ]; then echo "$(date +%T) state: $STATE"; LAST=$STATE; fi
  case "$STATE" in
    succeeded) echo "$LINE"; exit 0 ;;
    failed|cancelled) echo "$LINE"; exit 1 ;;
  esac
  sleep 10
done
echo "timed out after ${TIMEOUT_S}s in state $LAST" >&2
exit 1
