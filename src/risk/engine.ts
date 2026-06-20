import { randomUUID } from "node:crypto";
import {
  type Shipment,
  type BasicReport,
  type PremiumReport,
  type RiskBand,
  sha256,
} from "../domain/index.js";
import { getActiveRiskPolicy, type RiskPolicy } from "./policy.js";

/**
 * Scoring contributions are deterministic for an explicit policy, shipment,
 * and evaluation timestamp. UUIDs, timestamps, payment IDs, and final report
 * hashes are intentionally unique report-instance metadata.
 */

const DISCLAIMER =
  "Demonstration operational decision-support only. Not insurance, legal, safety, or compliance advice. Synthetic data, Hedera testnet.";

function bandFor(score: number, policy: RiskPolicy): RiskBand {
  return policy.riskBands.find((band) => score <= band.maximum)?.band ?? "critical";
}

function schedulePressure(s: Shipment, policy: RiskPolicy, evaluatedAt: string): number {
  const ms = new Date(s.promisedDeliveryAt).getTime() - new Date(evaluatedAt).getTime();
  const days = ms / (1000 * 60 * 60 * 24);
  return policy.scheduleThresholds.find((threshold) => days <= threshold.maximumDays)?.points ?? policy.scheduleFallbackPoints;
}

function valueConcentration(s: Shipment, policy: RiskPolicy): number {
  return policy.cargoValueThresholds.find((threshold) => s.cargoValueEur >= threshold.minimum)?.points ?? policy.cargoValueFallbackPoints;
}

function routeComplexity(s: Shipment, policy: RiskPolicy): number {
  let n = policy.routeRisk.base;
  if (s.origin.countryCode !== s.destination.countryCode) n += policy.routeRisk.crossBorder;
  if (s.mode === "ocean") n += policy.routeRisk.ocean;
  return Math.min(policy.routeRisk.cap, n);
}

export interface RiskEvaluationOptions {
  policy?: RiskPolicy;
  evaluatedAt?: string;
}

export function generateBasicReport(
  shipment: Shipment,
  options: RiskEvaluationOptions = {},
): BasicReport {
  const policy = options.policy ?? getActiveRiskPolicy();
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const rough =
    policy.modeWeights[shipment.mode] +
    policy.cargoWeights[shipment.cargoType] +
    shipment.riskSignals.length * policy.basicAssessment.pointsPerSignal;
  const band = bandFor(
    Math.min(policy.score.maximum, rough * policy.basicAssessment.multiplier),
    policy,
  );
  return {
    shipmentId: shipment.id,
    riskBand: band,
    confidence: shipment.freeAssessmentConfidence,
    evaluatedAt,
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
    visibleFactors: [
      { label: "Transport mode", note: shipment.mode },
      {
        label: "Cargo sensitivity",
        note: shipment.cargoType.replace(/_/g, " "),
      },
    ],
    upsell:
      "Premium analysis adds weighted factor attribution, a 0–100 score, and recommended operational controls.",
  };
}

export function generatePremiumReport(
  shipment: Shipment,
  paymentTransactionId: string,
  options: RiskEvaluationOptions = {},
): PremiumReport {
  const policy = options.policy ?? getActiveRiskPolicy();
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const contributions = [
    {
      code: "MODE",
      label: "Mode risk",
      contribution: policy.modeWeights[shipment.mode],
      explanation: `Baseline exposure for ${shipment.mode} transport.`,
    },
    {
      code: "CARGO",
      label: "Cargo sensitivity",
      contribution: policy.cargoWeights[shipment.cargoType],
      explanation: `Handling sensitivity for ${shipment.cargoType.replace(
        /_/g,
        " ",
      )} goods.`,
    },
    {
      code: "VALUE",
      label: "Value concentration",
      contribution: valueConcentration(shipment, policy),
      explanation: `Declared cargo value €${shipment.cargoValueEur.toLocaleString(
        "en-US",
      )}.`,
    },
    {
      code: "ROUTE",
      label: "Route complexity",
      contribution: routeComplexity(shipment, policy),
      explanation: `${shipment.origin.city} → ${shipment.destination.city}${
        shipment.origin.countryCode !== shipment.destination.countryCode
          ? " (cross-border)"
          : ""
      }.`,
    },
    {
      code: "SCHEDULE",
      label: "Schedule pressure",
      contribution: schedulePressure(shipment, policy, evaluatedAt),
      explanation: "Time buffer until promised delivery.",
    },
    {
      code: "SIGNALS",
      label: "Declared operational signals",
      contribution: Math.min(
        policy.riskSignals.cap,
        shipment.riskSignals.length * policy.riskSignals.pointsPerSignal,
      ),
      explanation:
        shipment.riskSignals.length > 0
          ? `Signals: ${shipment.riskSignals.join(", ")}.`
          : "No declared operational signals.",
    },
  ];

  const totalBeforeCap = contributions.reduce(
    (sum, factor) => sum + factor.contribution,
    0,
  );
  const riskScore = Math.max(
    policy.score.minimum,
    Math.min(policy.score.maximum, totalBeforeCap),
  );
  const band = bandFor(riskScore, policy);

  const controls: string[] = [];
  if (shipment.cargoType === "temperature_controlled")
    controls.push("Add continuous temperature telemetry with alerting.");
  if (schedulePressure(shipment, policy, evaluatedAt) >= 10)
    controls.push("Increase transit buffer or pre-book priority slots.");
  if (shipment.mode === "ocean")
    controls.push("Confirm an alternate port/hub contingency.");
  if (valueConcentration(shipment, policy) >= 11)
    controls.push("Escalate insurance review for high-value concentration.");
  if (shipment.riskSignals.includes("border-crossing"))
    controls.push("Require milestone check-ins at each border.");
  if (controls.length === 0)
    controls.push("Maintain standard monitoring; no elevated controls needed.");

  const base = {
    reportId: randomUUID(),
    shipmentId: shipment.id,
    riskScore,
    riskBand: band,
    confidence: policy.confidence.premiumValue,
    factors: contributions,
    totalBeforeCap,
    evaluatedAt,
    recommendedControls: controls,
    generatedAt: new Date().toISOString(),
    algorithmVersion: "route-risk-1.0" as const,
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
    paymentTransactionId,
    disclaimer: DISCLAIMER,
  };
  // Hash everything except the hash field itself.
  const reportHash = sha256(base);
  return { ...base, reportHash };
}

export interface RiskScoreExplanation {
  shipmentId: string;
  canonicalInputs: Record<string, unknown>;
  evaluationTimestamp: string;
  factors: PremiumReport["factors"];
  totalBeforeCap: number;
  riskScore: number;
  riskBand: RiskBand;
  confidence: number;
  policyVersion: string;
  policyHash: string;
}

/** Public, reproducible score evidence using the exact premium scoring path. */
export function explainRiskScore(
  shipment: Shipment,
  options: RiskEvaluationOptions = {},
): RiskScoreExplanation {
  const policy = options.policy ?? getActiveRiskPolicy();
  const evaluationTimestamp = options.evaluatedAt ?? new Date().toISOString();
  const report = generatePremiumReport(shipment, "POLICY_EXPLANATION", {
    policy,
    evaluatedAt: evaluationTimestamp,
  });
  return {
    shipmentId: shipment.id,
    canonicalInputs: {
      mode: shipment.mode,
      cargoType: shipment.cargoType,
      cargoValueEur: shipment.cargoValueEur,
      originCountryCode: shipment.origin.countryCode,
      destinationCountryCode: shipment.destination.countryCode,
      promisedDeliveryAt: shipment.promisedDeliveryAt,
      riskSignals: [...shipment.riskSignals],
      freeAssessmentConfidence: shipment.freeAssessmentConfidence,
    },
    evaluationTimestamp,
    factors: report.factors,
    totalBeforeCap: report.totalBeforeCap,
    riskScore: report.riskScore,
    riskBand: report.riskBand,
    confidence: report.confidence,
    policyVersion: report.policyVersion,
    policyHash: report.policyHash,
  };
}

export function premiumReportRecommended(
  shipment: Shipment,
  policy: RiskPolicy,
): boolean {
  return (
    shipment.cargoValueEur >= 50_000 ||
    shipment.freeAssessmentConfidence < policy.confidence.minimumUsableConfidence ||
    shipment.riskSignals.length > 0 ||
    shipment.cargoType !== "general"
  );
}
