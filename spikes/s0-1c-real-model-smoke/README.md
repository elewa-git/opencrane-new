# S0.1c: capped model smoke run

This harness runs Codex **0.159.2 app-server → bridge → local forwarding proxy
→ agentgateway 1.5.0 → Responses upstream**. The qualification upstream is a
local stub. No provider request or credential access is needed for qualification.
All files, dependencies and temporary homes stay inside this folder.

The bridge and proxy were copied/adapted from `spikes/s0-1-codex`; token issuing,
strict JSON parsing, port allocation, gateway policy and binary checksums were
copied/adapted from `spikes/s0-2-gateway`. The bridge copy deliberately has a
small explicit environment instead of inheriting the parent's environment.
See [LICENCES.md](LICENCES.md) for pinned dependency and binary licences.

## What is enforced

The gateway calls the decision service before forwarding either allowed route.
The service checks signed computer and turn tokens, their expiry, issuer,
audience and shared assistant/silo. A model list needs a computer token; if a
turn token is supplied it is also verified. Model generation needs both.
Only POST `/v1/responses` and GET `/v1/models` have routes. Other paths/methods
are refused; a decision-service outage refuses both routes.

The proxy attaches a turn token by Codex's `session-id` header and adds an absent
`max_output_tokens: 2000`. Gateway tests bypass the proxy completely. The gateway
replaces client headers with an allowlist, then injects its own upstream key.
Neither client Authorization nor identity tokens reach the upstream.

| Gateway rule | Assertion in `tests/smoke.test.ts` | Status |
| --- | --- | --- |
| Required positive integer output bound ≤ 2000 | Missing, 2001, float, string, zero, negative, null and boolean refused; both legacy bound fields also checked | PASS ×3 |
| At most six model requests per run | Nine concurrent calls admit exactly six; seventh and later refused; upstream sees six | PASS ×3 |
| No hidden retries | Six upstream 500 replies produce six attempts; next request refused; gateway explicitly uses `attempts: 1` | PASS ×3 |
| Every tools entry must be exactly `function` | Hosted tools, case variants, custom/local_shell/namespace and nested tool arrays refused | PASS ×3 |
| Chosen model only | Wrong model refused | PASS ×3 |
| Both identities verified | Missing, forged, expired, swapped-audience and mismatched tokens refused; valid identity recorded | PASS ×3 |
| No route bypass | Path/method variants refused; both valid routes fail closed on decision outage | PASS ×3 |
| Bounded inline text work | Oversized bodies, history references, media, background runs, premium tiers and `n: 2` refused | PASS ×3 |

Codex web search, shell, image viewing, plugins, apps, hooks and sub-agents are
disabled. Its only file-reading function is a bridge-owned `read_notes` dynamic
tool: no arguments, no path supplied by the model, only this run's `notes.txt`.
This still exercises a real Codex tool round trip and second streamed request.
The config works with the pinned stub model; real model compatibility is NOT_RUN.

## Usage and cents

agentgateway's native Responses handling reads usage from the final streamed
`response.completed`. The gateway log exposes `llmInputTokens`,
`llmOutputTokens`, `llmStreaming` and the decision's reservation ID. The tests
assert final streamed usage of **1000/120** and **1100/121** input/output tokens,
joined to two distinct reservations, each rounded up to **1 cent** at stub rates.
Multiple Codex text deltas and the read-notes result are asserted too.

`src/usage.ts` settles from those gateway observations, never from Codex's own
usage reports. A truncated stream leaves its reservation **PARTIAL**, with no
invented zero usage. Real gateway output goes through an in-memory allowlist
filter before any disk write: raw diagnostics, headers and bodies are discarded.
Only reservation IDs and whole token counts survive into `usage.jsonl`.

`config/prices.json` holds decimal-string USD prices per million tokens and a
fixed planning rate of **0.95 EUR per USD**. BigInt arithmetic computes:

```
costCents = ceil((inputTokens × inputPrice + outputTokens × outputPrice)
                 × usdToEurRate × 100 / 1,000,000)
```

Cached input is charged at the full input rate. This is conservative within the
chosen price table; it is not an FX quote or a provider invoice reconciliation.
All real prices are intentionally **unconfirmed**: the earlier agent wrote them
from memory. The owner must check the selected row and mark it confirmed before
any real run. Unknown, empty, stub or unconfirmed MODEL values refuse startup.

Expected cost is a few cents for the short text exercise, depending on the model.
For an **illustration using the unconfirmed** 0.40/1.60 USD-per-million row, two
requests of 50,000 input and 2,000 output tokens each round to 6 cents total.
At the 1 MiB request-body ceiling, the six-request reservation estimate is
246 cents at that row's rates. Request bytes are used as a conservative estimate
of inline text tokens; this is not proof of the provider's exact tokenisation or
billing. A restarted launcher creates a new six-request allowance. The script
never restarts itself or retries the gateway. A provider-side account limit is
outside this local test.

## Exact operator order

1. In this folder, use Node 22. On a fresh install run `npm ci`, then
   `bash scripts/fetch-tools.sh`. The fetch script checks pinned SHA-256 values;
   it does not need a provider key. macOS arm64 is tested; Linux amd64 is NOT_RUN.
2. Run `bash scripts/run-stub.sh`. It typechecks and runs the complete Vitest
   suite **three times**, each test with a fresh issuer, decision counter,
   ports, gateway, stub and Codex home. Test directories are removed and child
   termination is asserted. No Docker, cloud or real model is used.
3. Run `bash scripts/list-models.sh` to exercise GET `/v1/models` through a
   fresh stub gateway. It prints the stub catalogue. With an already authorised
   gateway running, `bash scripts/list-models.sh http://127.0.0.1:PORT/` uses its
   **forwarding proxy** URL and GETs its real catalogue through ext_authz. This
   helper never reads a credential or starts a real upstream on its own.
4. The owner selects the real MODEL, verifies that row's prices and the rate,
   and explicitly approves the orchestrator's one real smoke run. Set MODEL in
   the environment; `config/model.env` is only a reference and is never sourced.
5. **Orchestrator only:** `MODEL=<confirmed-model-id> bash scripts/run-real.sh`.
   This command was **not executed** during implementation. It validates the
   model/price and gateway checksum, starts local services and a log filter,
   starts the gateway with the credential expanded **only inside its exec
   command**, and waits for readiness. It first GETs `/v1/models` through the
   proxy/gateway and refuses a missing chosen model, then runs one short Codex
   turn using `read_notes`. Only locally constructed counters and usage print.
6. The launcher stops its runner, Codex, gateway and logger, then invokes
   `scripts/leak-check.sh` with the comparison pattern on fd 3. **Do not run
   leak-check separately without the orchestrator's approval.** It scans this
   whole folder (including all run logs and Codex homes),
   `/private/tmp/claude-501`, and the owner's `.codex/shell_snapshots`. It prints
   only `CLEAN` or `LEAK: <path>`; scan failures return failure rather than CLEAN.
   The key's filesystem path appears only in `run-real.sh`.
7. Inspect the small `.state/real-*/settlement.json` result and leak status.
   Missing usage is PARTIAL and causes a non-zero exit. Keep the evidence until
   reviewed, then remove that run directory. Do not restart to work around a cap.

## Adversarial review

Read `run-real.sh` and `leak-check.sh` line by line; also reviewed the child
launcher, filter and scanner. Fixed findings:

- Removed inherited environment access from the bridge. The integration test
  asserts the exact environment passed to the real Codex process contains the
  placeholder and excludes a synthetic parent key and stub gateway credential.
  Its complete isolated home is scanned for those values. OS-level `ps`
  environment inspection was blocked by the execution sandbox: that independent
  check is NOT_RUN, not a claimed pass.
- Tightened the old tool allowlist to `function` only, recursively. Disabled
  general shell/image tools so this model cannot request arbitrary filesystem
  reads or inspect another local process's environment. A shared-user local
  harness is not a production OS isolation boundary.
- Corrected `session_id` to the actual pinned Codex `session-id` header.
- Kept the real key out of shell arguments, parent/runner/proxy environments,
  TOML/YAML, result output and raw logs. Child shells use `env -i`; tracing and
  core dumps are disabled. No key variable is retained in the parent. The
  leak scanner receives bytes through fd 3, compares binary files in bounded
  chunks and never prints matches. Internal symlinks are followed once; external
  symlinks are reported as unscanned rather than followed towards a secret.
- Made gateway retry count explicit and tested failing upstream attempts. The
  synchronous reservation counter has no await between checking/incrementing,
  so concurrent requests cannot share the sixth slot. Invalid requests do not
  consume slots; every allowed retry consumes another slot.
- Refused duplicate JSON keys, invalid number grammar, hidden history/media
  work, extra completions and premium/background options. Real/stub generated
  configs are asserted identical apart from the upstream override and label.
- Model and price settings are parsed data, never sourced shell commands. All
  real price rows remain unconfirmed and fail closed. Cleanup handles normal
  exit, startup failure, timeout and INT/TERM; SIGKILL cannot run shell traps.

Real provider behaviour, actual-key leak scanning, live pricing/account access,
and Linux qualification remain **NOT_RUN**. `run-real.sh` and `leak-check.sh`
were read and syntax-checked only. No key was read, no real model was called,
and no commit or push was made. The package plus pinned binaries occupies
roughly 450 MiB; bulky probe data was removed.

## Real run, 1 October 2026

Run once by the orchestrator with the owner's approval ("smoke yes"), `MODEL=gpt-5-nano`.

| Check | Result |
|---|---|
| Turn through local proxy → agentgateway (ext_authz verified both tokens) → OpenAI Responses API, streamed | PASS: turn `completed` |
| Model requests | 2 (cap 6) |
| Tokens, from the gateway's own streamed-usage log, joined to reservation ids | 5,651 in / 312 out, and 5,986 in / 231 out |
| Spend at list price ($0.05 / $0.40 per million) | about $0.0008 in total (below one euro cent) |
| Settlement as charged by our rule (integer cents, rounded up per call) | 1 + 1 = 2 cents |
| Key leak scan over this folder, `/private/tmp/claude-501`, Codex shell snapshots and `~/.claude/projects` | No key found anywhere |

Finding: `leak-scan.mjs` reports items it could not scan (symlinks that leave the scan roots, unreadable files) with the same `LEAK:` prefix as a real match. In this run that was 74 symlinks and 9 unreadable files, and no real match. Report the two separately (for example `FOUND:` and `UNSCANNED:`), with different exit codes, so a real finding cannot be lost in the noise.
