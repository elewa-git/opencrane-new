import { personalConnectionCreation, type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

async function create(db: Query) {
  await db.query(`CREATE TABLE IF NOT EXISTS connection_profiles (
    silo TEXT NOT NULL, member_id TEXT NOT NULL, server_id TEXT NOT NULL,
    profile_id TEXT NOT NULL, position BIGINT NOT NULL,
    PRIMARY KEY (silo, member_id, server_id, profile_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS connection_profiles_page
    ON connection_profiles (silo, member_id, server_id, position)`);
}

async function drop(db: Query) {
  await db.query('DROP TABLE IF EXISTS connection_profiles');
}

async function apply(db: Query, event: EventEnvelope, position: number) {
  const profile = personalConnectionCreation(event);
  if (!profile) return;
  // Keep only the first saved creation position. Current state comes from event history.
  await db.query(`INSERT INTO connection_profiles
    (silo, member_id, server_id, profile_id, position) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING`,
  [event.silo, profile.userId, profile.serverId, profile.profile, position]);
}

export const connectionProfiles: Projection = { name: 'connection-profiles', create, drop, apply };
