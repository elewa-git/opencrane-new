// A tiny OpenFGA client using plain fetch. Plain-English: this talks to the
// OpenFGA server over its HTTP API to set up a store, write one relation
// ("operator": a user operates an assistant), and check it.

import { URLS } from "../shared/ports.js";

export interface OpenFgaHandle {
  storeId: string;
  modelId: string;
}

const AUTH_MODEL = {
  schema_version: "1.1",
  type_definitions: [
    { type: "user", relations: {}, metadata: undefined },
    {
      type: "assistant",
      relations: { operator: { this: {} } },
      metadata: {
        relations: {
          operator: { directly_related_user_types: [{ type: "user" }] },
        },
      },
    },
  ],
};

async function fga<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${URLS.openfga}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenFGA ${path} -> ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/** Create a fresh store and authorization model. Called once at boot. */
export async function bootstrapOpenFga(): Promise<OpenFgaHandle> {
  const store = await fga<{ id: string }>("/stores", {
    method: "POST",
    body: JSON.stringify({ name: `s0-2-gateway-${Date.now()}` }),
  });
  const model = await fga<{ authorization_model_id: string }>(
    `/stores/${store.id}/authorization-models`,
    { method: "POST", body: JSON.stringify(AUTH_MODEL) },
  );
  return { storeId: store.id, modelId: model.authorization_model_id };
}

export async function writeOperatorTuple(handle: OpenFgaHandle, user: string, assistant: string): Promise<void> {
  await fga(`/stores/${handle.storeId}/write`, {
    method: "POST",
    body: JSON.stringify({
      writes: {
        tuple_keys: [{ user: `user:${user}`, relation: "operator", object: `assistant:${assistant}` }],
      },
    }),
  });
}

export async function deleteOperatorTuple(handle: OpenFgaHandle, user: string, assistant: string): Promise<void> {
  await fga(`/stores/${handle.storeId}/write`, {
    method: "POST",
    body: JSON.stringify({
      deletes: {
        tuple_keys: [{ user: `user:${user}`, relation: "operator", object: `assistant:${assistant}` }],
      },
    }),
  });
}

/**
 * Checks "does this user operate this assistant?" -- the "requester ∩
 * assistant" rule from the plan. Any failure (network error, timeout,
 * non-200) is the caller's job to treat as a deny (fail closed); this
 * function only throws or returns a plain boolean.
 */
export async function checkOperator(handle: OpenFgaHandle, user: string, assistant: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await fga<{ allowed: boolean }>(`/stores/${handle.storeId}/check`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        tuple_key: { user: `user:${user}`, relation: "operator", object: `assistant:${assistant}` },
        authorization_model_id: handle.modelId,
        // Ask OpenFGA for its strongest consistency, since the plan requires
        // "higher consistency after a recent revocation" -- we always want
        // the freshest answer here, not an eventually-consistent cache.
        consistency: "HIGHER_CONSISTENCY",
      }),
    });
    return result.allowed === true;
  } finally {
    clearTimeout(timer);
  }
}
