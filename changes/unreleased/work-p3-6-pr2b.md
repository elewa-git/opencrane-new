Memory calls now use the shared one-use send check. A saved Block or hold stops forwarding, changed tool catalogues or backends refuse old passes, and captured signed memory contexts cannot be replayed.

Memory writes recheck access after harmless tool activity, so a concurrent saved revocation cannot be missed before saving a fact. The original access deadline still applies.
