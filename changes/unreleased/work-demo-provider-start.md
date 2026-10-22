- Provider setup now reports when saved ownership is still being applied. Fresh local
  starts wait briefly and retry the same command id after that reply, while uncertain
  writes still require reading the original result.
