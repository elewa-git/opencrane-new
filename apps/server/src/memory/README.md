# Memory

This folder lets people review, save, correct and forget information the assistant may remember. It also supplies approved memories during a chat, while keeping each person's information separate from group information and assistant notes.

## What it is responsible for

- Lists and searches memories the person may read, and returns individual facts and their available sources.
- Saves human facts, corrections and forget requests, with checks for lost replies.
- Checks current access before reading private text or saving a change.
- Records which facts an assistant loaded before returning their text.
- Allows an assistant to save a personal fact only when all the facts it relied on are recorded.
- Previews eligible facts for a saved private turn without sending text to a computer.
- Records choices and shows saved status for future nightly upkeep; running that upkeep remains disabled.

A memory fact is one saved piece of information. Its scope says whose memory it belongs to: a person, a group or an assistant's notes. [Grants](../../../../GLOSSARY.md#grant) say who may read and write it. Reads return unavailable while the [read table](../../../../GLOSSARY.md#read-table-projection), a database copy built from saved changes, is behind. A later request can succeed after the memory worker catches up. They need the memory worker and its existing private key directory. Destroyed or quarantined facts return status without text.

**Reading sources.** Each source is checked separately. Denied references stay hidden. A chat source requires current access and the latest join before the server looks up that message. A member statement is described without naming its author. Write permission is checked before inspecting a fact. Slow permission checks leave database connections free.

**Saving and correcting.** The server shares a small number of write places between members. Each member can have one active write and one waiting write across their scopes and browser sessions, leaving room for other people. Busy writers receive a prompt reply. A member can correct their own fact while its supporting facts and keys remain available. Saved command information repairs interrupted corrections and releases finished write reservations after a lost reply or forget. A fact's key stays available while a delayed write might still be saved.

**Forgetting.** A person can forget their own fact through HTTP. Group members can forget group facts and their group's assistant notes with both read and write grants. Personal assistant notes also require the assistant's owner and both grants. The fact is hidden immediately; the result says whether cleanup is pending, unavailable or finished. After a lost reply or restart, the person can check the original result with current rights without saving another change.

**Assistant access.** A turn is one message and the assistant's reply. The memory tool server checks the AI gateway's signed [access token](../../../../GLOSSARY.md#access-token), a short-lived pass, alongside saved grants, current permissions, the bound assistant and recorded turn mode. It can return personal facts and permitted group facts or assistant notes. Every call checks the previously loaded references. The memory tool server checks each signed description of the turn once. It also checks whose memory the call may use and the proof required for a write.

The recall definition is also used to check the private chat tool list. Changed definitions and Ask or Block choices cannot enter that list. Live private tool delivery remains disabled.

Recall, Correct and Forget load history before the gateway signs the short pass. The server keeps that data for one use and checks current access again. Correct and Forget check the loaded target and later revisions, then report that these tools are disabled.

Recall saves its references before returning fact text or signed proof of what was read. Failed or uncertain saves return neither. A lost reply keeps the references and cannot send the same recall again. If the conversation closes during saving, the references remain readable but the ended context returns no text or proof. References keep personal and shared facts separate and cannot restart a turn or grant access. Chat summaries rebuild them using the models library's shared memory reader without loading fact text.

An assistant's personal write must name every loaded fact as a dependency. Any loaded group fact or assistant note prevents that write. Removed write access or a disabled assistant refuses the save within the original access deadline. The server checks again after reading the latest references, including when a grant was removed and restored during the write. The agent's own built-in memory stays disabled.

Before renewing a turn pass, the server checks every loaded fact and its current access. It checks after the last memory read and again after signing, within the original time limit. Correction, forgetting, expiry or lost access returns no pass. An invalid older memory record does not block ordinary message sending or stopping, but memory operations still refuse it. Facts with expired or unusable supporting facts are left out of private-turn previews. [Private turns](../../../../GLOSSARY.md#private-turn) on shared computers keep memory off until disk isolation has been proven live.

**Nightly choices.** A member can choose an assistant and paying group and explicitly accept a cost limit. The server checks their access and returns the saved choice. Only the person who set it up can read its blocked or missed history. The history contains dates and fact references rather than memory text, and reading it starts no work. Status shows whether facts are waiting and the next 02:00 UTC boundary. Execution is still disabled.

## Main files

| File | What it does |
| --- | --- |
| [routes.ts](routes.ts), [reads.ts](reads.ts), [detail-sources.ts](detail-sources.ts), [message-source.ts](message-source.ts) | Serve scopes, fact lists, details and separately checked sources. |
| [access.ts](access.ts), [admission.ts](admission.ts), [sources.ts](sources.ts) | Check scope permissions, share write places and validate supporting facts. |
| [commands-routes.ts](commands-routes.ts), [commands.ts](commands.ts), [correct.ts](correct.ts), [forget.ts](forget.ts) | Save facts, corrections and forget requests, and recover original results. |
| [command-history.ts](command-history.ts), [journal.ts](journal.ts) | Track unfinished writes so recovery keeps the right keys. |
| [mcp.ts](mcp.ts), [recall-delivery.ts](recall-delivery.ts), [recall-proof.ts](recall-proof.ts), [agent-lineage.ts](agent-lineage.ts) | Serve assistant recall and remember tools with proof of loaded facts. |
| [turn-preview.ts](turn-preview.ts), [maintenance.ts](maintenance.ts) | Preview private-turn memories and record future upkeep choices and history. |

## How it connects

The [server](../../README.md) registers requests for the [website](../../../web/README.md) and the memory [tool server](../../../../GLOSSARY.md#mcp-server-tool-server). [Members](../members/README.md) and [chat](../chat/README.md) supply current access and turn facts. [Integrations](../integrations/README.md) and the [models library](../../../../libs/models/README.md) apply the same final tool-call checks as other tools. [Background workers](../../../ops/README.md) maintain the encrypted memory read tables and keys.
