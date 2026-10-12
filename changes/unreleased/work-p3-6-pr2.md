Configured MCP calls now pass a final one-use check before sending. Changed tool lists,
expired checks and replaced instances refuse the call. Tool servers must check the
approved catalogue revision and instance generation before execution; unsupported
mutable servers stay unavailable. Hosted image installation is still planned.
Saving Block or a tool hold before send admission refuses the call. Admission and tool
rule changes share one conditional append position; an admitted call may finish while
Block applies to later calls. Concurrent calls on the same tool can both proceed.
Built-in memory keeps its existing signed-context checks and remains available for
previews, discovery, recall and writes.
