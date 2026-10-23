- Event log setup now allows NATS its normal five-second management timeout, so a busy
  server can finish creating storage before background workers start. Event reads keep
  their existing short time limits.
