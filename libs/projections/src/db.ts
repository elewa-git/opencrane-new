export interface Query {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
}
export interface Db extends Query {
  transaction<T>(work: (transaction: Query) => Promise<T>): Promise<T>;
}
