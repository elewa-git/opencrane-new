Private memory collection now holds the native processes and canary helper through
both live identity reads, and removes their temporary state before a retry.
Memory admission stays disabled until complete live qualification passes.
