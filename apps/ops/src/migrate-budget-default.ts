import { connectEventStore } from '@opencrane/event-store';
import { migrateBudgetDefault } from '@opencrane/models';

const silo = process.env['SILO_ID']?.trim();
if (!silo) throw new Error('SILO_ID is required');
const connection = await connectEventStore();
try {
  await migrateBudgetDefault(connection.store, silo, process.env['DEFAULT_PAYING_GROUP_ID'] ?? 'installation-default');
} finally {
  await connection.close();
}
