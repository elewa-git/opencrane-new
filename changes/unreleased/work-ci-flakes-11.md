- Approved HTTPS tool retries recover after a refused budget admission without
  sending twice. Repeated unrelated events no longer stop the budget writer;
  every attempt keeps the original permission checks and two-second deadline.
- An expired budget write no longer disables later spending operations when nothing
  was sent to the event store. Lost write replies require a fresh budget read before the next command.
- Repeated budget commands keep their earlier result. An id belonging to a different
  command, or an invalid event rejected by the store, no longer disables the writer.
- A rejected budget write followed by a failed history read refuses only that request.
  Later requests re-read the budget. Only a confirmed budget change or lost ownership
  stops the writer, and every attempt keeps its original two-second access limit.
