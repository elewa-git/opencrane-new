# Choose the chat default on the second connection

**PASS** on 26 November 2026 at `f9ea4faea6f7d9134e14335eecc107d47e55c71f`.
The fresh dev stack used slot 1 and the free model stand-in. The browser started
with an empty installation. Paid provider calls were zero.

## Steps and results

1. Claimed slot 1 and started it with `up.sh --fresh --id 1`.
   `status.sh --id 1` passed. The owner signed in, claimed the installation
   with a one-time token and waited for the ownership checks to finish.
2. In Models & providers, the owner created two connections and checked that
   both were reachable. The first kept zero enabled models. The owner enabled
   `gpt-6.1-sol` on the second.
3. Before the model answered, Models disabled Select chat default and told the
   owner to run the priced test on the Verify step. The bindings reply showed
   that the installation had no default.
   [1280 px](setup-refusal-1280.png) · [390 px](setup-refusal-390.png)
4. The stand-in answered the test. The owner selected the chat default on the
   second connection, paused new calls and switched on member chats. The saved
   choice recorded that there was no previous default. Models showed Member
   chats switched on.
   [1280 px](setup-enabled-1280.png) · [390 px](setup-enabled-390.png)
5. The owner invited a member, who signed in and accepted. The dev stack
   restarted on slot 1 to read the saved provider setting. Its status check passed.
6. The member sent a new message and received a completed reply at each width.
   Both saved turns used the second connection. The free stand-in received both
   calls using that connection.
   [1280 px](member-reply-1280.png) · [390 px](member-reply-390.png)
7. Copied the six screenshots before `down.sh --id 1`. Teardown passed and
   `status.sh --id 1` reported `free`.

## Earlier attempts

Four earlier fresh starts passed their status checks and released the slot after
browser setup stopped. The first provider create returned HTTP 425 while ownership
was still applying. Later runs saved reachability but timed out in the setup
dialog before selecting a default. The passing run waited for ownership and
reopened Models after reachability to read the saved result before continuing.

Startup and service logs were kept outside the repository before teardown.
The browser logs are `journey-20261126T053644Z.log`,
`journey-20261126T054629Z.log`, `journey-20261126T055632Z.log` and
`journey-20261126T060650Z.log`. The passing run is recorded in
`journey-20261126T061713Z.log`.
