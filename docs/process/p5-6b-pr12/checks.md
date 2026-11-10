# Upload scan admission checks

This part checks scanner reply bindings and database age before a file is saved.
The transport tests use signed caller passes, HTTPS and a scripted clock. Their
clean replies come from test fixtures, not from ClamAV. The real scanner tests
remain skipped unless separately reviewed fresh database releases are supplied.

| Check | Status | Evidence |
| --- | --- | --- |
| One changed reply binding at a time | PASS | The upload fixture refuses changed silo, request, bytes, file id, purpose, database manifest and reply expiry before object storage or an event append. |
| Database expiry in the HTTPS service | PASS | A valid caller pass reaches a clean scan fixture; the service refuses when the database expires before reply. Removing the service age guard makes the test fail. |
| Database expiry in the upload consumer | PASS | A held clean reply crosses the database deadline with a valid caller pass. No object write or content event follows. Removing the consumer age guard makes the test fail. |
| Silo and purpose comparison | PASS | Removing either check separately makes its one-field test fail. |
| Real ClamAV clean and EICAR, image malware and complete qualification | NOT RUN | No separately reviewed fresh database release was supplied. No substitute was fetched. |

The source checks below report only checks run for this part. They do not qualify
the packaged scanner or open production image admission.

| Source check | Status | Evidence |
| --- | --- | --- |
| Changed HTTPS and upload suites | PASS | 108 tests passed twice; three real scanner tests were skipped each time. |
| Development scanner settings | PASS | Six tests passed twice. |
| Event field security rules | PASS | 482 tests passed once; no event field changed. |
| Changed-file ESLint | PASS | The repository-scoped command passed for all files it includes. Its configuration excludes development-stack files; their separate typecheck covers them. |
| Typecheck | PASS | Workspace, package and development-stack configurations passed. |
| Event catalogue | PASS | 171 event types agree. |
| Knip and changelog lint | PASS | Both checks completed. |
| Markdown lint | PASS | The repository file list had no findings. |
| Public privacy check | PASS | Tracked text contained no private owner address or home path. |

An optional forced ESLint run on development-stack files could not parse them
because the repository excludes that folder from its ESLint project list. The
required repository-scoped command passed; the development-stack typecheck passed.
