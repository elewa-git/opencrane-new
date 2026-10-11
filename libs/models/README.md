# Models

## What this is

The AI access and spending library for OpenCrane. Its running part is the models process, a separate program whose start file lives in `apps/server` (`src/models-main.ts`). It runs beside [agentgateway](../../GLOSSARY.md#agentgateway-ai-gateway), which forwards AI requests. The library also picks the model for each task, keeps the price list and [budgets](../../GLOSSARY.md#budget), holds the [tool rules](../../GLOSSARY.md#tool-rule-allow-ask-block) and the one-time approvals for Ask tools, and records who owns the silo.

## Where it fits

This shared library is used by the server, background workers and personal computers. It checks passes with `libs/auth`, permissions with `libs/authz`, and starts agentgateway to handle AI calls.

```mermaid
flowchart LR
  server["apps/server<br/>back end and models process"] -.->|checks reads, calls, approval changes, child joins, owner appointments and spending| models["libs/models<br/>AI rules and spending"]
  ops["apps/ops<br/>background workers"] -.->|confirms owner appointments| models
  server["apps/server<br/>back end and models process"] -.->|checks reads, calls, approval changes, provider choices and spending| models["libs/models<br/>AI rules and provider choice"]
  server["apps/server<br/>back end and models process"] -.->|checks reads, calls, approval changes, provider choices and spending revisions| models["libs/models<br/>AI rules, provider choice and spending"]
  ops["apps/ops<br/>background workers"] -.-> models
  computer["apps/computer<br/>personal computers"] -.->|chooses chat models; native child calls refused| models
  models -.-> auth["libs/auth<br/>access passes"]
  models -.-> authz["libs/authz<br/>permission checks"]
  models <-->|checks saved grants, tool rules, calls and read and personal write passes| gateway["agentgateway<br/>AI gateway and reply checks"]
  gateway -->|usage and tool dispatch records| models
  models -->|saves holds and settlements, reads activity, grants, payer and switch-on| store["libs/event-store<br/>event log"]
```

## What it is responsible for

- Build recorded child participation and keep its history start separate from each join.
- Recheck saved grants and permissions for a private turn memory preview without reading chat history again.
- Check that each preview fact and its supporting facts are still usable.

- Records verified tool dispatch outcomes and link attempts of the same call.
  Allows one unchanged retry after a recorded failure before dispatch.
- Counts new owners only after their member record confirms the appointment.
  A person’s access check reads their own member record and the ownership record.
  Ownership commands read other members’ confirmations when they need the full owner list.
- Records provider choices and pauses for assistants and the silo default.
  An administrator can choose any eligible provider. The first verified provider
  supplies the automatic default when nobody has chosen one. Each reply confirms
  the change that was saved. Reusing a request id for another change is refused.
  Ordinary calls still use the existing gateway setup.
- Signs short passes for memory calls through the gateway.
  A thread can read the person's own facts, its assistant's notes and that assistant's group facts.
  It can save facts only in the requester’s own memory, with a separate write grant.
  These calls need saved grants, current permissions and an explicitly recorded private turn.
- After managed calls are switched on, uses the assistant's saved provider choice or the
  silo default for each new turn. A running turn keeps its original choice. An assistant's
  own pause stops new model work. No command switches this on yet, so existing installs
  keep their current path.
  Reads the personal paying group and switch-on state together, once per new spending event.
- Choose an AI model from a fixed task table before switch-on.
- Keep model prices and estimate each request's cost before sending it.
- Keep the spending limits that admins set: a daily and a monthly limit for the silo, and a monthly limit for each paying group and each assistant.
  Keep the revision shown to admins valid after switch-on when no spending change
  was saved, so they can retry a refused edit without releasing a hold first.
- Hold money before an AI call and settle the charge when usage is reported.
  Keep the budget state in memory after replay, so saving each change does not
  read all the old spending events again.
- Read a spending hold before starting the access check for its resolution.
  Read any new budget events before deciding whether it can be resolved.
  Check current access again before saving the resolution.
- List spending from the saved budget and call records, without reading chat history.
  Keep calls with an unknown outcome in the list alongside settled calls.
- Release an expired hold at zero cents when it was never allowed or sent.
- Stop new holds after provider switch-on while settling or releasing existing holds.
  Keep those holds moving without restarting the models process.
- Read each new usage line once and leave old lines alone while idle. Retry a line
  if its event could not be saved.
- Check access passes, current permissions, tool rules, approvals and budgets before calls proceed.
  Keep approval lists within the caller’s current period of participation.
  Reuse checked approval facts and read only later chat changes before a decision.
- Refuse provider-bound model passes on the deployment-key gateway before holding money.
  Read switch-on from the silo’s spending stream before checking access.
  Calls through saved provider choices are not available yet.
- Refuse native child model calls before holding money. Older delegation records
  grant no call authority either.
- Check member or admin access for reads using saved membership and current permissions.
  Let one request reuse checks for the same saved access event.
  Keep membership checks for writes within the caller’s original deadline.
- Check that an invitation's sender still has authority before it is accepted.
- Keep chat, computer and model grant facts in memory and read new events before each call.
  Keep only the latest grant facts for each person, assistant or group.
  Check those facts before watching the streams that decide access. These checks
  share two seconds because the gateway waits only that long. Older summaries
  are dropped when their memory budget is reached and rebuilt on their next use.
  A summary that is too large is dropped on its own. Calls also refuse saved
  facts beyond the current history, which can happen after a backup restore.
- Mark refused tool calls so the computer can say when nothing was sent.
  Remove that marker from tool-server replies, which cannot prove this.
- Refuse unsafe tool call ids before saving a decision.
- Refuse callers who have disconnected before holding money.
- Keep calls working when another chat, a file or someone else's access changes during the check.
- Treat tool start and finish reports as activity that grants no access.
- Check that each Codex tool call belongs to the chat turn that received its access pass.
  Keep its call id, which links the tool's attempts and progress reports.
  Accept the model request that follows a tool result under the same spending limits.
- Start agentgateway without giving its provider key to the server or computer.
- Record what the AI provider used. When the result of a call is unknown, keep the held money in place until an owner or admin settles it.
- Give new members and assistants access to the active models ([grants](../../GLOSSARY.md#grant)), record the silo's first owner, store the AI provider settings that admins enter, and show spending history without private details.

A tool offered in Allow mode is refused if its policy changes to Ask during that
turn. A waiting Ask call can use only its own approval, once. Approvals opened by
a waiting computer expire after 15 minutes, even while the chat turn stays open.

## Processes it handles

1. **A person sends a chat message.** The server and the computer pick the model for the task. The computer sends the AI call to agentgateway. agentgateway asks the models process, which checks the passes, permissions and budget and holds the money. If the call is allowed, agentgateway sends it to the AI provider.
2. **An AI call finishes.** The gateway reports its use and the library settles the held amount. If the result cannot be confirmed, the full amount stays held for review. A later report of an unknown result restores money released before an allowed call was sent.
3. **An admin or owner changes access or spending.** The change is saved as an [event](../../GLOSSARY.md#event): the server saves tool rules and grants, and the models process saves spending limits. Background workers then update OpenFGA and the spending tables.

## How to run or test it

```sh
npm test -- libs/models
npm run typecheck -w libs/models
```

Some tests use Docker and a PostgreSQL test database. README.robot.md lists what they need.

A small example selects the model for a chat turn:

```ts
import { modelForTask } from '@opencrane/models/routing';

const model = modelForTask('chat_turn');
```

## Where to read more

- [README.robot.md](README.robot.md): exact prices, limits, settings, event rules and test detail.
- [The server](../../apps/server/README.md) holds the start file for the models process.
- [The glossary](../../GLOSSARY.md#models-process) explains the running process and AI gateway.
