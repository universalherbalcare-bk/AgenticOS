#!/usr/bin/env bash
# Executes docs/deletions.tsv against planes/. Fails closed: a manifest entry
# whose path does not exist is an ERROR (the ledger is wrong), never a silent skip.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
missing=0; deleted=0; bytes=0
: > docs/deletion-receipt.tsv
while IFS=$'\t' read -r plane path category justification; do
  [[ "$plane" == \#* || -z "${plane:-}" ]] && continue
  full="$ROOT/planes/$plane/$path"
  if [[ ! -e "$full" ]]; then
    echo "ERROR missing-from-tree: $plane/$path" >&2
    missing=$((missing+1)); continue
  fi
  sz=$(du -sk "$full" | cut -f1)
  n=$(find "$full" -type f | wc -l | tr -d ' ')
  rm -rf "$full"
  printf '%s\t%s\t%s\t%s KB\t%s files\n' "$plane" "$path" "$category" "$sz" "$n" >> docs/deletion-receipt.tsv
  deleted=$((deleted+1)); bytes=$((bytes+sz))
done < docs/deletions.tsv
echo "deleted=$deleted missing=$missing freed=${bytes}KB"
[[ $missing -eq 0 ]] || { echo "FAIL: $missing manifest entries did not exist — ledger is wrong" >&2; exit 1; }
