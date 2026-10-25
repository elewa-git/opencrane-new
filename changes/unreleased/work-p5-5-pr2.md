- Event-store tests now check that losing two replicas refuses writes, keeps
  uncertain requests unresolved and recovers the same event history when the
  original servers return. Packaged recovery remains unqualified.
