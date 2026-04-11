#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$ROOT_DIR/cli"
SESSION_NAME="lunel-cli-connect-local"
PAIR_LOG="$ROOT_DIR/.sisyphus/logs/cli-connect-local.log"
SUMMARY_JSON="$ROOT_DIR/.sisyphus/logs/cli-connect-local-summary.json"
TIMEOUT_SECONDS="${LUNEL_CONNECT_TIMEOUT_SECONDS:-60}"

mkdir -p "$(dirname "$PAIR_LOG")"
: > "$PAIR_LOG"
rm -f "$SUMMARY_JSON"

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}
trap cleanup EXIT

tmux new-session -d -s "$SESSION_NAME" \
  "bash -lc 'set -euo pipefail; cd \"$CLI_DIR\" && node dist/index.js -n 2>&1 | tee \"$PAIR_LOG\"'"

CODE=""
for _ in $(seq 1 "$TIMEOUT_SECONDS"); do
  CODE=$(PAIR_LOG="$PAIR_LOG" python - <<'PY'
import pathlib, re, os
path = pathlib.Path(os.environ['PAIR_LOG'])
text = path.read_text(errors='ignore') if path.exists() else ''
match = re.search(r'Session code:\s*([A-Za-z0-9]+)', text)
print(match.group(1) if match else '')
PY
)
  if [[ -n "$CODE" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$CODE" ]]; then
  printf 'No session code found in %s\n' "$PAIR_LOG" >&2
  exit 1
fi

cd "$ROOT_DIR"
GATEWAY_HINT=$(PAIR_LOG="$PAIR_LOG" python - <<'PY'
import pathlib, re, os
path = pathlib.Path(os.environ['PAIR_LOG'])
text = path.read_text(errors='ignore') if path.exists() else ''
match = re.search(r'Connecting to gateway\s+(https://[^\.\s]+\.lunel\.dev)', text)
print(match.group(1) if match else '')
PY
)

if [[ -n "$GATEWAY_HINT" ]]; then
  node test-scripts/connect-to-cli-session.mjs "$CODE" "$GATEWAY_HINT" > "$SUMMARY_JSON"
else
  node test-scripts/connect-to-cli-session.mjs "$CODE" > "$SUMMARY_JSON"
fi

if ! PAIR_LOG="$PAIR_LOG" python - <<'PY'
import pathlib, os
path = pathlib.Path(os.environ['PAIR_LOG'])
text = path.read_text(errors='ignore') if path.exists() else ''
raise SystemExit(0 if 'App connected!' in text else 1)
PY
then
  printf 'CLI never reported App connected in %s\n' "$PAIR_LOG" >&2
  exit 1
fi

printf 'Session code: %s\n' "$CODE"
printf 'CLI log: %s\n' "$PAIR_LOG"
printf 'Summary: %s\n' "$SUMMARY_JSON"
