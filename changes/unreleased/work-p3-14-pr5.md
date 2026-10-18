- A spending Stop removes the affected turn's model and tool access immediately,
  cancels its waits and closes its local model and tool connections. Late replies
  cannot restore access, even while their replies are pending. Delayed cleanup
  leaves a new turn on the same thread working.
