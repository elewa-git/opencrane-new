# Assistants

This folder lets admins set up an assistant that a group can share. It also shows people which shared assistants they can use, whether their computers are busy and whether they can start a chat.

## What it is responsible for

- Records a shared assistant's name, owning group, paying group and selected model or tool access.
- Checks that the groups and selected resources exist before saving the assistant.
- Lists shared assistants visible to the person asking, with their computer status.
- Checks membership of both the owning group and the paying group before offering a new session.
- Returns the original saved result after a repeated request, with separate progress for the read tables and permissions.

A paying group is the group charged for the assistant's work. Each assistant has one [computer](../../../../GLOSSARY.md#computer), including a shared assistant. Creating the assistant records the choice; background workers arrange its computer. Reading or stopping an existing private chat has its own access checks in the chat folder.

## Main files

| File | What it does |
| --- | --- |
| [commands.ts](commands.ts) | Checks an admin's choices and saves one assistant creation record. |
| [routes.ts](routes.ts) | Handles creation, lists, detail and saved change results. |

## How it connects

The [server](../../README.md) registers these requests. [Members](../members/README.md) supplies group and membership checks. [Chat](../chat/README.md) checks access to private sessions with shared assistants. [Read tables](../../../../libs/projections/README.md) supply computer details, while [background workers](../../../ops/README.md) apply saved changes.
