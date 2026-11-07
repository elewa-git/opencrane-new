// Return fixed messages so failed measurements cannot expose paths or observed values.
export const protectionMessages = {
  swap_measurement_failed: 'Container swap protection could not be measured.',
  swap_not_disabled: 'Container swap allowance and current use must both be zero.',
  memory_limit_unproved: 'A finite positive container memory limit could not be proved.',
  crash_kernel_unproved: 'A disabled kernel crash dump could not be proved.',
  core_pattern_unreadable: 'kernel.core_pattern could not be read as a known setting.',
  suid_dumpable_unreadable: 'fs.suid_dumpable could not be read as a known setting.',
  core_helper_enabled:
    'kernel.core_pattern sends core dumps to a helper program while fs.suid_dumpable is not 0.',
  core_limit_measurement_failed: 'The runner core dump limits could not be measured.',
  core_limit_not_zero: 'The runner soft and hard core dump limits must both be zero.',
  dumpability_measurement_failed: 'The runner dumpability could not be measured.',
  dumpability_protection_failed: 'The runner could not disable process dumps.',
  process_dumpable: 'The runner is still dumpable.',
  process_identity_changed: 'The runner identity changed after dump protection was set.',
  helper_unavailable: 'The native runner protection helper is unavailable.',
  private_process_missing: 'A required private-text process has no live protection proof.',
  private_process_unreadable: 'A private-text process identity could not be read.',
  private_process_identity_changed: 'A private-text process identity changed during measurement.',
};
export type ProtectionFailure = keyof typeof protectionMessages;
export function isProtectionFailure(value: unknown): value is ProtectionFailure {
  return typeof value === 'string' && Object.hasOwn(protectionMessages, value);
}
