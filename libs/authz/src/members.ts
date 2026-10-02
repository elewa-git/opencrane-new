import { parseEventByType, type EventEnvelope } from "@opencrane/events";
import { registerHandler } from "@opencrane/handlers";
import { objectId, TupleClient, type Binding, type Tuple } from "./client.ts";

function field(data: unknown, name: string): string {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid member data");
  }
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== "string") {
    throw new Error("Missing member field");
  }
  return value;
}

function roleTuples(user: string, object: string, role: string): Tuple[] {
  const tuples = [{ user, object, relation: "member" }];
  if (role === "owner" || role === "admin") {
    tuples.push({ user, object, relation: `${role}_role` });
  }
  return tuples;
}

function same(a: Tuple, b: Tuple): boolean {
  return (
    a.user === b.user && a.object === b.object && a.relation === b.relation
  );
}

export function memberAuthorisation(binding: Binding) {
  const client = new TupleClient(binding);
  const object = objectId("silo", binding.silo);

  async function apply(input: EventEnvelope): Promise<void> {
    const parsed = parseEventByType(input);
    if (!parsed.success || parsed.event.silo !== binding.silo) {
      throw new Error("Invalid authorisation event or silo");
    }
    const event = parsed.event;
    if (!["member.joined", "member.role_changed", "member.removed", "assistant.created"].includes(event.type)) {
      throw new Error(`OpenFGA event not implemented: ${event.type}`);
    }
    const receipt = {
      user: object,
      relation: "applied",
      object: objectId("projection_event", binding.silo, event.id),
    };
    if ((await client.read(receipt)).length) return;
    if (event.type === 'assistant.created') {
      const assistantId = field(event.data, 'assistantId');
      const ownerId = field(event.data, 'ownerId');
      if (event.subject !== `assistant-${assistantId}`) throw new Error('Assistant subject mismatch');
      await client.write([{ user: objectId('person', binding.silo, ownerId), relation: 'acts_for',
        object: objectId('assistant', binding.silo, assistantId) }, receipt], []);
      return;
    }
    const memberId = field(event.data, "memberId");
    if (event.subject !== `member-${memberId}`) {
      throw new Error("Member subject mismatch");
    }
    const user = objectId("person", binding.silo, memberId);
    const current = await client.read({ user, object });
    if (
      event.type === "member.role_changed" &&
      !current.some((t) => t.relation === "member")
    ) {
      throw new Error("Role change requires an existing member");
    }
    const desired =
      event.type === "member.removed"
        ? []
        : roleTuples(
            user,
            object,
            field(
              event.data,
              event.type === "member.joined" ? "role" : "newRole",
            ),
          );
    // A lost reply is safe: the receipt and changes either all commit or all fail.
    // Repeating an old event after removal cannot restore its previous permissions.
    await client.write(
      [...desired.filter((t) => !current.some((c) => same(t, c))), receipt],
      current.filter((t) => !desired.some((d) => same(t, d))),
    );
  }

  return {
    binding,
    handler: registerHandler("update-openfga", apply),
    check(memberId: string, relation: "member" | "admin" | "owner") {
      return client.check({
        user: objectId("person", binding.silo, memberId),
        object,
        relation,
      });
    },
    actsFor(memberId: string, assistantId: string) {
      return client.check({ user: objectId('person', binding.silo, memberId),
        object: objectId('assistant', binding.silo, assistantId), relation: 'acts_for' });
    },
  };
}
