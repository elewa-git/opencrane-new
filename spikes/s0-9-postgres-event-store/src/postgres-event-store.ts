import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { EventEnvelope } from '@opencrane/events';
import {
  matchesConversationRead, sameCommand, validateCommand, wireSubject,
  type AppendCommand, type AppendResult, type StoredEvent,
} from '../../../libs/event-store/src/contract.ts';
import {
  appendResult, previousAppend, recoverAppend, rejectedAppend, savedAppend, unavailableAppend,
} from '../../../libs/event-store/src/append-result.ts';

export type PostgresAppendCommand = AppendCommand & {
  /** List only the small streams that grant access, never conversation activity. */
  accessSubjects?: readonly string[];
};

type EventRow = { position: string; subject: string; event: EventEnvelope };
type Database = Pool | PoolClient;
export type AccessPosition = { subject: string; sequence: number };

function requireTime(deadline: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (performance.now() >= deadline) {
    throw new Error('Event store deadline expired');
  }
}

function storedEvent(row: EventRow): StoredEvent {
  const sequence = Number(row.position);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('Invalid event position');
  }
  return { sequence, event: row.event };
}

function subjectPattern(subject: string) {
  const category = /^(chat-state|[a-z]+)-\*$/u.exec(subject);
  if (category) {
    return `${category[1]}-%`;
  }
  wireSubject(subject);
  return undefined;
}

async function latest(database: Database, subject?: string) {
  let sql = 'SELECT COALESCE(MAX(position), 0)::text AS position FROM events';
  const values: string[] = [];
  if (subject !== undefined) {
    const pattern = subjectPattern(subject);
    sql += pattern ? ' WHERE subject LIKE $1' : ' WHERE subject = $1';
    values.push(pattern ?? subject);
  }
  const result = await database.query<{ position: string }>(sql, values);
  const position = Number(result.rows[0]!.position);
  if (!Number.isSafeInteger(position)) {
    throw new Error('Invalid event position');
  }
  return position;
}

async function releaseTransaction(client: PoolClient, open: boolean,
  discard: boolean, failure: unknown) {
  let discardConnection = discard;
  try {
    if (open) {
      await client.query('ROLLBACK');
    }
  } catch (rollbackCause) {
    discardConnection = true;
    if (failure === undefined) {
      throw rollbackCause;
    }
    const causes = [failure, rollbackCause];
    const options = { cause: failure };
    throw new AggregateError(causes, 'Transaction and rollback failed', options);
  } finally {
    client.release(discardConnection);
  }
}

export class PostgresEventStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async ensureStream(_options: { replicas?: number } = {}): Promise<void> {
    if (_options.replicas !== undefined && _options.replicas !== 1) {
      throw new Error('This experiment does not configure PostgreSQL replication');
    }
    await this.pool.query(`CREATE TABLE IF NOT EXISTS events (
      position bigint PRIMARY KEY, subject text NOT NULL, event jsonb NOT NULL
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS events_subject ON events(subject, position)');
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS events_id ON events((event->>'id'))`);
  }

  async append(command: PostgresAppendCommand): Promise<AppendResult> {
    const event = validateCommand(command);
    if (!event) {
      return rejectedAppend('invalid_event');
    }
    const deadline = Math.min(command.deadline ?? Infinity, performance.now() + 10_000);
    let committed = false;
    try {
      requireTime(deadline, command.signal);
      if (!command.historyChecked) {
        const previous = await previousAppend(this.readStream(event.subject, 1, deadline), event);
        if (previous) {
          return previous;
        }
      }
      const positions: AccessPosition[] = [];
      const accessSubjects = [...new Set(command.accessSubjects ?? [])];
      for (const subject of accessSubjects) {
        wireSubject(subject);
        const sequence = await this.head(subject, deadline);
        const position = { subject, sequence };
        positions.push(position);
      }
      await command.checkAccess?.();
      requireTime(deadline, command.signal);
      const result = await this.transact(command, event, positions, deadline);
      committed = result.status === 'appended';
      if (result.status === 'conflict') {
        const fromSequence = command.historyChecked ? command.expectedSequence + 1 : 1;
        const rows = this.readStream(event.subject, fromSequence, deadline);
        return await recoverAppend(rows, event, command.expectedSequence, false);
      }
      return result;
    } catch (cause) {
      // Keep the database error for the caller; a failed COMMIT can have saved the event.
      return unavailableAppend(cause, committed || cause instanceof UncertainCommit);
    }
  }

  private async transact(command: PostgresAppendCommand, event: EventEnvelope,
    positions: AccessPosition[], deadline: number): Promise<AppendResult> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    let discardConnection = false;
    let failure: unknown;
    try {
      requireTime(deadline, command.signal);
      await client.query('BEGIN');
      transactionOpen = true;
      const timeoutMs = Math.max(1, Math.floor(deadline - performance.now()));
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
      // Hold one lock through COMMIT. MAX + 1 then follows commit order without sequence gaps.
      // This serialises all appends and is a deliberate throughput ceiling of this experiment.
      await client.query('SELECT pg_advisory_xact_lock(1094)');
      requireTime(deadline, command.signal);
      const duplicate = await this.duplicate(client, event);
      if (duplicate) {
        return duplicate;
      }
      const allowed = await this.conditions(client, command, positions, event);
      if (!allowed) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { status: 'conflict' };
      }
      const sequence = await latest(client) + 1;
      await client.query('INSERT INTO events VALUES ($1, $2, $3)', [sequence, event.subject, event]);
      requireTime(deadline, command.signal);
      // Drop the connection after an uncertain COMMIT; another statement cannot disprove it.
      transactionOpen = false;
      try {
        await client.query('COMMIT');
      } catch (cause) {
        discardConnection = true;
        const options = { cause };
        throw new UncertainCommit('Commit reply unavailable', options);
      }
      const result = { status: 'appended' as const, sequence };
      const outcome = { kind: 'appended' as const };
      return appendResult(result, outcome);
    } catch (cause) {
      failure = cause;
      throw cause;
    } finally {
      await releaseTransaction(client, transactionOpen, discardConnection, failure);
    }
  }

  private async duplicate(client: PoolClient, event: EventEnvelope) {
    const result = await client.query<EventRow>("SELECT * FROM events WHERE event->>'id' = $1",
      [event.id]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const saved = storedEvent(row);
    if (!sameCommand(saved.event, event)) {
      return rejectedAppend('duplicate_id');
    }
    return savedAppend(saved);
  }

  private async conditions(client: PoolClient, command: PostgresAppendCommand,
    positions: AccessPosition[], event: EventEnvelope) {
    const subject = command.expectedSubject ?? event.subject;
    if (await latest(client, subject) !== command.expectedSequence) {
      return false;
    }
    if (command.expectedGlobalSequence !== undefined &&
        await latest(client) !== command.expectedGlobalSequence) {
      return false;
    }
    if (event.type === 'conversation.created' && await latest(client, event.subject) !== 0) {
      return false;
    }
    for (const position of positions) {
      if (await latest(client, position.subject) !== position.sequence) {
        return false;
      }
    }
    return true;
  }

  async readEvent(sequence: number, deadline = Infinity): Promise<StoredEvent> {
    requireTime(deadline);
    const result = await this.pool.query<EventRow>('SELECT * FROM events WHERE position = $1',
      [sequence]);
    requireTime(deadline);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Event position missing');
    }
    return storedEvent(row);
  }

  async *readStream(subject: string, fromSequence = 1, deadline = Infinity,
    includeConversationCloses = false): AsyncGenerator<StoredEvent> {
    requireTime(deadline);
    const snapshot = await this.head(undefined, deadline);
    const pattern = subjectPattern(subject);
    let predicate = pattern ? 'subject LIKE $1' : 'subject = $1';
    const subjects = [pattern ?? subject];
    if (includeConversationCloses) {
      if (!subject.startsWith('conversation-') || pattern) {
        throw new Error('Closing activity requires one conversation');
      }
      subjects.push(`participation-${subject.slice('conversation-'.length)}`);
      predicate = '(subject = $1 OR subject = $4)';
    }
    let sequence = Math.max(1, fromSequence);
    while (sequence <= snapshot) {
      const values: (string | number)[] = [subjects[0]!, sequence, snapshot];
      if (subjects[1]) {
        values.push(subjects[1]);
      }
      const sql = `SELECT * FROM events WHERE ${predicate}
        AND position >= $2 AND position <= $3 ORDER BY position LIMIT 256`;
      const result = await this.pool.query<EventRow>(sql, values);
      requireTime(deadline);
      if (result.rows.length === 0) {
        return;
      }
      for (const row of result.rows) {
        sequence = Number(row.position) + 1;
        if (!includeConversationCloses || matchesConversationRead(row.event, subject)) {
          yield storedEvent(row);
        }
      }
    }
  }

  async subjectCount(deadline = Infinity): Promise<number> {
    requireTime(deadline);
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(DISTINCT subject)::text AS count FROM events');
    requireTime(deadline);
    return Number(result.rows[0]!.count);
  }

  async *subscribe(fromSequence = 1, signal?: AbortSignal): AsyncGenerator<StoredEvent> {
    let sequence = Math.max(1, fromSequence);
    while (!signal?.aborted) {
      const result = await this.pool.query<EventRow>(
        'SELECT * FROM events WHERE position >= $1 ORDER BY position LIMIT 256', [sequence]);
      for (const row of result.rows) {
        if (signal?.aborted) {
          return;
        }
        if (Number(row.position) !== sequence) {
          throw new Error('Event sequence gap');
        }
        yield storedEvent(row);
        sequence += 1;
      }
      if (result.rows.length === 0) {
        await delay(100);
      }
    }
  }

  async head(subject?: string, deadline = Infinity,
    includeConversationCloses = false): Promise<number> {
    requireTime(deadline);
    if (includeConversationCloses && subject !== undefined) {
      let sequence = 0;
      for await (const row of this.readStream(subject, 1, deadline, true)) {
        sequence = row.sequence;
      }
      return sequence;
    }
    const sequence = await latest(this.pool, subject);
    requireTime(deadline);
    return sequence;
  }
}

class UncertainCommit extends Error {}
