import { randomUUID } from "node:crypto";
import {
  LiveRoutePremiumReportSchema,
  sha256,
  type LiveRouteRiskResult,
  type PremiumReport,
  type ProviderReliabilitySignal,
} from "../domain/index.js";
import { providerEvidenceReportSections } from "./provider-evidence-report.js";

const LIVE_PREMIUM_POLICY_SOURCE = {
  policyId: "routeguard.live-route-premium",
  policyVersion: "1.1.0",
  algorithmVersion: "live-route-premium-1.1",
  contributionSource: "AUTHORITATIVE_FREE_ASSESSMENT",
} as const;

const LIVE_PREMIUM_POLICY_HASH = sha256(LIVE_PREMIUM_POLICY_SOURCE);
const DISCLAIMER =
  "Demonstration operational decision-support only. Not legal, insurance, compliance, transport-safety, or professional advice.";

export interface LivePremiumOptions {
  evaluatedAt?: string;
  generatedAt?: string;
  providerReliabilitySignal?: ProviderReliabilitySignal | null;
}

export function generateLiveRoutePremiumReport(
  assessment: LiveRouteRiskResult,
  paymentTransactionId: string,
  options: LivePremiumOptions = {},
): PremiumReport {
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const generatedAt = options.generatedAt ?? evaluatedAt;
  const route = assessment.route;
  const crossBorder = route.borderCount > 0;
  const alpineExposure = route.checkpoints.some((checkpoint) =>
    checkpoint.name.toLowerCase().includes("alpine"),
  );
  const factors = [
    {
      code: "STRUCTURAL_ROUTE_COMPLEXITY",
      label: "Structural route complexity",
      contribution: assessment.riskContributions.structuralComplexity,
      explanation: `${route.approximateDistanceKm} km, ${route.borderCount} borders, ${route.checkpoints.length} checkpoints, ${route.estimatedTransitHours} estimated transit hours.`,
    },
    {
      code: "LIVE_WEATHER_EXPOSURE",
      label: "Live weather exposure",
      contribution: assessment.riskContributions.liveWeatherExposure,
      explanation: assessment.triggeredRules.length
        ? `Triggered evidence: ${assessment.triggeredReasonCodes.join(", ")}.`
        : "No live-weather demonstration threshold was triggered.",
    },
    {
      code: "CARGO_SENSITIVITY",
      label: "Cargo sensitivity",
      contribution: assessment.riskContributions.cargoSensitivity,
      explanation: `Server-controlled cargo profile: ${route.cargoProfile}.`,
    },
    {
      code: "DATA_UNCERTAINTY",
      label: "Data uncertainty",
      contribution: assessment.riskContributions.dataUncertainty,
      explanation: `${assessment.dataFreshness.status} evidence; maximum age ${assessment.dataFreshness.maximumAgeMinutes} minutes; source ${assessment.dataSource}.`,
    },
  ];
  const totalBeforeCap = factors.reduce(
    (sum, factor) => sum + factor.contribution,
    0,
  );
  const riskScore = assessment.score;
  const riskBand = assessment.riskBand;
  const exposedCheckpointIds = assessment.checkpointEvidence
    .filter((checkpoint) =>
      checkpoint.triggeredReasonCodes.includes(
        "TEMPERATURE_EXPOSURE_OUTSIDE_TOLERANCE",
      ),
    )
    .map((checkpoint) => checkpoint.id);
  const mitigationRecommendations = recommendationsFor(assessment);
  const base = {
    reportId: randomUUID(),
    reportType: "LIVE_ROUTE" as const,
    routeId: route.id,
    origin: route.origin,
    destination: route.destination,
    checkpoints: route.checkpoints,
    checkpointEvidence: assessment.checkpointEvidence,
    weatherSourceTimestamp: assessment.sourceTimestamp,
    weatherDataSource: assessment.dataSource,
    structuralRouteComplexity: {
      checkpointCount: route.checkpoints.length,
      crossBorder,
      alpineExposure,
      approximateDistanceKm: route.approximateDistanceKm,
      borderCount: route.borderCount,
      estimatedTransitHours: route.estimatedTransitHours,
      structuralScore: assessment.riskContributions.structuralComplexity,
    },
    riskContributions: assessment.riskContributions,
    dataFreshness: assessment.dataFreshness,
    cargoSensitivity: route.cargoProfile,
    temperatureToleranceAnalysis: {
      minimumC: route.temperatureToleranceC.minimum,
      maximumC: route.temperatureToleranceC.maximum,
      exposedCheckpointIds,
    },
    borderAndCheckpointExposure: route.checkpoints.map(
      (checkpoint) => `${checkpoint.role}:${checkpoint.name}`,
    ),
    freeAssessmentComparison: {
      score: assessment.score,
      riskBand: assessment.riskBand,
      confidence: assessment.confidence,
    },
    riskScore,
    riskBand,
    confidence: Math.max(0, Number((assessment.confidence - 0.03).toFixed(2))),
    factors,
    recommendedControls: mitigationRecommendations,
    totalBeforeCap,
    evaluatedAt,
    generatedAt,
    algorithmVersion: LIVE_PREMIUM_POLICY_SOURCE.algorithmVersion,
    policyVersion: LIVE_PREMIUM_POLICY_SOURCE.policyVersion,
    policyHash: LIVE_PREMIUM_POLICY_HASH,
    paymentTransactionId,
    triggeredReasonCodes: assessment.triggeredReasonCodes,
    mitigationRecommendations,
    operationalRecommendations: operationalActions(assessment),
    ...providerEvidenceReportSections(
      options.providerReliabilitySignal ?? null,
      {
        route: `${route.origin} → ${route.destination}`,
        cargo: route.cargo,
        eta: "No customer delivery ETA supplied; decision-support route estimate only.",
        policyVersion: LIVE_PREMIUM_POLICY_SOURCE.policyVersion,
        evaluatedAt,
        generatedAt,
        schedulePressurePoints: assessment.structuralFactors.schedule,
        routeFactors: [
          `${route.borderCount} border crossings`,
          `${route.checkpoints.length} route checkpoints`,
        ],
        weatherFactors: assessment.triggeredReasonCodes.map(
          (code) => `Weather evidence: ${code}`,
        ),
        temperatureSensitive:
          route.cargoProfile === "TEMPERATURE_CONTROLLED",
        borderExposure: crossBorder,
      },
    ),
    disclaimer: DISCLAIMER,
  };
  return LiveRoutePremiumReportSchema.parse({
    ...base,
    reportHash: sha256(base),
  });
}

function recommendationsFor(assessment: LiveRouteRiskResult): string[] {
  const codes = new Set(assessment.triggeredReasonCodes);
  const recommendations: string[] = [];
  if (codes.has("TEMPERATURE_EXPOSURE_OUTSIDE_TOLERANCE"))
    recommendations.push("Increase temperature monitoring and verify reefer set-points.");
  if (codes.has("SEVERE_WIND") || codes.has("SEVERE_GUSTS"))
    recommendations.push("Delay departure or request manual review of wind exposure.");
  if (codes.has("HEAVY_PRECIPITATION") || codes.has("POOR_VISIBILITY"))
    recommendations.push("Increase schedule buffer and monitor affected checkpoints.");
  if (codes.has("THUNDERSTORM_CONDITIONS"))
    recommendations.push("Use additional cargo protection and reassess departure timing.");
  if (codes.has("STALE_WEATHER_DATA"))
    recommendations.push("Request manual review and refresh weather evidence.");
  recommendations.push("Verify border documentation before departure.");
  return [...new Set(recommendations)];
}

function operationalActions(assessment: LiveRouteRiskResult): string[] {
  const actions = assessment.checkpointEvidence
    .filter((checkpoint) => checkpoint.triggeredReasonCodes.length > 0)
    .map((checkpoint) => `Monitor ${checkpoint.name} for ${checkpoint.triggeredReasonCodes.join(", ")}.`);
  if (actions.length === 0)
    actions.push("Maintain standard checkpoint monitoring and refresh evidence before dispatch.");
  return actions;
}
