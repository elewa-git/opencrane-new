# Local Odoo Community fixture

For people, read [README.md](README.md) first.

P3-11 / [issue #52](https://github.com/elewa-git/opencrane-new/issues/52),
[parent #41](https://github.com/elewa-git/opencrane-new/issues/41), defaults
[D18–D19](https://github.com/elewa-git/opencrane-new/blob/work/phase3-spec/docs/specs/phase-3/decisions.md).
This is disposable synthetic ERP data for direct JSON-2 rights checks and P3-12.
It has its own Compose project, images, internal networks and database volume.
The shared dev stack is independent; these scripts never start or stop it.
Nothing outside `infra/odoo` may depend on these fixture images or build files;
they must never be built into, shipped in or run inside a silo.
`python3 infra/odoo/boundary.py` (also part of `npm run lint`) rejects direct
image-name and build-file references in tracked files outside this directory,
excluding Markdown documentation.

## Operator commands

Requires the Linux dev box, operator UID 1000, Docker Engine with Compose,
Python 3 and internet access during the image build. From the repository root:

```sh
infra/odoo/start.sh
python3 infra/odoo/checks.py
# Complete qualification: destroys this fixture twice and leaves it running.
python3 infra/odoo/journey.py
infra/odoo/stop.sh
infra/odoo/start.sh
# Deletes only this fixture's database/filestore volumes and rotates its user keys.
infra/odoo/reset.sh
python3 infra/odoo/checks.py
```

`start` builds the pinned images, checks their reviewed runtime inventory,
initialises a database without demo data, seeds once and waits for local HTTP.
`stop` retains the database; `start` then preserves business records and keys.
`reset` destroys this fixture's volumes, recreates the business fixtures and
replaces its bearer files. Do not run lifecycle scripts concurrently.
If setup fails, inspect `.state/setup.log`, then use `reset` after repairing the
cause. Never use an administrator to make a failed ordinary-user check pass.
Logs and downloads in `.state/` are ignored and contain no bearer values.

## Fixtures and custody

The only test accounts are ordinary internal users `fixture.writer` and
`fixture.reader`. The writer has Odoo's own-sales rights; the reader has a
fixture read-only ACL for orders and lines. A global record rule hides
`OC-RESTRICTED-001` and its lines from everyone except the assigned writer.
Both users can read `OC-DRAFT-001` and `OC-DRAFT-002`. Each order is a draft,
with one synthetic service line, an example.invalid buyer and a fixed order date.
Only the writer can update the draft note. Checks verify the refused operations
leave the note and attribution unchanged, and an allowed write records the
writer's actual `write_uid` in Odoo.

Secure local setup generates random database and administration passwords,
random unusable-for-operators user passwords, and Odoo-generated 12-hour RPC
keys. Values never enter argv, source, events or command output. Keys are written
atomically, mode **600**, below **~/.config/opencrane/odoo/** (directory **700**):

- `writer.key` and `reader.key`: bearer references for direct checks.
- `database.password` and `odoo.conf`: private infrastructure configuration.
- `fixtures.json`: safe record ids, installed modules and key expiry, no secrets.

Do not read a key into a shell variable, print it, use `curl -H` with its value,
or attach the private directory to evidence. Checks open the files themselves,
reject symlinks/unsafe modes and disable HTTP proxies. Expired keys require
`reset`; there is no administrator fallback. P3-12 must import credentials into
the secret store through operator setup and retain only secret ids in events.

## Network boundary

The operator endpoint is **`http://127.0.0.1:18069`**; the PostgreSQL port is
unpublished. Odoo and PostgreSQL use only internal Docker networks, preventing their runtime
internet egress. A fixed-destination socat relay runs on the host network and
binds only 127.0.0.1:18069, because Docker 29 suppresses published ports on
internal bridges. It forwards only to 172.30.52.2:8069. No port 8072 is published and no shared-stack network is attached.
The reserved, operator-configured upstream path is the Docker network
**opencrane-odoo-mcp-upstream**, alias **odoo:8069**, fixed IP **172.30.52.2** (subnet 172.30.52.0/28), intended solely for the
future hosted **opencrane-odoo-mcp** workload. Only the operator may attach that
workload to this network; an attachment is a network grant, not tool permission.
The [upstream policy](upstream-policy.json) records these exact allowed addresses
and the future workload name. Docker's local administrator remains trusted. This network name does not itself
verify a container identity. P3-12 must bind the approved workload and fixed
upstream policy before making it usable; arbitrary remote URL registration must
never use this path. No MCP service is deployed by this fixture. Standalone discovery tests live in
[apps/odoo-mcp](../../apps/odoo-mcp/README.robot.md); the product route remains unavailable.

## Pins, licences and evidence

Community source: **643610127254ee77bbc756b6746739e9e9bb85ff**, version **19.0**;
tar SHA-256 **73e03d0198a9fc47b582dc3293326cd006a1a9c1f990f1d24ac5b5ba63f6455a**.
The Dockerfile pins the Debian amd64 base digest and signed Debian main snapshot
**20261002T000000Z**, freezing OS, Python dependencies and PostgreSQL **17.11-0+deb13u1** (also an exact apt pin).
No Enterprise repository, add-on, production dataset, PyPI or npm package is used.

Odoo is **LGPL-3.0-or-later**; this repository's fixture scripts are
**AGPL-3.0-or-later**. See [runtime licence review](licences.md) and the
[qualification receipt](../../docs/process/odoo-fixture-evidence.md).
The ERP is an external system: its native ORM and security rules own these
synthetic records. Nothing writes OpenCrane business state or introduces SQL
business rules into OpenCrane's event/projection architecture.
