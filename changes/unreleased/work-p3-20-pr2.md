- Add an optional private CONNECT route and check its routing order with the pinned
  gateway. Reuse the existing one-use send check for non-metered egress. Normal
  startup keeps the route off while destination and socket safeguards are built.
