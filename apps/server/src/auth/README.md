# Auth

This folder handles signing in and out of OpenCrane. It sends the browser to the sign-in service, checks the returning identity and keeps the person's session in an encrypted browser cookie.

## What it is responsible for

- Starts sign-in and returns the person to a safe page afterwards.
- Checks the reply from [Zitadel](../../../../GLOSSARY.md#zitadel-sign-in-service), the sign-in service.
- Reports whether the browser has a valid session, with safe profile details.
- Handles a recent sign-in when a particular tool approval requires it.
- Ends the local session and, when available, redirects the browser to end its sign-in service session too.

Sign-in details that are too large for a browser cookie receive a clear error. Recent sign-in for an approval must belong to the same account and browser session. Sign-out must come from this website and a valid organisation session. A refusal leaves cookies unchanged; if provider sign-out is unavailable, the page explains that only the OpenCrane session ended.

Session requests and live connections require the configured organisation. Production refuses extra sign-in identities. Development can allow named identities from another organisation, but that does not remove the organisation setting required by session requests. Logs leave out private callback details and credentials.

## Main files

| File | What it does |
| --- | --- |
| [routes.ts](routes.ts) | Handles sign-in, callback, sign-out and current-session requests. |

## How it connects

The [server](../../README.md) registers these requests for the [website](../../../web/README.md). The [auth library](../../../../libs/auth/README.md) owns sign-in and cookie rules. [Members](../members/README.md) maps a valid session to a member; signing in alone does not grant access to chats or organisation settings.
