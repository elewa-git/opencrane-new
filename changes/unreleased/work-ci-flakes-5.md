- Child-chat retry tests set their short NATS duplicate window before saving any
  events, avoiding a timer race while still proving retries keep the saved result.
