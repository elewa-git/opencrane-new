export class QueryDeadlineExceeded extends Error {
  constructor() {
    super('Database read expired');
    this.name = 'QueryDeadlineExceeded';
  }
}

export interface Query {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
    options?: { deadline: number },
  ): Promise<{ rows: Row[] }>;
}
export interface Db extends Query {
  transaction<T>(work: (transaction: Query) => Promise<T>): Promise<T>;
  lock?<T>(name: string, work: (db: Db) => Promise<T>,
    options?: { timeoutMs: number; signal?: AbortSignal }): Promise<T>;
}
