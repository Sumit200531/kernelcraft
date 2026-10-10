/** Bumped whenever simulation semantics change: recorded trace hashes are only comparable within one version. */
export const ENGINE_VERSION = '1.0.0';
export * from './types.js';
export { parseWorkload, type ParseResult } from './parser.js';
export { Machine, type Snapshot } from './kernel.js';
export { Session, runToEnd, traceHash } from './session.js';
export { computeMetrics, type SystemMetrics, type ThreadMetrics } from './metrics.js';
export { simulateRefString, faultCurve, parseRefString, type RefPolicy, type RefResult, type RefStep } from './refstring.js';
export { SAMPLES, getSample, type Sample } from './samples.js';
export { analyze, applyConfigPatch, applyChange, runExperiment, measure, type Analysis, type Finding, type FindingKind, type Severity, type Experiment, type ExperimentChange, type ExperimentResult, type MetricDelta, type AnalyzeOptions } from './analyze.js';
export { explainEvent, answerQuestion, validateCitations, type Explanation, type Answer } from './assistant.js';
export { CONFIG_KEYS } from './parser.js';
