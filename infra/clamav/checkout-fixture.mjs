import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const checkoutIdentity = {
  revision: 'a'.repeat(40),
  branch: 'work/pilot-15-s1',
};

export function writeCheckoutShim(bin) {
  const { revision, branch } = checkoutIdentity;
  const git = `#!/bin/sh
case "$*" in
  'rev-parse HEAD') printf '%s' '${revision}' ;;
  'branch --show-current') printf '%s' '${branch}' ;;
  *) exit 1 ;;
esac
`;
  writeFileSync(join(bin, 'git'), git, { mode: 0o700 });
}
