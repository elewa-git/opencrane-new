import { OpenFgaClient, ConsistencyPreference } from "@openfga/sdk";
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
): Promise<Binding> {
  const client = sdk(apiUrl);
  const store = await client.createStore({ name: `members-${silo}` });
  client.storeId = store.id;
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
    storeId: store.id,
    authorizationModelId: written.authorization_model_id,
  };
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

  /** One atomic transaction, including the event receipt; duplicate receipts must fail. */
  async write(writes: Tuple[], deletes: Tuple[]): Promise<void> {
    await this.client.write({ writes, deletes });
  }
}
