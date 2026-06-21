import type { ProviderReliabilitySignal } from "../domain/index.js";

export interface ProviderEvidenceReportContext {
  route: string;
  cargo: string;
  eta: string;
  policyVersion: string;
  evaluatedAt: string;
  generatedAt: string;
  schedulePressurePoints: number;
  routeFactors: string[];
  weatherFactors: string[];
  temperatureSensitive: boolean;
  borderExposure: boolean;
}

export function providerEvidenceReportSections(
  signal: ProviderReliabilitySignal | null,
  context: ProviderEvidenceReportContext,
) {
  const delayExposureMinutes = signal?.averageDelayMinutes ?? null;
  const factors = [
    `Schedule-pressure contribution: ${context.schedulePressurePoints}`,
    ...context.routeFactors,
    ...(context.weatherFactors.length
      ? context.weatherFactors
      : ["Weather evidence: not supplied for this report target"]),
  ];
  if (signal) {
    factors.push(
      `Private provider evidence: ${signal.onTimeRate}% on-time across ${signal.sampleSize} sample${signal.sampleSize === 1 ? "" : "s"}`,
      `Observed average delay: ${signal.averageDelayMinutes} minutes`,
    );
  } else {
    factors.push("No matching customer-specific provider evidence was available.");
  }

  const highRisk =
    context.schedulePressurePoints >= 15 ||
    (signal !== null &&
      (signal.onTimeRate < 60 || signal.averageDelayMinutes > 240));
  const moderateRisk =
    context.schedulePressurePoints >= 10 ||
    context.weatherFactors.length > 0 ||
    (signal !== null &&
      (signal.onTimeRate < 80 || signal.averageDelayMinutes > 60));
  const onTimeRiskBand: "LOW" | "MODERATE" | "HIGH" = highRisk
    ? "HIGH"
    : moderateRisk
      ? "MODERATE"
      : "LOW";

  const basis: string[] = [];
  let recommendation = "Increase schedule buffer and retain standard checkpoint monitoring.";
  if (context.temperatureSensitive) {
    recommendation = "Increase temperature monitoring at dispatch and hand-off checkpoints.";
    basis.push("Temperature-sensitive cargo evidence");
  }
  if (context.borderExposure) {
    recommendation = "Verify border documents and review an alternative route contingency.";
    basis.push("Cross-border or checkpoint exposure");
  }
  if (context.weatherFactors.length > 0) {
    recommendation = "Review the departure window and reassess the affected route checkpoints.";
    basis.push("Measured weather exposure");
  }
  if (
    signal &&
    (signal.reliabilityBand === "MIXED_OBSERVED_RELIABILITY" ||
      signal.reliabilityBand === "ELEVATED_OPERATIONAL_ATTENTION")
  ) {
    recommendation =
      "Increase schedule buffer and consider a higher-reliability service tier for this shipment.";
    basis.push("Customer-specific provider delay and on-time evidence");
  }
  if (basis.length === 0) basis.push("Current route, schedule, and cargo evidence");

  return {
    privateProviderReliabilitySignal: signal,
    providerEvidenceScopeLabel:
      "Private customer-specific provider score · Not shared across customers · Not a public carrier rating" as const,
    etaReliabilityRisk: {
      schedulePressure: `${context.schedulePressurePoints} policy points`,
      delayExposureMinutes,
      contributingFactors: factors,
      onTimeRiskBand,
      explanation:
        "ETA reliability combines schedule pressure with measurable route, border, weather, and matching customer-specific provider evidence. It does not guarantee arrival time.",
    },
    insuranceSupportEvidence: {
      route: context.route,
      cargo: context.cargo,
      eta: context.eta,
      providerAlias: signal?.providerAlias ?? null,
      providerReliabilityBand: signal?.reliabilityBand ?? null,
      policyVersion: context.policyVersion,
      evidenceHashes: signal?.evidenceHashes ?? [],
      evaluatedAt: context.evaluatedAt,
      generatedAt: context.generatedAt,
      disclaimer:
        "Insurance-support evidence only. This report does not sell, price, approve, or determine insurance." as const,
    },
    alternativeRouteOrMitigationRecommendation: {
      recommendation,
      basis,
      exactTravelTimeEstimated: false as const,
    },
  };
}
