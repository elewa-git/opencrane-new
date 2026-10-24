- Gateway configuration checks no longer create call observations that can interrupt
  managed model calls. Tool calls finish reading conversation history before starting
  their existing two-second access check.
