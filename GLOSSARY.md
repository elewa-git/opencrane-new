# Glossary

This page explains, in plain words, the terms used across OpenCrane's guides.

## Silo

A silo is one customer's own private installation of OpenCrane. Its events, files,
computers and permissions are kept apart from every other customer's.

## Owner, admin, member

These are the three roles in a silo: members use their assistant, admins can also
change settings, and owners can also hand over ownership as long as one owner remains.
No role lets anyone read another person's private conversations, and no role gives
access to a model or tool without a grant.

## Assistant

An assistant is an AI helper that does work for a person or group. It can do only
what its grants and the current requester's rights allow.

## Computer

A computer is the private computer in the cloud where an assistant does its work.
Each assistant has one computer across its conversations, including a shared group
assistant whose members share that computer. Its saved files survive restarts.

## Bridge

The bridge is a small program on each computer that passes chat messages from the
server to Codex. It sends progress and results back so the server can record them.

## Codex

Codex is OpenAI's AI agent, a program that carries out a request step by step instead
of only answering it. It runs inside each computer, calls AI models and uses the
computer's tools. Developers also use Codex as a coding helper to build OpenCrane.

## Model and model provider

A model is the AI system that writes replies and decides the assistant's next step.
A model provider, such as OpenAI, is the company that runs it.

## Event

An event is a saved record of one thing that happened, such as a member joining.
Events are never changed: a later change is saved as a new event.

## Event log (event store)

The event log is the numbered list of all events, kept in NATS JetStream, a service
that stores and passes on events. It is the one true record of what happened, and
everything else is built from it.

## Stream summary

A stream summary is a few facts about one event stream, kept in a process's memory.
A TypeScript function builds it by adding events in order. Each use reads the new
events first, so decisions use the latest saved facts. It can be rebuilt from the
first event and does not need a database table.

## Read table (projection)

A read table is a PostgreSQL database table built from events, so screens can load
data quickly. It is only a copy, so it can be thrown away and rebuilt from the event
log.

## PostgreSQL (database)

PostgreSQL is the database that holds the read tables. Its tables are copies built
from the event log.

## Reaction (handler)

A reaction is background work that runs after an event, such as creating an assistant
when someone joins. The code calls it a handler.

## Dispatcher

The dispatcher is the background program that reads each new event and hands it to
the reactions that need it. It uses a job queue, a waiting list of jobs, so the work
for one thing, such as one conversation, runs in order.

## Replay

Replay means reading all saved events again from the start, to rebuild read tables or
permissions. A replay never repeats outside actions, such as calling a model.

## OpenFGA (permissions service)

OpenFGA is the permissions service, which decides whether a person or assistant may
use something. OpenCrane builds its permission records from events.

## Zitadel (sign-in service)

Zitadel is the sign-in service, where people sign in with their company account. The
server then checks that the account belongs to this silo's company.

## Access token

An access token, also called a pass, is a short-lived digital proof of who is asking.
It expires soon, so a stolen one is quickly useless.

## agentgateway (AI gateway)

agentgateway is the AI gateway: every model call and calls to reviewed, published
MCP tools pass through it. It asks the [models process](#models-process) whether
each call is allowed; shell and file tools run locally inside the computer.

## Models process

The models process is a separate program inside `apps/server`. It answers
agentgateway's permission questions, keeps the AI budgets and starts agentgateway.

## MCP server (tool server)

A tool server is a small program that gives an AI agent named actions, such as
looking up an order in a business system. MCP, the Model Context Protocol, is the
shared standard for describing those actions and calling them.

## Tool rule (Allow, Ask, Block)

A tool rule is the admin's setting for one tool: Allow lets it run without asking,
Ask waits for the person to approve that exact action, and Block stops it.

## Grant

A grant gives a person, assistant or group permission to use one named thing, such as
a model or a tool. A grant alone is not enough: membership, tool rules and the budget
are still checked.

## Budget

A budget is a spending limit, counted in whole euro cents. Before each AI call some
money is set aside, and the real cost is charged once the call's use is reported.

## Kubernetes

Kubernetes is a system that runs and looks after containers, including the assistants'
computers. k3d and k3s are ways to run Kubernetes on a developer machine.

## Operator

An operator is the person or team that installs and runs a silo. In Kubernetes, an
operator can also mean a program that looks after a service automatically, such as
the CloudNativePG operator.

## Container and Pod

A container packages a program with the files it needs, so it runs the same way
anywhere. A Pod is one or more containers that Kubernetes runs together, and each
computer runs in a Pod.

## gVisor

gVisor is an extra security layer between the programs in a computer and the machine
they run on. It limits the damage a harmful program inside a computer could do.

## MinIO (file storage)

MinIO is the file store on the dev stack, where uploaded files are kept. The server
passes files to a computer without giving the computer the keys to the store.

## ClamAV (virus scanner)

ClamAV is the virus scanner that checks each upload before the file is stored for use.
A file is refused if it is infected, or if the check cannot finish.

## Dev stack

The dev stack is a full copy of OpenCrane that runs on a developer's machine.
Developers use it to try the product and check that the parts work together.

## Journey

A journey is an automated test that uses the product from start to finish, as a person
would. For example, it signs in, sends a chat message and waits for the reply.

## Spike

A spike is a short experiment that answers one design question before the full feature
is built. Its result is kept so later work can use what was learnt.

## Claim

Claim has four meanings in OpenCrane:

- To claim a silo is to become its first owner.
- To claim a computer is to reserve it for one assistant.
- To claim a test stack is to reserve one numbered dev stack.
- The claims in a sign-in token are the named fields inside it, such as who the person
  is.

## Private turn

A private turn is a question and reply in a member's own session with a shared
assistant. It runs in a fresh, short-lived Codex process with no tools, so it is
kept apart from other members' work on that assistant's computer.
Its temporary files live in working memory, but the host can copy that memory to
disk when memory runs short. Full isolation still needs live checks, so memory
features remain disabled during these turns; unfinished work fails after a restart.

## Memory-free turn

A memory-free turn runs without personal or group memory facts. It can use tools
and files on the assistant's computer, and continues the same conversation in Codex,
with its earlier memory-free messages but no earlier private-turn context.
Personal assistant sessions use this mode; on a shared assistant's computer, its
files are shared too.

## Turn (chat turn)

A turn, or chat turn, is one message to an assistant and the work it does to reply.
One turn can include several AI calls and tool actions.

## Shared assistant (group assistant)

A shared assistant belongs to a group rather than one person. Members use their
own sessions with it on the group's one shared computer.

## Paying group

A paying group is the group whose budget pays for a request. It may be chosen for
a shared assistant or fall back to the installation's default group.

## Stop

Stop is the chat action a person uses to end the assistant's current reply.
It does not prove that an outside service has cancelled an action already sent.

## Budget stop

A budget stop ends affected assistant work because a saved spending limit has
been reached or reduced. It comes from spending rules rather than a person
pressing Stop, and does not erase charges or uncertain costs.

## Hold, settle and release

A hold sets money aside before a call so another call cannot spend it.
Settlement charges the confirmed cost; release returns unused money to the
available budget when the outcome is known.

## Child chat and child request

A child chat is a side conversation started from another chat. A child request
records the side task and where its answer should go; it does not grant access
beyond the people and assistant allowed to take part.

## Publication

Publication sends a reviewed tool server's settings to the AI gateway.
Saving the request does not mean the gateway has applied it yet; a separate status
reports whether the current settings are ready.

## NATS

NATS is the service that keeps OpenCrane's event log and carries new events to
background programs. JetStream is the part of NATS that stores messages so they
can be read again later.

## Helm

Helm is a package installer for Kubernetes. It installs a set of programs and their
settings together, and can update or remove that named installation.

## Event core

The event core is the shared code that defines and saves events, builds read tables
and runs background reactions. It turns the saved record of changes into the data
and actions the product needs.

## Pass

A pass is another name for an [access token](#access-token), the short-lived digital
proof that lets a program make a request on someone's behalf.

## Slot (spare dev stack)

A slot is one of the two spare places for a separate development stack on a developer
machine. A worktree claims it before use, so its ports and data stay separate from
other test copies and the owner's own stack.

## Fleet

The fleet is the group of AI coding agents that build OpenCrane. These agents work
on the development machine; they are separate from the assistants people use inside
the product.

## Memory fact

A memory fact is a saved piece of information, such as a preference, that an assistant
may use later. Saving it does not give it the authority to change access or spending rules.

## Memory scope

A memory scope says whose saved memory a fact belongs to: a person, a group or an
assistant's notes. Access is checked for that scope before a fact can be read or changed.

## Receipt

A receipt is a confirmation of a saved change or a completed action. A save receipt
confirms the event was recorded; a separate applied receipt confirms that a worker
or service has carried it out.
