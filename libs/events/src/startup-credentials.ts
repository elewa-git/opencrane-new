import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceRef = z.string().regex(/^evidence:[A-Za-z0-9_-]{1,160}$/u);

// Record requirements without recording credential values. Unsupported requirements
// remain readable so installation can save a useful refusal instead of requesting a secret.
export const hostedCredentialContractSchema = z.object({
  credentialMode: z.enum(['per_call', 'startup_short_lived', 'startup_lasting', 'unknown']),
  materialKind: z.enum(['startup_capability', 'oauth_access', 'raw_bearer',
    'per_call_lease', 'unknown']).optional(),
  maxLifetimeSeconds: z.int().positive().optional(),
  delivery: z.enum(['memory_ipc', 'environment', 'unknown']).optional(),
  renewal: z.enum(['memory_provider', 'controlled_restart', 'none', 'unknown']).optional(),
  upstreamEnforcesExpiry: z.boolean().optional(),
  upstreamEnforcesBinding: z.boolean().optional(),
  imageDigest: digest.optional(),
  launcherDigest: digest.optional(),
  dependencyDigest: digest.optional(),
  configurationDigest: digest.optional(),
  upstreamBindingDigest: digest.optional(),
  evidenceRef: evidenceRef.optional(),
}).strict();

const startupContractFields = {
  credentialMode: z.literal('startup_short_lived'),
  delivery: z.literal('memory_ipc'),
  upstreamEnforcesExpiry: z.literal(true),
  upstreamEnforcesBinding: z.literal(true),
  imageDigest: digest,
  launcherDigest: digest,
  dependencyDigest: digest,
  configurationDigest: digest,
  upstreamBindingDigest: digest,
  evidenceRef,
};

// Keep renewable startup capabilities separate from single-use per-call leases.
// Checking this shape permits review only; it does not qualify a launcher or issue material.
export const startupCredentialContractSchema = z.discriminatedUnion('materialKind', [
  z.object({ ...startupContractFields, materialKind: z.literal('startup_capability'),
    maxLifetimeSeconds: z.int().positive().max(30),
    renewal: z.literal('memory_provider') }).strict(),
  z.object({ ...startupContractFields, materialKind: z.literal('oauth_access'),
    maxLifetimeSeconds: z.int().positive().max(600),
    renewal: z.enum(['memory_provider', 'controlled_restart']) }).strict(),
]);
export type StartupCredentialContract = z.infer<typeof startupCredentialContractSchema>;
