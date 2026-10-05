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

An assistant is the AI helper each member gets. It acts for that member and can do
only what its grants allow.

## Computer

A computer is the private computer in the cloud where an assistant does its work.
A personal assistant keeps the same computer for all its conversations, and its
files survive restarts.

## Bridge

The bridge is a small program on each computer that passes chat messages from the
server to Codex. It sends progress and results back so the server can record them.

## Codex

Codex is OpenAI's AI agent, a program that carries out a request step by step instead
of only answering it. It runs inside each computer, calls AI models and uses the
computer's tools.

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

An access token is a short-lived digital pass that proves who is asking. It expires
soon, so a stolen one is quickly useless.

## agentgateway (AI gateway)

agentgateway is the AI gateway: every model call, and some tool calls, pass through
it. Before it sends a call on, it asks the [models process](#models-process) whether
the call is allowed.

## Models process

The models process is a separate program inside `apps/server`. It answers
agentgateway's permission questions, keeps the AI budgets and starts agentgateway.

## MCP server (tool server)

A tool server connects outside tools, such as a web browser or a business system, to
an AI agent. MCP, the Model Context Protocol, is the standard way these calls are
made.

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

A private turn is work in a member's team session that runs in a fresh, tool-free
Codex process. Its messages, replies and working state stay in memory on the
shared computer. After a restart, unfinished work fails and is never repeated.

## Memory-free turn

A memory-free turn can use tools and the shared disk. It continues its earlier
memory-free Codex thread and receives no earlier private context. Personal
sessions always use this kind of turn.
