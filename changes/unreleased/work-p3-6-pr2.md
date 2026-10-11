Configured MCP calls now pass a final one-use check before sending. Changed tool lists,
expired checks and replaced instances refuse the call. Tool servers must check the
approved catalogue revision and instance generation before execution; unsupported
mutable servers stay unavailable. Hosted image installation is still planned.
