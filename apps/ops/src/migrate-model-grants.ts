import { connectEventStore } from '@opencrane/event-store';
import { migrateModelGrants } from '@opencrane/models';

const silo = process.env['SILO_ID']?.trim();
if (!silo) throw new Error('SILO_ID is required');
const connection = await connectEventStore();
try {
  await migrateModelGrants(connection.store, silo);
} finally {
  await connection.close();
}
