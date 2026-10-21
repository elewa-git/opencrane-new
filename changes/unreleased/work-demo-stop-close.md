Stop can reach a streaming reply while saved reports are being replayed. The computer waits for report acknowledgements before sending more, keeping the connection open and preserving partial replies.
Stop also reuses chat facts already checked while saving progress, avoiding another full history read during a long reply.
Messages and Stop still refuse an id already used by a report, even after the broker forgets its duplicate entry.
