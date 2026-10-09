import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import * as projections from '@opencrane/projections';
import type { Db } from '@opencrane/projections';
import { replay } from '../src/replay.ts';

afterEach(function restoreMocks() {
  vi.restoreAllMocks();
});

it('refuses memory replay with --verify before connecting to outside services',
  async function verifyRefused() {
    const args = ['memory', '--confirm-memory-stopped', '--verify'];
    await expect(replay(args, {})).rejects.toThrow('does not support --verify');
  });

it('refuses memory replay without a database lock before any table writes',
  async function lockRefused() {
    const nats = await natsFixture();
    const directory = await mkdtemp('/tmp/memory-replay-lock-');
    const databaseWork = vi.fn();
    function query<Row extends Record<string, unknown>>(): Promise<{ rows: Row[] }> {
      databaseWork();
      return Promise.reject(new Error('Unexpected database query'));
    }
    function transaction<Result>(): Promise<Result> {
      databaseWork();
      return Promise.reject(new Error('Unexpected database transaction'));
    }
    const close = vi.fn().mockResolvedValue(undefined);
    const db: Db = { query, transaction };
    const database = { db, close };
    vi.spyOn(projections, 'connectProjectionDb').mockReturnValue(database);
    try {
      const env = { ...nats.env('projection'), DATABASE_URL: 'fixture',
        MEMORY_KEY_DIRECTORY: directory };
      await expect(replay(['memory', '--confirm-memory-stopped'], env))
        .rejects.toThrow('requires projection locking');
      expect(databaseWork).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await nats.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
