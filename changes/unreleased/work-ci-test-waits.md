- Child-chat retry tests finish sooner while still checking retries after NATS
  stops suppressing duplicate messages. Production keeps its 120-second window.
- Recovery tests restore team membership only after a removal, so cleanup does not
  make later access checks read unnecessary permission records.
