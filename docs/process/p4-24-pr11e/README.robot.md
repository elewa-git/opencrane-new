# Routine success finish contract

Part of #106. The internal finisher remains disabled in production.

The command checks the exact company decision, received upstream response, private
tool result, native closure, turn-ended root and settlement before saving one
`routine.run_finished`. It saves safe references and full integer cents. Ask,
uncertainty and missing money keep the slot occupied. Interrupted finish remains.

The public run list stays metadata-only. Production calling and private owner links
remain later work. Replay starts no work or charge.

## Own checks

See [receipt.md](receipt.md).
