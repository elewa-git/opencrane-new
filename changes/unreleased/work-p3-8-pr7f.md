- Members can revoke their own saved personal tool account through the API and recover
  the original receipt after a lost reply. This confirms local revocation only.
- Revocation checks current permission once after preparing saved history. A refused
  request stays refused if the permissions service later fails.
