const acceptedHostMeasurements = new Set(['nodeSwaps', 'swapCgroups', 'hostCorePattern']);
const acceptedHostResult = 'ACCEPTED (dev box, owner 12 Oct, #366)';

export function finishQualification(evidence) {
  const failures = [];
  const missing = [];
  function requireResult(name, result, accepted = false) {
    if (result === 'PASS' || accepted) return;
    if (result === 'NOT RUN') missing.push(name);
    else failures.push(name);
  }
  for (const [name, value] of Object.entries(evidence.checks)) {
    requireResult(name, value.result);
  }
  for (const [name, value] of Object.entries(evidence.measurements)) {
    const accepted = acceptedHostMeasurements.has(name) && value.result === 'ACCEPTED';
    requireResult(name, value.result, accepted);
  }
  for (const [name, value] of Object.entries(evidence.conditions)) {
    if (name === 'F3') continue;
    const accepted = (name === 'F1' || name === 'F2') && value.result === acceptedHostResult;
    requireResult(name, value.result, accepted);
    if (value.guest !== undefined) requireResult(`${name} guest`, value.guest);
  }
  if (evidence.error || evidence.infrastructure) failures.push('infrastructure');
  let result = 'PASS';
  if (failures.length > 0) result = 'FAIL';
  else if (missing.length > 0) result = 'NOT RUN';
  evidence.conditions.F3 = { result, failing: failures, missing };
  evidence.result = result;
  process.exitCode = result === 'PASS' ? 0 : 1;
}
