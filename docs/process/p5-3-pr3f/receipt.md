# Backup token references

Status: PARTIAL.

The CNPG backup and recovery previews require a Secret reference for the session
token. The local checker reads it from the owned Secret and sends it with the
access key for its marker and cleanup requests. Tests use a synthetic token and
local TLS storage. They do not start a development stack or contact real MinIO.

The checker still refuses every backup after its existing access probes. It does
not yet use the verified process-local record from the backup identity provisioner.
The installer gate remains closed. Real credential issuance and renewal, scheduled
backup and WAL, restore, and promotion are NOT RUN.

## Source checks

- PASS: backup checker and identity tests, 201 cases on each of two final runs.
- PASS: chart rendering, 249 cases on each of two final runs.
- PASS: focused backup and recovery package tests, 15 cases on each of two final runs.
- PASS: event security rules, 460 cases against a throwaway PostgreSQL database.
- PASS: typecheck, event catalogue, knip, changelog, README and process text checks.
- PARTIAL: scoped ESLint exited cleanly, but the repository configuration ignores
  `infra/` files. Typecheck checks the changed TypeScript instead.
- NOT RUN: the root test suite and a development stack.
