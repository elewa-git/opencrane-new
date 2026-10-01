#!/usr/bin/env bash
# Three independent invocations of this script are required for a PASS.
set -euo pipefail
cd "$(dirname "$0")/.."
n="${1:?usage: run-all.sh <run label> [all|dev|memory|offline]}"
mode="${2:-all}"
[[ "$n" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
mkdir -p evidence
log="evidence/verified-$n.txt"
{
printf 'Run %s mode=%s started %s\n' "$n" "$mode" "$(date -u +%FT%TZ)"
node --version
# Only this spike's state directory is inspected. Never touch another agent's data.
node --input-type=module -e '
import { existsSync, readdirSync } from "node:fs";
if (existsSync(".state") && readdirSync(".state").length) throw Error("Owned state remains; inspect before running");
'
npm run typecheck
case "$mode" in
  all) npm test ;;
  dev) npm run test:temporal:dev ;;
  memory) npm run test:temporal:memory ;;
  offline) npm run test:offline ;;
  *) exit 2 ;;
esac
node --input-type=module -e '
import { existsSync, readdirSync } from "node:fs";
if (existsSync(".state") && readdirSync(".state").length) throw Error("Owned state was not cleaned up");
console.log("Owned state directories after run: 0");
'
printf 'Completed %s\n' "$(date -u +%FT%TZ)"

} 2>&1 | tee "$log"
