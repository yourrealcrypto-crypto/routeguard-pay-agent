import { randomUUID } from "node:crypto";
import {
  type Shipment,
  type BasicReport,
  type PremiumReport,
  type RiskBand,
  sha256,
} from "../domain/index.js";

/**
 * Deterministic scoring. Identical shipment input always yields an identical
 * report (and therefore an identical hash), which is what makes the on-chain
 * report hash a meaningful integrity proof and the tests reproducible.
 */

const DISCLAIMER =
  "Demonstration operational decision-support only. Not insurance, legal, safety, or compliance advice. Synthetic data, Hedera testnet.";

function bandFor(score: number): RiskBand {
  if (score <= 24) return "low";
  if (score <= 49) return "moderate";
  if (score <= 74) return "high";
  return "critical";
}

const MODE_RISK: Record<Shipment["mode"], number> = {
  air: 6,
  rail: 7,
  road: 11,
  ocean: 13,
};

const CARGO_SENSITIVITY: Record<Shipment["cargoType"], number> = {
  general: 4,
  high_value: 16,
  fragile: 14,
  temperature_controlled: 18,
};

function schedulePressure(s: Shipment): number {
  const ms = new Date(s.promisedDeliveryAt).getTime() - Date.now();
  const days = ms / (1000 * 60 * 60 * 24);
  if (days <= 5) return 15;
  if (days <= 9) return 10;
  if (days <= 16) return 6;
  return 2;
}

function valueConcentration(s: Shipment): number {
  if (s.cargoValueEur >= 400_000) return 15;
  if (s.cargoValueEur >= 150_000) return 11;
  if (s.cargoValueEur >= 50_000) return 7;
  return 3;
}

function routeComplexity(s: Shipment): number {
  let n = 4;
  if (s.origin.countryCode !== s.destination.countryCode) n += 7;
  if (s.mode === "ocean") n += 4;
  return Math.min(15, n);
}

export function generateBasicReport(shipment: Shipment): BasicReport {
  const rough =
    MODE_RISK[shipment.mode] +
    CARGO_SENSITIVITY[shipment.cargoType] +
    shipment.riskSignals.length * 4;
  const band = bandFor(Math.min(100, rough * 1.4));
  return {
    shipmentId: shipment.id,
    riskBand: band,
    confidence: shipment.freeAssessmentConfidence,
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
): PremiumReport {
  const contributions = [
    {
      code: "MODE",
      label: "Mode risk",
      contribution: MODE_RISK[shipment.mode],
      explanation: `Baseline exposure for ${shipment.mode} transport.`,
    },
    {
      code: "CARGO",
      label: "Cargo sensitivity",
      contribution: CARGO_SENSITIVITY[shipment.cargoType],
      explanation: `Handling sensitivity for ${shipment.cargoType.replace(
        /_/g,
        " ",
      )} goods.`,
    },
    {
      code: "VALUE",
      label: "Value concentration",
      contribution: valueConcentration(shipment),
      explanation: `Declared cargo value €${shipment.cargoValueEur.toLocaleString(
        "en-US",
      )}.`,
    },
    {
      code: "ROUTE",
      label: "Route complexity",
      contribution: routeComplexity(shipment),
      explanation: `${shipment.origin.city} → ${shipment.destination.city}${
        shipment.origin.countryCode !== shipment.destination.countryCode
          ? " (cross-border)"
          : ""
      }.`,
    },
    {
      code: "SCHEDULE",
      label: "Schedule pressure",
      contribution: schedulePressure(shipment),
      explanation: "Time buffer until promised delivery.",
    },
    {
      code: "SIGNALS",
      label: "Declared operational signals",
      contribution: Math.min(20, shipment.riskSignals.length * 6),
      explanation:
        shipment.riskSignals.length > 0
          ? `Signals: ${shipment.riskSignals.join(", ")}.`
          : "No declared operational signals.",
    },
  ];

  const riskScore = Math.min(
    100,
    contributions.reduce((sum, f) => sum + f.contribution, 0),
  );
  const band = bandFor(riskScore);

  const controls: string[] = [];
  if (shipment.cargoType === "temperature_controlled")
    controls.push("Add continuous temperature telemetry with alerting.");
  if (schedulePressure(shipment) >= 10)
    controls.push("Increase transit buffer or pre-book priority slots.");
  if (shipment.mode === "ocean")
    controls.push("Confirm an alternate port/hub contingency.");
  if (valueConcentration(shipment) >= 11)
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
    confidence: 0.9,
    factors: contributions,
    recommendedControls: controls,
    generatedAt: new Date().toISOString(),
    algorithmVersion: "route-risk-1.0" as const,
    paymentTransactionId,
    disclaimer: DISCLAIMER,
  };
  // Hash everything except the hash field itself.
  const reportHash = sha256(base);
  return { ...base, reportHash };
}
