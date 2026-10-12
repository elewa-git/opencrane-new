export function finishQualification(evidence, created) {
  const failures = Object.entries(evidence.checks).filter(function failed(entry) { return entry[1].result === 'FAIL'; });
  const missing = Object.entries(evidence.checks).filter(function missing(entry) { return entry[1].result === 'NOT RUN'; });
  const measurementFailures = Object.entries(evidence.measurements).filter(function required(entry) {
    return !['PASS', 'ACCEPTED'].includes(entry[1].result);
  });
  let liveResult = 'PASS';
  const failedMeasurements = measurementFailures.filter(function failed(entry) {
    return entry[1].result === 'FAIL';
  });
  if (failures.length || failedMeasurements.length || (created && evidence.error)) liveResult = 'FAIL';
  else if (missing.length || measurementFailures.length) liveResult = 'NOT RUN';
  evidence.conditions.F3 = { result: liveResult,
    failing: failures.map(function name(entry) { return entry[0]; }),
    measurements: measurementFailures.map(function name(entry) { return entry[0]; }) };
  if (liveResult === 'PASS') {
    evidence.result = 'PASS';
  } else if (liveResult === 'FAIL') {
    evidence.result = 'FAIL';
  } else {
    evidence.result = 'PARTIAL';
  }
  function productFailure(entry) {
    const name = entry[0];
    return name.endsWith(' scans') || name.endsWith(' no repeat')
      || name.startsWith('one terminal ') || name.startsWith('private release ')
      || name.startsWith('J4 ')
      || name === 'provider isolation' || name === 'tools created no file';
  }
  if (failures.some(productFailure)) process.exitCode = 1;
}
