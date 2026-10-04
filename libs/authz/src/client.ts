import { setTimeout as delay } from "node:timers/promises";
import { OpenFgaClient, ConsistencyPreference, type Store } from "@openfga/sdk";
import model from "../model/v1.json" with { type: "json" };

export interface Binding {
  apiUrl: string;
  storeId: string;
  authorizationModelId: string;
  silo: string;
}
export interface Tuple {
  user: string;
  relation: string;
  object: string;
}
const consistent = { consistency: ConsistencyPreference.HigherConsistency };
const lostCreateCleanupDelayMs = 250;

export function objectId(type: string, ...ids: string[]): string {
  return `${type}:${Buffer.from(JSON.stringify(ids)).toString("base64url")}`;
}

function sdk(apiUrl: string, binding?: Binding) {
  return new OpenFgaClient({
    apiUrl,
    ...(binding && {
      storeId: binding.storeId,
      authorizationModelId: binding.authorizationModelId,
    }),
    // pg-boss owns retries. Each HTTP call has a finite one-second deadline.
    retryParams: { maxRetry: 0 },
    baseOptions: { timeout: 1000 },
  });
}

/** Provisioning writes only the model. Relationship writes belong to the handler. */
export async function createStore(
  apiUrl: string,
  silo: string,
  storeName = `members-${silo}`,
): Promise<Binding> {
  const client = sdk(apiUrl);
  let storeId: string | undefined;
  try {
    const store = await client.createStore({ name: storeName });
    storeId = store.id;
    client.storeId = storeId;
    const written = await client.writeAuthorizationModel({
      ...model,
      type_definitions: model.type_definitions.map(({ metadata, ...type }) => ({
        ...type,
        ...(metadata && { metadata }),
      })),
    });
    return {
      apiUrl,
      silo,
      storeId,
      authorizationModelId: written.authorization_model_id,
    };
  } catch (error) {
    let deleted = false;
    try {
      if (storeId) {
        await client.deleteStore();
        deleted = true;
      } else if (storeName !== `members-${silo}`) {
        deleted = (await deleteStoresNamed(apiUrl, storeName)) > 0;
        if (!deleted) {
          await delay(lostCreateCleanupDelayMs);
          deleted = (await deleteStoresNamed(apiUrl, storeName)) > 0;
        }
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `OpenFGA model creation and store cleanup failed. ${manualCleanup(storeName, storeId)}`,
        { cause: cleanupError },
      );
    }
    if (!storeId && storeName !== `members-${silo}` && !deleted) {
      throw new Error(
        `OpenFGA store creation failed before returning an id. ${manualCleanup(storeName)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function manualCleanup(name: string, id = "<id>"): string {
  return `If rebuild store "${name}" appears later, delete it with: npm run replay -- openfga --delete-store ${id}`;
}

async function stores(apiUrl: string): Promise<Store[]> {
  const client = sdk(apiUrl);
  const listed: Store[] = [];
  let token = "";
  do {
    const response = await client.listStores({ pageSize: 100, continuationToken: token });
    listed.push(...response.stores);
    token = response.continuation_token;
  } while (token);
  return listed;
}

async function deleteStoresNamed(
  apiUrl: string,
  name: string,
): Promise<number> {
  const client = sdk(apiUrl);
  const matches = (await stores(apiUrl)).filter((candidate) => candidate.name === name).map(({ id }) => id);
  for (const storeId of matches) await client.deleteStore({ storeId });
  return matches.length;
}

export async function listRebuildStores(
  apiUrl: string,
  prefix: string,
): Promise<Array<{ id: string; name: string; createdAt: string }>> {
  return (await stores(apiUrl))
    .filter(({ name }) => name.startsWith(prefix))
    .map(({ id, name, created_at: createdAt }) => ({ id, name, createdAt }));
}

export async function deleteStoreById(apiUrl: string, storeId: string): Promise<void> {
  await sdk(apiUrl).deleteStore({ storeId });
}

export async function deleteStore(binding: Binding): Promise<void> {
  await sdk(binding.apiUrl, binding).deleteStore();
}

export class TupleClient {
  private readonly client: OpenFgaClient;
  constructor(binding: Binding) {
    this.client = sdk(binding.apiUrl, binding);
  }

  async read(filter: Partial<Tuple>): Promise<Tuple[]> {
    const tuples: Tuple[] = [];
    let token = "";
    do {
      const response = await this.client.read(filter, {
        ...consistent,
        pageSize: 100,
        continuationToken: token,
      });
      tuples.push(...response.tuples.map(({ key }) => key));
      token = response.continuation_token;
    } while (token);
    return tuples;
  }

  async check(tuple: Tuple) {
    try {
      const response = await this.client.check(tuple, consistent);
      return { allowed: response.allowed === true, status: "ok" as const };
    } catch (cause) {
      return {
        allowed: false as const,
        status: "unavailable" as const,
        error: new Error("Authorisation check unavailable", { cause }),
      };
    }
  }

  /** Require every exact tuple; a missing answer or failed check refuses the batch. */
  async checkAll(tuples: Tuple[]) {
    try {
      function correlatedCheck(tuple: Tuple, index: number) {
        return { ...tuple, correlationId: String(index) };
      }
      const checks = tuples.map(correlatedCheck);
      const response = await this.client.batchCheck({ checks }, consistent);
      const answers = new Map<string, (typeof response.result)[number]>();
      for (const result of response.result) answers.set(result.correlationId, result);
      let allowed = true;
      let failedCheck: (typeof response.result)[number] | undefined;
      for (let index = 0; index < tuples.length; index++) {
        const answer = answers.get(String(index));
        if (answer?.error) {
          failedCheck = answer;
        } else if (!answer?.allowed) {
          allowed = false;
        }
      }
      // A failed item grants no authority, but cannot hide an explicit denial beside it.
      if (allowed && failedCheck) {
        throw new Error('Authorisation batch item unavailable', { cause: failedCheck.error });
      }
      return { allowed, status: 'ok' as const };
    } catch (cause) {
      return { allowed: false as const, status: 'unavailable' as const, error: new Error('Authorisation checks unavailable', { cause }) };
    }
  }

  /** One atomic transaction, including the event receipt; duplicate receipts must fail. */
  async write(writes: Tuple[], deletes: Tuple[]): Promise<void> {
    await this.client.write({ writes, deletes });
  }
}
