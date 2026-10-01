import { expect, it } from "vitest";
import { createInbox } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  type StreamInfo,
} from "@nats-io/jetstream";
import { event, natsFixture } from "./testing.ts";

it("recognises command history after a native JetStream snapshot is restored on a fresh server", async () => {
  const original = await natsFixture();
  const restored = await natsFixture();
  try {
    const command = event("restored-command");
    await original.store.append({ event: command, expectedSequence: 0 });
    await original.store.append({
      event: event("later-command"),
      expectedSequence: 1,
    });
    const before = await Array.fromAsync(
      original.store.readStream("member-alice"),
    );
    const inbox = createInbox();
    const subscription = original.connection.subscribe(inbox);
    const chunks: Uint8Array[] = [];
    const snapshot = (async () => {
      for await (const message of subscription) {
        message.respond();
        if (!message.data.length) {
          break;
        }
        chunks.push(message.data);
      }
    })();
    const response = await original.connection.request(
      "$JS.API.STREAM.SNAPSHOT.EVENTS",
      JSON.stringify({
        deliver_subject: inbox,
        chunk_size: 1024,
        no_consumers: true,
      }),
    );
    const info = response.json<StreamInfo>();
    await snapshot;
    subscription.unsubscribe();
    const manager = await jetstreamManager(restored.connection);
    await manager.streams.delete("EVENTS");
    const restore = await restored.connection.request(
      "$JS.API.STREAM.RESTORE.EVENTS",
      JSON.stringify({ config: info.config, state: info.state }),
    );
    const { deliver_subject: deliverSubject } = restore.json<{
      deliver_subject: string;
    }>();
    expect(deliverSubject).toBeTruthy();
    for (const chunk of chunks) {
      await restored.connection.request(deliverSubject, chunk);
    }
    const finished = await restored.connection.request(
      deliverSubject,
      new Uint8Array(),
    );
    expect(finished.json<{ error?: unknown }>().error).toBeUndefined();
    expect(
      await Array.fromAsync(restored.store.readStream("member-alice")),
    ).toEqual(before);
    // Prove this restore lost server deduplication, so the history check is the protection.
    const duplicateProbe = await jetstream(restored.connection).publish(
      "ev.member.probe",
      "{}",
      { msgID: command.id },
    );
    expect(duplicateProbe.duplicate).toBe(false);
    expect(
      await restored.store.append({
        event: { ...command, id: "new-event-id" },
        expectedSequence: 2,
      }),
    ).toEqual({ status: "appended", sequence: 1 });
    expect(
      await Array.fromAsync(restored.store.readStream("member-alice")),
    ).toEqual(before);
  } finally {
    await Promise.all([original.close(), restored.close()]);
  }
}, 15_000);
