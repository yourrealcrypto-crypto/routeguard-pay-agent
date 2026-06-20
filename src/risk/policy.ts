import { sha256, type RiskBand } from "../domain/index.js";

export type RiskPolicyStatus = "ACTIVE" | "SUPERSEDED";

export interface RiskBandBoundary {
  band: RiskBand;
  maximum: number;
}

export interface ThresholdPoints {
  minimum: number;
  points: number;
}

export interface ScheduleThresholdPoints {
  maximumDays: number;
  points: number;
}

export interface RiskPolicy {
  schemaVersion: "1.0.0";
  policyId: "routeguard.synthetic-route-risk";
  policyVersion: string;
  status: RiskPolicyStatus;
  effectiveDate: string;
  score: {
    minimum: 0;
    maximum: 100;
    aggregation: "sum_then_cap";
  };
  riskBands: RiskBandBoundary[];
  modeWeights: Record<"air" | "rail" | "road" | "ocean", number>;
  cargoWeights: Record<
    "general" | "high_value" | "fragile" | "temperature_controlled",
    number
  >;
  cargoValueThresholds: ThresholdPoints[];
  cargoValueFallbackPoints: number;
  routeRisk: {
    base: number;
    crossBorder: number;
    ocean: number;
    cap: number;
  };
  scheduleThresholds: ScheduleThresholdPoints[];
  scheduleFallbackPoints: number;
  riskSignals: {
    pointsPerSignal: number;
    cap: number;
  };
  basicAssessment: {
    pointsPerSignal: number;
    multiplier: number;
  };
  confidence: {
    basicMethod: "shipment_free_assessment_confidence";
    premiumMethod: "fixed_demo_confidence";
    premiumValue: number;
    minimumUsableConfidence: number;
  };
  policyHash: string;
}

export interface RiskPolicyHistoryEntry {
  policy: RiskPolicy;
  activatedAt: string;
  proposalId: string | null;
  previousVersion: string | null;
}

export const INITIAL_RISK_POLICY_SOURCE: Omit<RiskPolicy, "policyHash"> = {
  schemaVersion: "1.0.0",
  policyId: "routeguard.synthetic-route-risk",
  policyVersion: "1.0.0",
  status: "ACTIVE",
  effectiveDate: "2026-06-20T00:00:00.000Z",
  score: { minimum: 0, maximum: 100, aggregation: "sum_then_cap" },
  riskBands: [
    { band: "low", maximum: 24 },
    { band: "moderate", maximum: 49 },
    { band: "high", maximum: 74 },
    { band: "critical", maximum: 100 },
  ],
  modeWeights: { air: 6, rail: 7, road: 11, ocean: 13 },
  cargoWeights: {
    general: 4,
    high_value: 16,
    fragile: 14,
    temperature_controlled: 18,
  },
  cargoValueThresholds: [
    { minimum: 400_000, points: 15 },
    { minimum: 150_000, points: 11 },
    { minimum: 50_000, points: 7 },
  ],
  cargoValueFallbackPoints: 3,
  routeRisk: { base: 4, crossBorder: 7, ocean: 4, cap: 15 },
  scheduleThresholds: [
    { maximumDays: 5, points: 15 },
    { maximumDays: 9, points: 10 },
    { maximumDays: 16, points: 6 },
  ],
  scheduleFallbackPoints: 2,
  riskSignals: { pointsPerSignal: 6, cap: 20 },
  basicAssessment: { pointsPerSignal: 4, multiplier: 1.4 },
  confidence: {
    basicMethod: "shipment_free_assessment_confidence",
    premiumMethod: "fixed_demo_confidence",
    premiumValue: 0.9,
    minimumUsableConfidence: 0.75,
  },
};

/** Lifecycle status is excluded: changing ACTIVE to SUPERSEDED must not alter old report hashes. */
export function calculateRiskPolicyHash(
  policy: Omit<RiskPolicy, "policyHash">,
): string {
  const { status: _lifecycleStatus, ...immutablePolicy } = policy;
  return sha256(immutablePolicy);
}

export function createRiskPolicy(
  source: Omit<RiskPolicy, "policyHash">,
): RiskPolicy {
  return { ...structuredClone(source), policyHash: calculateRiskPolicyHash(source) };
}

const initialPolicy = createRiskPolicy(INITIAL_RISK_POLICY_SOURCE);
let activePolicy = initialPolicy;
let history: RiskPolicyHistoryEntry[] = [
  {
    policy: initialPolicy,
    activatedAt: initialPolicy.effectiveDate,
    proposalId: null,
    previousVersion: null,
  },
];

export function getActiveRiskPolicy(): RiskPolicy {
  return structuredClone(activePolicy);
}

export function getRiskPolicyHistory(): RiskPolicyHistoryEntry[] {
  return structuredClone(history).reverse();
}

export function activateRiskPolicy(
  source: Omit<RiskPolicy, "policyHash">,
  proposalId: string,
): RiskPolicy {
  const previous = activePolicy;
  history = history.map((entry) =>
    entry.policy.policyVersion === previous.policyVersion
      ? { ...entry, policy: { ...entry.policy, status: "SUPERSEDED" } }
      : entry,
  );
  activePolicy = createRiskPolicy(source);
  history.push({
    policy: activePolicy,
    activatedAt: source.effectiveDate,
    proposalId,
    previousVersion: previous.policyVersion,
  });
  return getActiveRiskPolicy();
}

export function resetRiskPolicyRegistry(): void {
  activePolicy = createRiskPolicy(INITIAL_RISK_POLICY_SOURCE);
  history = [
    {
      policy: activePolicy,
      activatedAt: activePolicy.effectiveDate,
      proposalId: null,
      previousVersion: null,
    },
  ];
}

export function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error("Invalid semantic policy version.");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function validateRiskPolicy(policy: RiskPolicy): string[] {
  const errors: string[] = [];
  const numericValues = [
    ...Object.values(policy.modeWeights),
    ...Object.values(policy.cargoWeights),
    ...policy.cargoValueThresholds.map((x) => x.points),
    policy.cargoValueFallbackPoints,
    policy.routeRisk.base,
    policy.routeRisk.crossBorder,
    policy.routeRisk.ocean,
    policy.routeRisk.cap,
    ...policy.scheduleThresholds.map((x) => x.points),
    policy.scheduleFallbackPoints,
    policy.riskSignals.pointsPerSignal,
    policy.riskSignals.cap,
  ];
  if (numericValues.some((value) => value < 0))
    errors.push("Risk points and caps cannot be negative.");
  if (policy.routeRisk.cap > 100 || policy.riskSignals.cap > 100)
    errors.push("Risk caps cannot exceed 100.");
  if (
    policy.confidence.minimumUsableConfidence < 0 ||
    policy.confidence.minimumUsableConfidence > 1
  )
    errors.push("Minimum usable confidence must be between 0 and 1.");
  if (policy.riskBands.length !== 4)
    errors.push("Exactly four risk bands are required.");
  const expectedBands: RiskBand[] = ["low", "moderate", "high", "critical"];
  if (policy.riskBands.some((band, i) => band.band !== expectedBands[i]))
    errors.push("Risk bands must remain low, moderate, high, critical.");
  const maxima = policy.riskBands.map((band) => band.maximum);
  if (
    maxima.some((value) => !Number.isInteger(value) || value < 0 || value > 100) ||
    !(maxima[0]! < maxima[1]! && maxima[1]! < maxima[2]! && maxima[2]! < maxima[3]!) ||
    maxima[3] !== 100
  )
    errors.push("Risk bands must be ordered, non-overlapping, and cover 0 through 100.");
  return errors;
}
