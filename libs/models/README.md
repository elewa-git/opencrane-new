# Models and silo spending

Phase 2, issue #29. The decision process verifies the lifecycle computer and
per-conversation turn tokens; agentgateway v1.5.0 enforces its answer and sends
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
- The pinned registry allows `gpt-5-nano` (default) and `gpt-5-mini`.
  Standard input/output prices come from the official
  [nano](https://developers.openai.com/api/docs/models/gpt-5-nano) and
  [mini](https://developers.openai.com/api/docs/models/gpt-5-mini) pages,
  checked 2 October 2026. The S0.1c planning FX of 95/100 EUR/USD is fixed.
  Prices are integer cents per 100 million tokens: 475/3800 and 2375/19000.
  BigInt arithmetic rounds the combined cost upwards once per call. Cached
  input uses the full input price. This is the silo's accounting tariff,
  not a live FX quote or invoice reconciliation.
- Reservations cover the entire 400,000-token context plus at most 2,000
  output tokens: normally 2 cents for nano, 10 for mini. Only inline text and
  local function calls are accepted. Media, hosted tools, references to stored
  history, background requests, multiple completions and premium tiers fail
  closed. The caller must supply `max_output_tokens` and `stream: true`.
- IAM is Phase 2 personal-assistant ownership ∩ live OpenFGA membership.
  The claimed computer generation, ready state, conversation and active turn
  are read from events on every call. JWTs are ES256, with strict expiry;
  turn claims include `conversation` matching `session-id` and the current
  `computerTokenId`, with at most 120 seconds between `iat` and `exp`.
  Both use `libs/auth` and the configured `TOKEN_ISSUER`; the gateway verifies
  the same public keys. Computer tokens include the claim generation, and
  only a matching Ready event permits model admission. Delegation
  currently contains only the requester; group/delegated grants are deferred.
- Only reservation ids, token counts and a fixed error outcome survive the gateway log filter.
  Observations are appended as `effect.observed`; the existing handler runtime
  delivers `settle-budget` to the decision process. Its settlement endpoint
  accepts an event reference and rereads the recorded effect, never a supplied
  amount. A duplicate effect cannot charge twice. Observed provider rejections
  without usage settle at zero cents. Timeouts, lost connections and other
  missing outcomes produce `effect.uncertain` after three minutes and retain
  the full reservation. Cap refusals append only `budget.exhausted`, once per
  unchanged budget per UTC day, including across actor recovery. Other refusals
  before a budget command become `security.alert_raised` with a digest of the
  verified context when available; gateway JWT failures occur before ext_authz.
- `budgets` is a PostgreSQL projection using the existing runner. Rebuild it
  with `ProjectionRunner.rebuild(budgets)` while reactions are stopped.
  `GET /api/org/models` uses live owner/admin authorisation and returns models,
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
`MODELS_REAL_CALL=1` explicitly enables a single call (select that test alone).
Never rerun it as a normal gate. [Evidence](../../docs/process/models-evidence.md)
records the authorised call and test qualification.

Licences: agentgateway v1.5.0 Apache-2.0, jose 6.2.12 MIT, zod 4.6.5 MIT;
all other runtime code reuses existing OSI-approved workspace packages. No new
third-party dependency version was introduced. The binary SHA-256 is verified
before every launch; the k3d relay image is pinned by OCI digest too.
