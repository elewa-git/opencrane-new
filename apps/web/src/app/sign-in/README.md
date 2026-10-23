# Sign-in

This folder shows the website's sign-in card, the short wait before company sign-in opens and a clear rejection page. A signed-in person can open the workspace, visit organisation integrations or sign out.

## What it is responsible for

- Checks the current session on the home page.
- Opens single sign-on through the company sign-in service after a cancellable wait.
- Explains that email sign-in is unavailable; the email field cannot submit.
- Shows a fixed, safe explanation when sign-in is rejected and offers another attempt.
- Shows invitation wording when a link contains an invitation, without granting membership.

Successful sign-in returns to the start page, where the person can open the workspace.

## Main files

| File | What it does |
| --- | --- |
| `sign-in.ts` | Read the session, manage the handoff timer and select rejection messages. |
| `sign-in.html`, `sign-in.css` | Draw the card, actions and sign-in states. |

## How it connects

[Page selection](../README.md) opens these views at `/`, `/signin/handoff` and
`/signin/rejected`. [Core](../core/README.md) supplies browser navigation.
[The server](../../../../server/README.md) handles session checks and sign-out, and redirects
to [Zitadel, the sign-in service](../../../../../GLOSSARY.md#zitadel-sign-in-service).
Passwords are entered there, rather than in this website.
