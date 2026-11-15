Fresh secondary dev stacks retain their supplied Zitadel key-file reference per
slot and reuse their existing sign-in app and test users through teardown. Setup
now distinguishes unavailable credentials from rejected provider calls, reporting
safe endpoint, HTTP status and numeric error-code diagnostics without credentials
or provider response text.
Linked slot credential directories and retained reference files are refused, so
setup cannot read or overwrite another slot's saved key location. Explicit shared
key paths remain supported. Interrupted provider error bodies keep their private
cause while the CLI reports only the safe status.
