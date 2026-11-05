Private memory checks can measure the runner's own container memory, swap and dump
protection. This first part returns NOT RUN on that path until the other processes
are protected too; it cannot qualify a deployment or enable memory.

Protection refusals now save and report which check failed, including unreadable swap
controls, non-zero core limits, a dumpable runner or an unavailable native helper.
Messages contain no observed values or private paths.
