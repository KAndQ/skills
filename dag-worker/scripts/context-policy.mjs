// Portable adaptive context contract, mirrored in dag-worker and checked for parity.
// These functions consume evidence supplied by a host/caller; they provide no telemetry.
export const CONTEXT_COMPONENTS = ['fixed_instructions', 'source_reading', 'dependency_inputs', 'tool_output', 'working', 'delivery'];
const LEGACY_LIMITS = ['model_context_tokens', 'target_tokens', 'soft_limit_tokens', 'hard_limit_tokens', 'reserve_tokens'];
const DIMENSIONS = ['context', 'input', 'output', 'remaining', 'cumulative', 'headroom'];
const SOURCES = ['model', 'host', 'user', 'platform', 'planner', 'unknown'];
const CONFIDENCE = ['verified', 'explicit', 'estimated', 'unknown'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const optionalText = value => value === undefined || value === null || text(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
export const contextRange = value => Array.isArray(value) && value.length === 2 && value.every(count) && value[0] <= value[1];
const strings = value => Array.isArray(value) && value.every(text);
const unknownOrRange = value => value === undefined || value === null || contextRange(value);
const tokensOf = value => object(value) ? value.tokens : value;

function constraintErrors(constraints, errors) {
  if (constraints === undefined) return;
  if (!Array.isArray(constraints)) { errors.push({ code: 'CONTEXT_CONSTRAINT', message: 'constraints must be an array' }); return; }
  for (const item of constraints) {
    if (!object(item) || !DIMENSIONS.includes(item.dimension) || !(item.tokens === null || count(item.tokens)) ||
      !SOURCES.includes(item.source) || !CONFIDENCE.includes(item.confidence) || !optionalText(item.evidence)) {
      errors.push({ code: 'CONTEXT_CONSTRAINT', message: 'Constraint needs dimension, nonnegative tokens/null, source, confidence and valid evidence when supplied' });
    }
  }
}

export function contextObservationErrors(observation) {
  const errors = [];
  if (!object(observation)) return [{ code: 'CONTEXT_OBSERVATION', message: 'Observation must be a mapping' }];
  for (const key of ['current_peak_tokens', 'projected_peak_tokens', 'remaining_work_tokens']) {
    if (!unknownOrRange(observation[key])) errors.push({ code: 'CONTEXT_OBSERVATION', message: `${key} must be a range or unknown` });
  }
  if (observation.minimum_required_tokens !== undefined) {
    if (!object(observation.minimum_required_tokens) || Object.entries(observation.minimum_required_tokens).some(([key, value]) =>
      !DIMENSIONS.includes(key) || key === 'headroom' || !unknownOrRange(value))) errors.push({ code: 'CONTEXT_OBSERVATION', message: 'minimum_required_tokens must map dimensions to supported minimum ranges or null' });
  }
  if (observation.optimization_attempts !== undefined && !strings(observation.optimization_attempts)) errors.push({ code: 'CONTEXT_OBSERVATION', message: 'optimization_attempts must be a string array' });
  if (!optionalText(observation.evidence)) errors.push({ code: 'CONTEXT_OBSERVATION', message: 'Observation evidence must be substantive text or unknown' });
  if (observation.capacity_signal !== undefined) {
    const signal = observation.capacity_signal;
    if (!object(signal) || !SOURCES.includes(signal.source) || !CONFIDENCE.includes(signal.confidence) ||
      !['CONTEXT_EXHAUSTED', 'INPUT_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'RESOURCE_UNAVAILABLE'].includes(signal.code) || !text(signal.evidence)) {
      errors.push({ code: 'CONTEXT_OBSERVATION', message: 'capacity_signal needs a source, confidence, supported code and evidence' });
    }
  }
  constraintErrors(observation.constraints, errors);
  return errors;
}

function estimateErrors(estimate, legacy, errors, warnings) {
  if (estimate === undefined) return;
  if (!object(estimate)) { errors.push({ code: 'CONTEXT_ESTIMATE', message: 'estimate must be a mapping' }); return; }
  if (estimate.confidence !== undefined && !['unknown', 'low', 'medium', 'high'].includes(estimate.confidence)) errors.push({ code: 'CONTEXT_ESTIMATE', message: 'Unknown estimate confidence' });
  if (!optionalText(estimate.basis)) errors.push({ code: 'CONTEXT_ESTIMATE', message: 'basis must be substantive text or unknown' });
  if (estimate.components !== undefined && !object(estimate.components)) errors.push({ code: 'CONTEXT_ESTIMATE', message: 'components must be a mapping' });
  const components = object(estimate.components) ? estimate.components : {};
  for (const key of CONTEXT_COMPONENTS) {
    const value = components[key], tokens = tokensOf(value);
    if (!(value === undefined || value === null || text(value) || contextRange(value) || (object(value) && unknownOrRange(tokens) &&
      optionalText(value.basis) && optionalText(value.risk)))) {
      errors.push({ code: 'CONTEXT_ESTIMATE', message: `${key} needs a range, qualitative basis/risk or unknown value` });
    }
  }
  for (const key of ['peak_tokens', 'cumulative_tokens']) if (!unknownOrRange(estimate[key])) errors.push({ code: 'CONTEXT_ESTIMATE', message: `${key} must be a range or unknown` });
  if (legacy && CONTEXT_COMPONENTS.every(key => contextRange(components[key])) && contextRange(estimate.peak_tokens)) {
    const sum = [0, 1].map(index => CONTEXT_COMPONENTS.reduce((total, key) => total + components[key][index], 0));
    if (sum.some((value, index) => value !== estimate.peak_tokens[index])) errors.push({ code: 'CONTEXT_PEAK_SUM', message: 'Legacy numeric envelope must equal its six numeric components' });
  }
  if (contextRange(estimate.peak_tokens) && contextRange(estimate.cumulative_tokens) && estimate.cumulative_tokens.some((value, index) => value < estimate.peak_tokens[index])) {
    errors.push({ code: 'CONTEXT_CUMULATIVE', message: 'Cumulative bounds cannot be below corresponding peak bounds' });
  }
  if (!text(estimate.basis) || CONTEXT_COMPONENTS.some(key => !contextRange(tokensOf(components[key]))) || !contextRange(estimate.peak_tokens)) {
    warnings.push({ code: 'CONTEXT_ESTIMATE_UNCERTAIN', message: 'Unknown/qualitative costs are valid; record reasoning, load selectively and revisit as work changes' });
  }
}

export function validateContext(task = {}) {
  const errors = [], warnings = [];
  for (const key of ['context_management', 'context_budget']) {
    const value = task[key];
    if (value === undefined) continue;
    if (!object(value)) { errors.push({ code: 'CONTEXT_SCHEMA', message: `${key} must be a mapping` }); continue; }
    if (key === 'context_management' && value.mode !== undefined && value.mode !== 'adaptive') errors.push({ code: 'CONTEXT_SCHEMA', message: 'context_management mode must be adaptive when supplied' });
    estimateErrors(value.estimate, key === 'context_budget', errors, warnings);
    constraintErrors(value.constraints, errors);
    if (value.assessment !== undefined) errors.push(...contextObservationErrors(value.assessment));
  }
  const budget = task.context_budget;
  if (object(budget)) {
    for (const key of LEGACY_LIMITS) if (budget[key] !== undefined && budget[key] !== null && !count(budget[key])) errors.push({ code: 'CONTEXT_LIMITS', message: `${key} must be a nonnegative integer or unknown when supplied` });
    if (budget.provenance !== undefined) {
      if (!object(budget.provenance)) errors.push({ code: 'CONTEXT_CONSTRAINT', message: 'Legacy provenance must be a mapping' });
      else for (const [key, provenance] of Object.entries(budget.provenance)) {
        if (!LEGACY_LIMITS.includes(key) || !object(provenance) || !(budget[key] === undefined || budget[key] === null || count(budget[key]))) errors.push({ code: 'CONTEXT_CONSTRAINT', message: 'Legacy provenance must identify a numeric or unknown budget field' });
        else constraintErrors([{ ...provenance, dimension: provenance.dimension ?? (key === 'reserve_tokens' ? 'headroom' : 'context'), tokens: budget[key] ?? null }], errors);
      }
    }
    if (LEGACY_LIMITS.some(key => count(budget[key]))) warnings.push({ code: 'LEGACY_CONTEXT_ADVISORY', message: 'Legacy numeric hints without binding provenance are estimates, not physical capacity or mandatory thresholds' });
  }
  if (task.context_management === undefined && task.context_budget === undefined) warnings.push({ code: 'CONTEXT_INFORMATION_UNKNOWN', message: 'No context metadata required; use a dynamic loading plan and preserve evidence/checkpoint options' });
  return { errors, warnings };
}

function constraintsOf(value) {
  if (!object(value)) return [];
  const constraints = Array.isArray(value.constraints) ? [...value.constraints] : [];
  if (object(value.provenance)) for (const [key, provenance] of Object.entries(value.provenance)) {
    if (LEGACY_LIMITS.includes(key) && object(provenance) && (value[key] === undefined || value[key] === null || count(value[key]))) constraints.push({ ...provenance,
      dimension: provenance.dimension ?? (key === 'reserve_tokens' ? 'headroom' : 'context'), tokens: value[key] ?? null });
  }
  return constraints;
}

function binding(item) {
  if (!count(item.tokens) || !text(item.evidence)) return false;
  if (['model', 'host'].includes(item.source)) return item.confidence === 'verified' && !['cumulative', 'headroom'].includes(item.dimension);
  return ['user', 'platform'].includes(item.source) && ['explicit', 'verified'].includes(item.confidence);
}

export function assessContext(task = {}, observation) {
  const { errors, warnings } = validateContext(task);
  const assessment = observation === undefined ? task.context_management?.assessment ?? task.context_budget?.assessment ?? {} : observation;
  errors.push(...contextObservationErrors(assessment));
  const result = { errors, warnings, blocked: false, action: 'continue' };
  if (errors.length) { result.action = 'review'; return result; }
  const constraints = [...constraintsOf(task.context_budget), ...constraintsOf(task.context_management), ...constraintsOf(assessment)];
  const real = constraints.filter(binding);
  if (constraints.some(item => !binding(item))) warnings.push({ code: 'CONTEXT_CONSTRAINT_UNVERIFIED', message: 'Constraints with unknown/estimated provenance need review and do not establish a capacity failure' });
  if (real.some(item => item.dimension === 'headroom' ? !contextRange(assessment.minimum_required_tokens?.remaining) ||
    !real.some(limit => limit.dimension === 'remaining' && ['host', 'model'].includes(limit.source)) :
    !contextRange(assessment.minimum_required_tokens?.[item.dimension]))) {
    warnings.push({ code: 'CONTEXT_CAPACITY_REVIEW', message: 'Real limits remain binding; unknown necessary demand/remaining capacity needs selective loading and review, not an invented success or failure' });
  }
  const optimized = strings(assessment.optimization_attempts) && assessment.optimization_attempts.length > 0;
  const supported = text(assessment.evidence);
  const signal = assessment.capacity_signal;
  const hostFailure = signal && ['host', 'platform'].includes(signal.source) && signal.confidence === 'verified';
  let shortage = Boolean(hostFailure);
  for (const constraint of real) {
    const minimum = assessment.minimum_required_tokens?.[constraint.dimension];
    if (constraint.dimension === 'headroom') {
      const remaining = real.filter(item => item.dimension === 'remaining' && ['host', 'model'].includes(item.source));
      const work = assessment.minimum_required_tokens?.remaining;
      if (contextRange(work) && remaining.some(item => work[0] + constraint.tokens > item.tokens)) shortage = true;
    } else if (contextRange(minimum) && minimum[0] > constraint.tokens) shortage = true;
  }
  const estimate = task.context_management?.estimate ?? task.context_budget?.estimate;
  const peak = assessment.projected_peak_tokens ?? estimate?.peak_tokens;
  const hints = LEGACY_LIMITS.filter(key => key !== 'reserve_tokens').map(key => task.context_budget?.[key]).filter(count);
  if (contextRange(peak) && (hints.some(value => peak[1] > value) || real.some(item => item.dimension === 'context' && peak[1] > item.tokens))) {
    warnings.push({ code: 'CONTEXT_ESTIMATE_REVIEW', message: 'Estimated upper peak alone does not establish inability to finish; adapt loading and review supported minimum needs' });
  }
  if (shortage && optimized && (supported || hostFailure)) {
    result.blocked = true; result.action = 'checkpoint_replan';
    result.reason = 'CONTEXT_BUDGET_EXCEEDED';
  } else if (shortage) warnings.push({ code: 'CONTEXT_OPTIMIZATION_REQUIRED', message: 'Respect the real constraint; narrow loading and gather remaining-work evidence before declaring this Task unable to finish' });
  else if (signal) warnings.push({ code: 'CONTEXT_SIGNAL_REVIEW', message: 'A capacity signal must come from a verified host/platform source to establish exhaustion' });
  if (!supported && !hostFailure) warnings.push({ code: 'CONTEXT_OBSERVATION_UNKNOWN', message: 'No current capacity/remaining-work evidence: unknown is neither unlimited capacity nor automatic permanent blocking' });
  if (!result.blocked && warnings.length) result.action = 'review';
  return result;
}
