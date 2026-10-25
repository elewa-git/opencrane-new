import type { StreamConfig } from "@nats-io/jetstream";

// StreamInfo leaves out some default settings. Treat a missing setting as its default.
const defaults = {
  sealed: false,
  no_ack: false,
  discard_new_per_subject: false,
  allow_rollup_hdrs: false,
  allow_msg_ttl: false,
  allow_msg_counter: false,
  allow_msg_schedules: false,
  allow_atomic: false,
  allow_batched: false,
  mirror_direct: false,
  subject_delete_marker_ttl: 0,
  persist_mode: "default",
} satisfies Partial<StreamConfig>;

export function eventsConfig(replicas: number) {
  return {
    name: "EVENTS",
    subjects: ["ev.>"],
    storage: "file",
    retention: "limits",
    num_replicas: replicas,
    max_consumers: -1,
    max_msg_size: -1,
    max_msgs: -1,
    max_msgs_per_subject: -1,
    max_bytes: -1,
    max_age: 0,
    discard: "old",
    duplicate_window: 120_000_000_000,
    deny_delete: true,
    deny_purge: true,
    ...defaults,
  } satisfies Partial<StreamConfig>;
}

// Make this list fail type checking when the SDK adds a configuration field.
type OtherChecks = {
  [Key in Exclude<keyof StreamConfig, keyof ReturnType<typeof eventsConfig>>]-?:
    (config: StreamConfig) => boolean;
};
const otherChecks = {
  mirror: ({ mirror }) => mirror === undefined,
  sources: ({ sources }) => sources === undefined,
  republish: ({ republish }) => republish === undefined,
  subject_transform: ({ subject_transform }) => subject_transform === undefined,
  consumer_limits: ({ consumer_limits }) =>
    (consumer_limits?.inactive_threshold ?? 0) === 0 &&
    (consumer_limits?.max_ack_pending ?? 0) === 0,
  first_seq: ({ first_seq }) =>
    first_seq === undefined || first_seq === 0 || first_seq === 1,
  compression: ({ compression }) =>
    compression === undefined || compression === "none" || compression === "s2",
  allow_direct: () => true,
  description: () => true,
  metadata: () => true,
  placement: () => true,
} satisfies OtherChecks;

export function verifyEventsConfig(config: StreamConfig, replicas: number): void {
  for (const [key, expected] of Object.entries(eventsConfig(replicas))) {
    const actual: unknown = Reflect.get(config, key);
    const fallback: unknown = Reflect.get(defaults, key);
    if (JSON.stringify(actual ?? fallback) !== JSON.stringify(expected)) {
      throw new Error(`Incompatible EVENTS configuration: ${key}`);
    }
  }
  for (const [key, accepts] of Object.entries(otherChecks)) {
    if (!accepts(config)) {
      throw new Error(`Incompatible EVENTS configuration: ${key}`);
    }
  }
}

