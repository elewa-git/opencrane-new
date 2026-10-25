# Tests

- Wait for every NATS cluster route and three current event copies before checking
  route and publishing refusals, so busy parallel test runs do not use a half-started cluster.
