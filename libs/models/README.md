# Models

## What this is

Gateway replacement checks the connection holding its database lock immediately before
changing the file. A lost connection leaves the old file in place. Expired preparation
stops before saving a later configuration and releases the lock.

After recorded switch-on, the gateway uses each checked call's provider key.
It needs no fallback key file, and configuration reloads preserve that choice.
Switch-on waits for spending to settle. A free provider reachability check needs no
settlement; paid tests and other sends still do.

The AI access and spending library for OpenCrane. Its running part is the models process, a separate program whose start file lives in `apps/server` (`src/models-main.ts`). It runs beside [agentgateway](../../GLOSSARY.md#agentgateway-ai-gateway), which forwards AI requests. The library also picks the model for each task, keeps the price list and [budgets](../../GLOSSARY.md#budget), holds the [tool rules](../../GLOSSARY.md#tool-rule-allow-ask-block) and the one-time approvals for Ask tools, and records who owns the silo.

A saved takeover ends unused approvals for the same computer generation and turn.
Reading saves each cancellation once. Used approvals keep their dispatch evidence,
and saved denial or expiry stays final. Failed saves leave cancellation unconfirmed.

## Where it fits

This shared library is used by the server, background workers and personal computers.
Its private credential adapter talks to Kubernetes through the server’s local proxy.
It checks passes with `libs/auth`, permissions with `libs/authz`, and starts agentgateway
to handle AI calls.

```mermaid
flowchart LR
  models -.->|replay tests use the database helper| store
  server["apps/server, apps/ops and models process<br/>back end and workers"] -.->|checks public tool addresses, reads, hosted image status and check requests, calls, control, cost reviews, approval details and takeover cancellation, memory, owners, providers, free reachability, spending pages, personal account choices, saved tool choices and call statuses| models["libs/models<br/>AI rules, personal accounts, image checks, control, provider choice and spending"]
