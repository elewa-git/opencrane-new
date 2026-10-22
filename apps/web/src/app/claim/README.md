# First-owner setup

This folder shows the page where someone becomes the first owner of a new OpenCrane installation. They sign in, enter their name and contact email, and use the one-time code supplied by the installer.

## What it is responsible for

- Checks whether the person is signed in before showing the form.
- Sends the claim and clears the code from its input when submitted.
- Explains refusals such as an expired code or an existing owner.
- Confirms saved ownership and links to the workspace while the assistant and permissions are prepared.

## Main files

| File | What it does |
| --- | --- |
| `claim.ts` | Checks sign-in and sends the first-owner request. |
| `claim.html`, `claim.css` | Draw the setup form and its result. |

## How it connects

[Page selection](../README.md) opens this screen at `/claim`.
[The server](../../../../server/README.md) checks the one-time code and records ownership.
Later ownership changes belong to [People & groups](../people/README.md), rather than this setup page.
