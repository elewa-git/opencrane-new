# Models and silo spending

Phase 2, issue #29. The decision process verifies the lifecycle computer and
thread-bound turn tokens; agentgateway v1.5.0 enforces its answer and sends
Responses requests to OpenAI. Reuses S0.2's ext_authz/header allowlist and
S0.1c's native streamed usage fields and checksum-verified binary fetcher.
No extra proxy sees the provider key. `backendAuth.key.file` reads
`.keys/.openai-key` inside agentgateway, never the server or computer.

- `BudgetActor` loads the NATS budget stream and serialises reserve/settle
  commands. Each command does one conditional append. The process entrypoint
  uses the existing PostgreSQL session lease adapter to elect one actor;
  an append on acquisition fences the previous writer. Unknown append outcomes
  stop the actor. SQL holds no budget rules or authoritative state.
- Defaults are **2,000 cents/day and 20,000 cents/month**, UTC. Pending
  reservations count against both periods until settled, including after
  midnight or a restart. Completed calls belong to their reservation date.
- Owner decision, 2 October 2026: allow all eleven requested models and keep
  optimising; choosing the right tool matters more than cost. The registry in
  `src/state.ts` is the only price data: Astra, 6.1 Sol, 6 Luna, 6 Sol,
  5.6 Sol/Terra/Luna, 5.5/5.5 Pro and 5.4/5.4 Pro. `gpt-5-nano` and
  `gpt-5-mini` are retired and refused for new calls. Their original price rows
  remain available to settle pending reservations at the recorded tariff.
  Standard rates are pinned from
  [OpenAI pricing](https://developers.openai.com/api/docs/pricing), checked
  2 October 2026, at the existing planning FX of EUR 95/100 USD. Prices are
  integer euro cents per billion tokens, preserving fractional USD-cent rates.
  BigInt arithmetic rounds the combined charge upwards once per call.
  Short context is **at most 272,000 input tokens**; above that, the whole
  request uses long-context input, cache and output rates. Settlement uses
  total input to choose the tier, then charges reported cached input and cache
  writes at their separate rates. Unsupported cache usage fails closed.
  This is a planning tariff, not invoice reconciliation or live FX conversion.
- `src/routing.ts` holds the task table and one selection function, following
  [OpenAI model guidance](https://developers.openai.com/api/docs/guides/model-selection).
  Chat turns use **gpt-6.1-sol**. Ambiguous problems, deep analysis and ambitious
  deliverables use **gpt-6-astra**. Scoped tasks, triage, frequent automations,
  conversation titles, upload classification and summaries use **gpt-6-luna**.
  The bridge accepts an explicit task kind (default `chat_turn`) and selects
  the model on every turn, including resumed threads. It never guesses task
  difficulty from message text. Refine the rows using measured success, latency
  and spend; there is no learned router. Automation execution is still future work.
- Reservations cover the full supported **1,050,000-token** context plus the
  supplied output limit at long rates, using the greater input/cache-write rate.
  `reservationCents` accepts a proven input bound for future trusted server-side
  tokenisation; no caller-supplied token count is trusted today. This can refuse
  an expensive model under the unchanged daily cap even for a tiny request.
  Only inline text and local function calls are accepted. Media, hosted tools,
  stored history, background requests, multiple completions and premium tiers
  fail closed. The caller supplies `stream: true` and `max_output_tokens` from
  16 (the [API minimum](https://developers.openai.com/api/reference/java/resources/beta/subresources/responses/methods/create))
  to 2,000. The gateway fixes the service tier to standard pricing.
- IAM uses current requester ∩ assistant resource grants in live OpenFGA.
  The claimed computer generation, ready state, conversation and active turn
  are read from events on every call. JWTs are ES256, with strict expiry;
  turn claims include `thread` matching the actual Codex `session-id`, signed `conversation`, `requester`, `task` and allowed `model` and the current
  `computerTokenId`, with at most 120 seconds between `iat` and `exp`.
  The server chooses the allowed model from the task-routing table; admission
  refuses a different request model before reserving or reaching the provider.
  Both use `libs/auth` and the configured `TOKEN_ISSUER`; the gateway verifies
  the same public keys. Computer tokens include the claim generation, and
  only a matching Ready event permits model admission. Delegation
  currently contains only the requester; multi-hop delegation is deferred.
- Only reservation ids, token counts and a fixed error outcome survive the gateway log filter.
  Observations are appended as `effect.observed`; the existing handler runtime
  delivers `settle-budget` to the decision process. Its settlement endpoint
  accepts an event reference and rereads the recorded effect, never a supplied
  amount. A duplicate effect cannot charge twice. Observed provider rejections
  without usage settle at zero cents. Timeouts, lost connections and other
  missing outcomes produce `effect.uncertain` after three minutes and retain
  the full reservation. Unknown models or tariffs produce `effect.uncertain`
  with reason `unknown_tariff`, keep the reservation and allow later usage
  lines to be processed. Cap refusals append `budget.exhausted` and a separate admission decision, once per
  unchanged budget per UTC day for exhaustion, including across actor recovery. All decisions use `decision.recorded` with a digest of the
  verified context when available; gateway JWT failures occur before ext_authz.
- `budgets` is a PostgreSQL projection using the existing runner. Rebuild it
  with `ProjectionRunner.rebuild(budgets)` while reactions are stopped.
  `GET /api/org/models` uses live owner/admin authorisation and returns models, prices, the task-routing table and context threshold,
  today's/month's settled cents, outstanding reserved cents and both ceilings.

The prototype stores reservation history in one JSON projection row and rereads
small entity histories. Large histories need compaction/indexing later; the event
stream remains the source of truth. Manual resolution of uncertain effects and
price administration are Phase 3 work; uncertainty never automatically refunds.

## Run and test

`apps/server/src/models-main.ts` is the supervised process entrypoint; the dev
stack supplies its NATS command credentials, projection database, silo/OpenFGA
binding, lifecycle public JWKS file, `TOKEN_ISSUER`, state directory and three ports.
`MODEL_UPSTREAM` and `MODEL_KEY_FILE` select the dev-stack stub; the default
production upstream remains OpenAI. Dev-stack startup always selects the stub. Only the public JWKS
is read by this process. The issuer's private signing key stays with the issuer.
`apps/ops/src/worker.ts budgets` runs the projection; the dispatcher enables
settlement when `MODEL_DECISION_URL` is set. An existing dispatcher needs a
controlled subscription rebuild before enabling the new handler.

```sh
bash spikes/s0-1c-real-model-smoke/scripts/fetch-tools.sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run libs/models/test/gateway.test.ts
```

Fixtures use real NATS, PostgreSQL 17, OpenFGA, agentgateway and a scripted SSE
provider, each with disposable state. The real-call test is disabled normally;
`MODELS_REAL_CALL=1` explicitly enables exactly one call each to Luna, 6.1 Sol and Astra with
`Say OK.`, 16 output tokens and low reasoning (select that test alone).
Never rerun it as a normal gate. [Evidence](../../docs/process/models-evidence.md)
records the authorised call and test qualification.

Licences: agentgateway v1.5.0 Apache-2.0, jose 6.2.12 MIT, zod 4.6.5 MIT;
all other runtime code reuses existing OSI-approved workspace packages. No new
third-party dependency version was introduced. The binary SHA-256 is verified
before every launch; the k3d relay image is pinned by OCI digest too.

P2-3 also verifies the native Codex text request shape through the real gateway:
nullable message ids, input/output text, reasoning summaries, local function
selection, parallel calls and cache/client metadata. Native Sol text turns also
carry strictly checked tool declarations (including namespaces and Lark custom
tools), `all_turns` reasoning context and text verbosity. These fields do not relax
the output limit or admit media, hosted tools or stored-history references.

## Per-tool policy (P3-1)

`readToolPolicy` folds the installed server stream; `setToolPolicy` checks live
Owner/Admin plus current event membership and performs one conditional append.
Discovery hints suggest choices, never grant access. Modes bind `connectionId`
and `toolRevision`; changed discovery resets to Block. The existing catalogue
projection replays the same fold. Org settings links each register row to its
Tools & access screen, using the authenticated GET/POST
`/api/org/integrations/:serverId/tools` interface with Origin checks on writes.

`startGateway({ ..., mcpRoutes: [{ serverId, connectionId, upstream }] })` adds a
fixed, operator-reviewed fixture route `/mcp/:serverId/:connectionId`. This is
not an installer or arbitrary remote-URL interface. ext_authz accepts only bounded
MCP `tools/call` for 2026-07-28 with matching method/tool/version headers and
required `_meta` version and empty client capabilities. The route strips caller
headers and never injects an invented credential. Only explicitly credential-free,
non-metered reviewed fixtures can run until the credential/budget tickets land.
Ask records `approval_required` without dispatch; approval creation/consumption
belongs to P3-2. Lossless approval argument binding belongs there too.

Model and MCP admission share `currentAuthority`: current member/role, team
membership, assistant activity, conversation, explicit requester and assistant
resource grants, lifecycle tokens and delegation. OpenFGA is queried at higher
consistency on every call. Relevant event receipts must exist before a projection
can authorise; lag denies. A two-second freshness budget starts when the decision
request arrives. Cheap authority-category head reads fence the snapshot before
reservation (inside the budget queue) and again after the audit, before admission.
Any change or expired budget denies. Category heads conservatively refuse
unrelated IAM changes too; budget and audit traffic do not invalidate them. Memory scopes are empty. Personal work retains the
installation's paying group; team turns require an explicit paying-group binding; there is no fabricated credential/profile.
The simple event-head scan has linear history cost; replace it with a fenced IAM
projection before high-volume operation. Egress can reuse this resource check.
Each allow/ask/deny appends `decision.recorded` before forwarding; append failure
denies. A decision is admission, not proof of an observed effect.

`seed-model-grants` reacts to `member.joined` and `assistant.created`, appending
one `grant.given` per active model and grantee. Each command does one conditional
append; conflicts fail for ordered retry. Existing grant history, including a
revocation, takes precedence. Duplicate delivery cannot restore revoked access.
OpenFGA only projects these events; rebuild never manufactures grants.

Existing silos must run the [upgrade command](../../apps/ops/README.md#model-grant-upgrade)
before rebuilding OpenFGA with the updated model and enabling decisions.
The dev-stack startup hook belongs to the separate dev-stack change; no shared
stack files or processes were changed here.
