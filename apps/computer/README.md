# apps/computer

## What this is

A private cloud computer where each person's assistant does its work. Each computer is a locked-down Linux container. It holds Codex (OpenAI's coding agent), a web browser and a remote desktop. Kubernetes, the system that runs containers, starts one for each person.

Private turns run in a temporary Codex process with no tools. Its files use a memory
volume, which can still be written to disk by swap. Isolation is not yet proven on
a live computer; memory features stay off until it is.

## Where it fits

This is the personal computers layer. `apps/ops` starts and pauses computers. `apps/server` sends chat turns and files and can show a read-only desktop view. The computer sends model requests through agentgateway, the AI gateway in the server's models process.

```mermaid
flowchart LR
  kube["Kubernetes<br/>computer manager"] -->|runs| computer["apps/computer<br/>personal computer"]
  ops["apps/ops<br/>background workers"] -->|starts, pauses and delivers passes| computer
  server["apps/server<br/>the back end"] <-->|turns, models, approvals, dispatch and consent reports| computer
  events["libs/events<br/>report text check"] -.-> computer
  computer --> supervisor["Root supervisor<br/>executor admission and thread exit checks"]
  computer -->|runs private turns| private["Private Codex<br/>temporary process"]
  private -->|sends model requests| gateway
  computer -->|sends model and reviewed tool calls| gateway["agentgateway<br/>AI gateway"]
```

## What it is responsible for

- Refuses unsupported native MCP consent and reports its request without private text.

- Builds the container image with Codex, a browser, a remote desktop and document tools.
- Accepts new server passes only through authenticated Kubernetes access as root.
  Local Codex and desktop processes cannot replace them.
- Runs the bridge that receives chat turns and sends progress reports to the server.
- Runs each turn with the model the server confirms. Keeps that model when renewing
  the turn's pass. Older servers keep the existing task-based choice.
- Reports when a listed tool call starts or finishes, without its arguments or result.
  Skips invalid names and call ids so later reports can still reach the server.
- Keeps files in the person's workspace when the computer pauses and starts again.
- Lets Codex reach the AI gateway only while the current chat turn holds a valid short-lived pass.
- Separates the assistant, file tools and desktop into different Linux users.
- Stops executors through a root-only socket. Keeps executor admission closed after
  a stop, including when the supervisor restarts. Browser quietness is still unproven,
  so taking control remains disabled.
- Supplies the Kubernetes files that restrict network access.
- Checks the image's licences before publishing it.

Codex sees only the reviewed, free tools allowed for that chat turn. Each tool
call goes through a local proxy and the gateway's current access checks. When
a new turn begins, the bridge reloads only that conversation's Codex thread.
It keeps the conversation history. Reloading stops any background terminals
from that thread. If reload cannot be confirmed, the reply fails with a clear
message and the person can send it again. The proxy releases the list when the
turn ends. A tool changed from Allow to Ask is refused. Reviewed Ask tools wait
for the requester to approve. The same call then continues once, with a fresh pass.
Denial, Stop and a wait longer than 15 minutes end the call without sending it.
The server and computer can be updated in either order. The computer tells the
server whether it can wait for approval. Older computers receive Allow tools only.

## Processes it handles

1. **A computer starts.** It prepares private folders and starts Codex, the desktop and the bridge. It reports that it is ready when the required services respond.
2. **A person sends a message.** The server sends the turn to the bridge. The bridge loads its reviewed tools, runs it in Codex and sends progress reports back.
3. **A person uploads a file.** The server passes the scanned file to the bridge. The bridge puts it in the workspace for Codex to read.
4. **A computer resumes.** Its files remain on its disk. The bridge sends any reports that the server has not confirmed yet.
5. **A trusted root process stops executors.** The supervisor closes executor connections
   and stops tools and private Codex processes. It checks every worker thread, including
   workers whose main thread has exited, and detached children. If work keeps running,
   it refuses an exit receipt. Its receipt cannot grant desktop control.

The local HTTP listener allows up to 17 minutes to receive a request. This setting
does not limit how long its reply can wait. Approval waits have their own 15-minute limit.

## How to run or test it

```sh
npm run build:image -w apps/computer
npm run test:image -w apps/computer
npm run typecheck -w apps/computer
```

Both image commands need Docker and the dev stack's local Kubernetes cluster.
`build:image` also runs the image tests and updates `sandbox-template.json` with the
new image.

## Where to read more

- [README.robot.md](README.robot.md): image details, settings, security limits and test commands.
- [apps/ops](../ops/README.md) starts and pauses computers.
- [apps/server](../server/README.md) sends turns and receives progress reports.
- [Why Codex runs on each person's computer](../../docs/adr/0003-harness-codex.md).
- [Why a computer keeps its disk when it sleeps](../../docs/adr/0006-computer-disk-and-live-view.md).
- [The shared words used in these guides](../../GLOSSARY.md).
