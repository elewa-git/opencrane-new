- Give fresh demo startup two minutes for the background worker to record its first provider choice, matching spare stack service readiness.
- Retry automatic provider choice when the model selection is not yet visible to the worker, so fresh startup cannot silently lose its default.
- Start the routine read worker on fresh local stacks so provider settings can see the saved default choice and finish setup.

Fresh development stacks now start an authenticated HTTPS scanner for uploads.
Each stack has its own private scanner certificates and loopback port, and startup
waits for the service before accepting files. The CI grouping check includes the
scanner tests.
