- Keep credential cleanup and scan paging tests reliable when database connections are slow.
  Wait for their real locks, load saved history before paging, and check that every
  saved candidate is listed and deleted exactly once, including after a restart.
