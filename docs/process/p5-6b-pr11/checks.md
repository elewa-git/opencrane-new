# Local upload scanner checks

The starting main commit is `e11aecedfcf5950f5533616cbdfa77eee4646132`,
which contains the image-tool work from #998. The local fixture uses the real
scanner launcher, HTTPS service, server upload consumer and a disposable NATS
event log. Its object-store double records object identity and size only.

| Check category | Status | Evidence |
| --- | --- | --- |
| Clean and EICAR through the real scanner | NOT RUN | No separately reviewed fresh database manifest or release record was available locally. The live test is skipped without those inputs. |
| Two silo bindings and event admission | NOT RUN | Requires the same real scanner inputs. |
| Bad TLS, caller pass, stale database and outage | NOT RUN | Requires the first reviewed release. |
| Recovery with a new verified database | NOT RUN | Requires a second reviewed release with a different approved manifest hash. |
| Copied upload reply across silos | PASS | The authenticated transport regression passed twice; it uses a service reply fixture, not ClamAV. |

Approved database digest: **none supplied**. No current database was represented
as fresh. Transport request ids: **none**, because no real scan request ran.
The pinned offline image alone does not establish a current update check.

| Source check | Status | Evidence |
| --- | --- | --- |
| Changed transport tests | PASS | 37 passed twice; two real scanner tests skipped on each run. |
| Event field security rules | PASS | 482 passed once. No event or API field was added. |
| Scoped ESLint | PASS | Three changed JavaScript files. |
| Typecheck | PASS | All workspace, package and development stack configurations. |
| Event catalogue | PASS | 171 event types agree. |
| Knip | PASS | No unused dependency findings. |
| Changelog lint | PASS | The new release note is a branch fragment. |
| Markdown lint | PASS | Repository file list, zero issues. |
| Public privacy check | PASS | No private owner email or home directory in tracked text. |

These source checks do not qualify real malware detection. A fresh install and
the twice-fresh packaged journey remain NOT RUN.
