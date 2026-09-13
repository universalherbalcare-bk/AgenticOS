/**
 * Shared `/bin/sh` shim standing in for APEX_AUTHORITY_CMD in kernel-authority tests.
 *
 * Unlike the exec gate's one-shot shim, this one keeps STATE in a directory so a whole
 * approval lifecycle (decide -> approval_required -> resolve -> decide+id -> allow -> finish)
 * can be replayed against it, and it APPENDS every request it receives to `requests.jsonl`
 * so a test can assert the exact sequence of protocol operations, including the `finish`
 * receipt and its outcome.
 *
 * Modes (FAKE_AUTHORITY_MODE):
 *  - allow            decide -> allow (low_risk, no record); finish -> ok
 *  - allow_consumed   decide -> allow (approval_consumed, id=APPROVAL_ID); finish -> ok once
 *  - deny             decide -> deny (tool_disabled)
 *  - approval_flow    full stateful lifecycle (see script); finish -> ok once per consumed id
 *  - garbage          prints non-JSON
 *  - exit2            prints {"ok":false} and exits 2
 *  - hang             sleeps
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHIM_APPROVAL_ID = "e".repeat(64);

export const SHIM_ENV_KEYS = [
  "APEX_AUTHORITY_CMD",
  "APEX_AUTHORITY_DIR",
  "APEX_AUTHORITY_MODE",
  "APEX_AUTHORITY_TIMEOUT_MS",
  "FAKE_AUTHORITY_MODE",
  "FAKE_AUTHORITY_STATE_DIR",
];

const SHIM_SCRIPT = `#!/bin/sh
set -eu
request="$(cat)"
state="\${FAKE_AUTHORITY_STATE_DIR:?}"
printf '%s\\n' "$request" >> "$state/requests.jsonl"
id="${SHIM_APPROVAL_ID}"
op=decide
case "$request" in
  *'"op":"resolve"'*) op=resolve ;;
  *'"op":"finish"'*) op=finish ;;
  *'"op":"pending"'*) op=pending ;;
esac
mode="\${FAKE_AUTHORITY_MODE:-deny}"
if [ "$op" = finish ]; then
  outcome="$(printf '%s' "$request" | sed -n 's/.*"outcome":"\\([a-z]*\\)".*/\\1/p')"
  if [ "$mode" = approval_flow ] || [ "$mode" = allow_consumed ]; then
    if [ -e "$state/consumed" ] && [ ! -e "$state/finished" ]; then
      : > "$state/finished"
      printf '%s\\n' '{"ok":true,"result":{"id":"'"$id"'","status":"consumed","reason":"used_once","outcome":"'"$outcome"'"}}'
      exit 0
    fi
    printf '%s\\n' '{"ok":false,"error":"Only an unresolved consumed action can receive a receipt."}'
    exit 2
  fi
  printf '%s\\n' '{"ok":true,"result":{"id":"'"$id"'","status":"consumed","reason":"used_once","outcome":"'"$outcome"'"}}'
  exit 0
fi
case "$mode" in
  allow)
    printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"low_risk","operation":"tool.execute","resource":"edge","risk":"R1","approval_id":null}}'
    ;;
  allow_consumed)
    : > "$state/consumed"
    printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"approval_consumed","operation":"tool.execute","resource":"edge","risk":"R2","approval_id":"'"$id"'","consumed_at":1700000000000}}'
    ;;
  deny)
    printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"tool_disabled","operation":"tool.execute","resource":"edge","risk":"R2","approval_id":null}}'
    ;;
  approval_flow)
    if [ "$op" = resolve ]; then
      case "$request" in
        *'"approve":true'*)
          : > "$state/approved"
          printf '%s\\n' '{"ok":true,"result":{"id":"'"$id"'","status":"approved","reason":"user_approved"}}'
          ;;
        *)
          : > "$state/revoked"
          printf '%s\\n' '{"ok":true,"result":{"id":"'"$id"'","status":"revoked","reason":"user_revoked"}}'
          ;;
      esac
      exit 0
    fi
    case "$request" in
      *'"approval_id":"'"$id"'"'*)
        if [ -e "$state/consumed" ]; then
          printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"approval_rejected","detail":"A live, unused approved request is required.","record_status":"consumed","approval_id":null}}'
        elif [ -e "$state/revoked" ]; then
          printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"approval_rejected","detail":"A live, unused approved request is required.","record_status":"revoked","approval_id":null}}'
        elif [ -e "$state/approved" ]; then
          : > "$state/consumed"
          printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"approval_consumed","operation":"tool.execute","resource":"edge","risk":"R2","approval_id":"'"$id"'","consumed_at":1700000000000}}'
        else
          printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"approval_rejected","detail":"A live, unused approved request is required.","record_status":"pending","approval_id":null}}'
        fi
        ;;
      *)
        printf '%s\\n' '{"ok":true,"result":{"decision":"approval_required","reason":"approval_required","operation":"tool.execute","resource":"edge","risk":"R2","approval_id":"'"$id"'","expires_at":4102444800000}}'
        ;;
    esac
    ;;
  garbage)
    printf '%s\\n' 'this is not json'
    ;;
  exit2)
    printf '%s\\n' '{"ok":false,"error":"Authority request fields: missing field."}'
    exit 2
    ;;
  hang)
    sleep 30
    ;;
  *)
    exit 2
    ;;
esac
exit 0
`;

export type KernelAuthorityShimFixture = {
  dir: string;
  shim: string;
  stateDir: string;
  requestsFile: string;
  /** Every request the shim received, in order. */
  requests: () => Array<Record<string, unknown>>;
  /** Only the requests for one protocol operation. */
  ops: (op: "decide" | "resolve" | "finish") => Array<Record<string, unknown>>;
  /** Out-of-band operator approval, as the kernel would record it after a human said yes. */
  approveOutOfBand: () => void;
  cleanup: () => void;
};

export function createKernelAuthorityShimFixture(
  prefix = "tool-kernel-authority-shim-",
): KernelAuthorityShimFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const shim = path.join(dir, "apex-authority");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(shim, SHIM_SCRIPT, { mode: 0o755 });
  const requestsFile = path.join(stateDir, "requests.jsonl");
  const requests = () =>
    fs.existsSync(requestsFile)
      ? fs
          .readFileSync(requestsFile, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return {
    dir,
    shim,
    stateDir,
    requestsFile,
    requests,
    ops: (op) => requests().filter((request) => request.op === op),
    approveOutOfBand: () => {
      fs.writeFileSync(path.join(stateDir, "approved"), "");
    },
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
