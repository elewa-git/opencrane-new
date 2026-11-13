Fresh secondary dev stacks retain their supplied Zitadel key-file reference per
slot and reuse their existing sign-in app and test users through teardown. Setup
now distinguishes unavailable credentials from rejected provider calls, reporting
safe endpoint, HTTP status and numeric error-code diagnostics without credentials
or provider response text.
