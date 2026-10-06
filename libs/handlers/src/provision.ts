import { connectNats, createEventStore } from "@opencrane/event-store";
import { provisionDispatcher } from "./dispatcher.ts";

// Run this setup job with command credentials; reader services must not run it.
const connection = await connectNats();
try {
  const store = await createEventStore(connection);
  await store.ensureStream({ replicas: Number(process.env["NATS_REPLICAS"] ?? 3) });
  await provisionDispatcher(connection);
} finally {
  await connection.close();
}
