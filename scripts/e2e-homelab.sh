#!/usr/bin/env bash
# End-to-end run against a real runner (see docs/operations.md). Prints every command it runs.
#
# Required env:
#   TAC_E2E_TOKEN_FILE  file holding the runner token (chmod 600, outside the repo)
# Optional env:
#   TAC_E2E_PROJECTS / TAC_E2E_HOSTS  YAML files (default: examples/*.yaml)
#   TAC_E2E_DB          control sqlite path (default: ./tac-e2e.sqlite)
#   TAC_E2E_HOST        host name in the hosts YAML that must be ok (default: devbox-homelab)
#   TAC_E2E_PROJECT     project to dispatch (default: tack-e2e)
#   TAC_E2E_PLAN        plan path in that repo (default: docs/superpowers/plans/2026-10-15-hello.md)
#   TAC_E2E_TIMEOUT_S   polling budget in seconds (default: 900)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TAC_E2E_TOKEN_FILE:?set TAC_E2E_TOKEN_FILE}"
PROJECTS=${TAC_E2E_PROJECTS:-examples/projects.yaml}
HOSTS=${TAC_E2E_HOSTS:-examples/hosts.yaml}
HOST=${TAC_E2E_HOST:-devbox-homelab}
PROJECT=${TAC_E2E_PROJECT:-tack-e2e}
PLAN=${TAC_E2E_PLAN:-docs/superpowers/plans/2026-10-15-hello.md}
TIMEOUT_S=${TAC_E2E_TIMEOUT_S:-900}
export TAC_URL=http://127.0.0.1:7780

run() { printf '+ %s\n' "$*" >&2; "$@"; }

# control reads the token of host <name> from TAC_TOKEN_<NAME>, upper case with - as _
TOKEN_VAR=TAC_TOKEN_$(printf '%s' "$HOST" | tr 'a-z-' 'A-Z_')
HOST_OK="\"name\":\"$HOST\"[^}]*\"state\":\"ok\""
# command output is captured before matching: a pipe into grep -q or head under pipefail can fail on SIGPIPE
hosts_json() { curl -fsS "$TAC_URL/api/hosts" 2>/dev/null || true; }

if [ -n "$(hosts_json)" ]; then
  echo "+ control already listening on 127.0.0.1:7780, reusing it" >&2
else
  printf '+ start control (TAC_PROJECTS=%s TAC_HOSTS=%s, token from %s)\n' "$PROJECTS" "$HOSTS" "$TAC_E2E_TOKEN_FILE" >&2
  env TAC_PROJECTS="$PROJECTS" TAC_HOSTS="$HOSTS" "$TOKEN_VAR=$(cat "$TAC_E2E_TOKEN_FILE")" \
    TAC_ALLOWED_LOGINS=dev TAC_DEV_LOGIN=dev TAC_DB="${TAC_E2E_DB:-./tac-e2e.sqlite}" \
    bun packages/control/src/main.ts &
  CONTROL_PID=$!
  trap 'kill "$CONTROL_PID" 2>/dev/null || true' EXIT
fi

printf '+ wait for GET /api/hosts to show %s ok\n' "$HOST" >&2
OK=""
for _ in $(seq 1 60); do
  if [[ "$(hosts_json)" =~ $HOST_OK ]]; then OK=1; break; fi
  sleep 2
done
[ -n "$OK" ] || { echo "host $HOST never became ok" >&2; exit 1; }

RUN=$(run bun packages/cli/src/tac.ts dispatch "$PROJECT" "$PLAN")
echo "run: $RUN  ui: http://127.0.0.1:7780"

printf '+ every 10 s, for up to %ss: bun packages/cli/src/tac.ts show %s\n' "$TIMEOUT_S" "$RUN" >&2
LAST=""
DEADLINE=$((SECONDS + TIMEOUT_S))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  SHOW=$(bun packages/cli/src/tac.ts show "$RUN")
  LINE=${SHOW%%$'\n'*}
  read -r _ STATE _ <<<"$LINE"
  if [ "$STATE" != "$LAST" ]; then echo "$(date +%T) state: $STATE"; LAST=$STATE; fi
  case "$STATE" in
    succeeded) echo "$LINE"; exit 0 ;;
    failed|cancelled) echo "$LINE"; exit 1 ;;
  esac
  sleep 10
done
echo "timed out after ${TIMEOUT_S}s in state $LAST" >&2
exit 1
