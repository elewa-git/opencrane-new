# First fresh-stack attempt

Journey: FAIL at startup. CORE: NOT RUN. Teardown: PASS.

Source: `1e83bf257`. Claimed secondary slot 1 after the recorded load window and
free-slot checks. Startup exited 1 before CORE ran. The selected credential-file
path did not exist in this worktree. The launcher was corrected to reference the
existing credential path in the main worktree and check its presence before
claiming a slot. No credential value was copied into the receipt.

The startup console and diagnostic-file metadata were retained before teardown.
Only startup diagnostic files existed; the filtered copies contain no message
content. There were no screenshots. `down.sh --id 1` exited 0.

- [Outcome](outcome.json)
- [Startup console](startup.log)
- [Diagnostic-file metadata](service-logs.json)
- [Admission window](load-wait.jsonl)
