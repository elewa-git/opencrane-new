# Glossary

Use this page for the words shared by OpenCrane's guides.
Read the [system map](README.md) to see how the parts fit together.

## Silo

Run one customer's private installation of OpenCrane as a silo.
Keep its events, files, computers and permissions separate from other customers.

## Owner, admin, member

Members use their assistant; admins also manage organisation settings, and owners
can also hand over ownership while keeping at least one owner. No role grants access
to another person's private conversations or replaces a model or tool grant.

## Assistant

Give each member an AI helper that acts for them within its granted permissions.
That helper is their assistant.

## Computer

Run the assistant's work on its own private cloud computer.
A personal assistant keeps one computer across its conversations, with files kept across restarts.

## Bridge

Pass chat turns from the server to Codex through the bridge, a small program on the computer.
Send progress and results back through it so the server can record them.

## Codex

Run Codex, the AI agent, inside the computer to carry out a person's request.
It calls models and uses the computer's tools to do the work.

## Event

Record something that happened, such as a member joining, as an event.
Keep that record unchanged rather than overwriting it with a later state.

## Event log (event store)

Keep events in a numbered log in NATS JetStream, the service that stores and carries them.
Use this log as the one source of truth for business state.

## Read table (projection)

Build a PostgreSQL table from events so screens can read data quickly.
Throw it away and rebuild it from the event log when needed.

## Reaction (handler)

Run background work after an event, such as creating an assistant when someone joins.
Call that work a reaction, or a handler in the code.

## Dispatcher

Read new events and hand them to the right background reactions.
The dispatcher does this through a job queue that keeps each stream's work in order.

## Replay

Read saved events again from the start to rebuild read tables or permissions.
Do this without repeating outside actions, such as calling a model.

## OpenFGA (permissions service)

Ask OpenFGA whether a person or assistant may use a resource.
Build its permission records from OpenCrane events.

## Zitadel (sign-in service)

Sign in with a company account through Zitadel.
The server checks that the account belongs to the silo's configured organisation.

## agentgateway (AI gateway)

Send model and supported tool calls through agentgateway.
It asks the models process for permission before passing an allowed call to the outside service.

## MCP server (tool server)

Connect outside tools to an AI agent through a tool server.
MCP means Model Context Protocol, the standard used for those calls.

## Tool rule (Allow, Ask, Block)

Set the admin's rule for each tool: Allow runs it automatically, Ask needs the person's
approval of the exact action, and Block refuses it.

## Grant

Give a person, assistant or group permission to use a named resource, such as a model.
A grant does not replace the other checks on membership, tool rules or spending.

## Budget

Limit spending with a budget measured in whole euro cents.
Hold money before an AI call and settle it when the call's use is reported.

## Kubernetes

Run containers and the assistant computers with Kubernetes.
k3d and k3s are ways to run it on a developer machine.

## Container and Pod

Package a program and the files it needs in a container.
Run one or more containers together in a Kubernetes Pod; a computer uses a Pod.

## gVisor

Add a security layer between a computer's programs and the machine running them.
Use gVisor to reduce the damage a program inside a computer could cause.

## MinIO (file storage)

Store uploaded files in MinIO on the dev stack.
The server passes files to a computer without giving it storage credentials.

## ClamAV (virus scanner)

Check uploaded files for viruses with ClamAV before storing them for use.
Refuse a file when the scanner finds an infection or cannot finish the check.

## Dev stack

Run a full developer copy of OpenCrane on a developer machine.
Use it to try the product and check that the parts work together.

## Journey

Check the product from start to finish in the way a person would use it.
A journey might sign in, send a chat message and wait for the reply.

## Spike

Try a short experiment to answer a design question before building the full feature.
Keep the result so later work can use what was learnt.

## Claim

Claim a silo to become its first owner, a computer to reserve it for an assistant,
or a test stack to reserve a numbered developer installation. In a sign-in token,
claims are the named fields that describe the signed identity and its access.
