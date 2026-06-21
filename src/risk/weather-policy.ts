import {
  LiveRouteRiskResultSchema,
  WeatherCheckpointEvidenceSchema,
  sha256,
  type LiveFreightRoute,
  type LiveRouteRiskResult,
  type RiskBand,
  type WeatherCheckpointEvidence,
  type WeatherRiskRuleResult,
} from "../domain/index.js";
import {
  WeatherDataUnavailableError,
  type RouteWeatherEvidence,
} from "../live-routes/open-meteo.js";

export const WEATHER_RISK_POLICY_SOURCE = {
  schemaVersion: "1.0.0",
  policyId: "routeguard.live-weather-risk",
  policyVersion: "1.1.0",
  effectiveDate: "2026-06-21T00:00:00.000Z",
  score: { minimum: 0, maximum: 100 },
  bands: [
    { band: "low", maximum: 24 },
    { band: "moderate", maximum: 49 },
    { band: "high", maximum: 74 },
    { band: "critical", maximum: 100 },
  ] as const,
  thresholds: {
    severeWindKph: 50,
    severeGustKph: 70,
    heavyPrecipitationMm: 7.5,
    poorVisibilityM: 1_000,
    freezingC: 0,
    thunderstormWeatherCodes: [95, 96, 99],
    staleAfterMinutes: 90,
    veryStaleAfterMinutes: 180,
  },
  contributions: {
    severeWind: 14,
    severeGusts: 16,
    heavyPrecipitation: 14,
    poorVisibility: 18,
    freezingConditions: 10,
    thunderstorm: 20,
    temperatureExposure: 18,
    staleData: 6,
  },
  structural: {
    distanceKmPerPoint: 200,
    distanceCap: 10,
    pointsPerBorder: 2,
    borderCap: 10,
    checkpointCap: 6,
    scheduleBaselineHours: 18,
    scheduleHoursPerPoint: 3,
    scheduleCap: 4,
  },
  cargoSensitivity: {
    TEMPERATURE_CONTROLLED: 18,
    FRAGILE_HIGH_VALUE: 15,
    GENERAL_CARGO: 6,
  },
  dataUncertainty: { cache: 1, stale: 6, veryStale: 12 },
  confidence: { fresh: 0.95, stale: 0.7, veryStale: 0.45, cachePenalty: 0.05 },
  missingDataBehavior: "WEATHER_DATA_UNAVAILABLE_MANUAL_REVIEW",
  disclaimer:
    "Demonstration thresholds only; not universal logistics-safety standards. Weather evidence cannot approve payment.",
} as const;

export const WEATHER_RISK_POLICY = {
  ...WEATHER_RISK_POLICY_SOURCE,
  policyHash: sha256(WEATHER_RISK_POLICY_SOURCE),
};

function bandFor(score: number): RiskBand {
  return (
    WEATHER_RISK_POLICY.bands.find((band) => score <= band.maximum)?.band ??
    "critical"
  );
}

export function structuralRiskFactors(route: LiveFreightRoute) {
  const policy = WEATHER_RISK_POLICY.structural;
  const factors = {
    distance: Math.min(
      policy.distanceCap,
      Math.ceil(route.approximateDistanceKm / policy.distanceKmPerPoint),
    ),
    borders: Math.min(
      policy.borderCap,
      route.borderCount * policy.pointsPerBorder,
    ),
    checkpoints: Math.min(
      policy.checkpointCap,
      route.checkpoints.length,
    ),
    schedule: Math.min(
      policy.scheduleCap,
      Math.max(
        0,
        Math.ceil(
          (route.estimatedTransitHours - policy.scheduleBaselineHours) /
            policy.scheduleHoursPerPoint,
        ),
      ),
    ),
  };
  return {
    factors,
    total: Object.values(factors).reduce((sum, value) => sum + value, 0),
  };
}

export function cargoSensitivityScore(route: LiveFreightRoute): number {
  return WEATHER_RISK_POLICY.cargoSensitivity[route.cargoProfile];
}

function triggered(
  code: string,
  contribution: number,
  evidence: WeatherCheckpointEvidence[],
  predicate: (checkpoint: WeatherCheckpointEvidence) => boolean,
  explanation: string,
): WeatherRiskRuleResult | null {
  const checkpointIds = evidence.filter(predicate).map((checkpoint) => checkpoint.id);
  return checkpointIds.length
    ? { code, contribution, checkpointIds, explanation }
    : null;
}

export function evaluateWeatherRisk(
  route: LiveFreightRoute,
  weather: RouteWeatherEvidence,
  evaluatedAt: Date = new Date(),
): LiveRouteRiskResult {
  const parsedEvidence = WeatherCheckpointEvidenceSchema.array().min(3).max(6).safeParse(
    weather.checkpointEvidence,
  );
  if (
    !parsedEvidence.success ||
    weather.routeId !== route.id ||
    parsedEvidence.data.length !== route.checkpoints.length
  )
    throw new WeatherDataUnavailableError(
      "Complete checkpoint evidence is required for deterministic scoring.",
    );

  const evidence = parsedEvidence.data;
  const t = WEATHER_RISK_POLICY.thresholds;
  const c = WEATHER_RISK_POLICY.contributions;
  const rules: Array<WeatherRiskRuleResult | null> = [
    triggered(
      "SEVERE_WIND",
      c.severeWind,
      evidence,
      (checkpoint) => checkpoint.windSpeedKph >= t.severeWindKph,
      `Sustained wind is at least ${t.severeWindKph} km/h.`,
    ),
    triggered(
      "SEVERE_GUSTS",
      c.severeGusts,
      evidence,
      (checkpoint) => checkpoint.windGustsKph >= t.severeGustKph,
      `Wind gusts are at least ${t.severeGustKph} km/h.`,
    ),
    triggered(
      "HEAVY_PRECIPITATION",
      c.heavyPrecipitation,
      evidence,
      (checkpoint) => checkpoint.precipitationMm >= t.heavyPrecipitationMm,
      `Current-interval precipitation is at least ${t.heavyPrecipitationMm} mm.`,
    ),
    triggered(
      "POOR_VISIBILITY",
      c.poorVisibility,
      evidence,
      (checkpoint) => checkpoint.visibilityM < t.poorVisibilityM,
      `Visibility is below ${t.poorVisibilityM} metres.`,
    ),
    triggered(
      "FREEZING_CONDITIONS",
      c.freezingConditions,
      evidence,
      (checkpoint) => checkpoint.temperatureC <= t.freezingC,
      `Temperature is at or below ${t.freezingC}°C.`,
    ),
    triggered(
      "THUNDERSTORM_CONDITIONS",
      c.thunderstorm,
      evidence,
      (checkpoint) =>
        (t.thunderstormWeatherCodes as readonly number[]).includes(
          checkpoint.weatherCode,
        ),
      "Weather code indicates thunderstorm conditions.",
    ),
    triggered(
      "TEMPERATURE_EXPOSURE_OUTSIDE_TOLERANCE",
      c.temperatureExposure,
      evidence,
      (checkpoint) =>
        checkpoint.temperatureC < route.temperatureToleranceC.minimum ||
        checkpoint.temperatureC > route.temperatureToleranceC.maximum,
      `Temperature is outside the cargo demonstration tolerance of ${route.temperatureToleranceC.minimum}–${route.temperatureToleranceC.maximum}°C.`,
    ),
  ];

  const agesMinutes = evidence.map(
    (checkpoint) =>
      (evaluatedAt.getTime() - Date.parse(checkpoint.sourceTimestamp)) / 60_000,
  );
  if (agesMinutes.some((age) => !Number.isFinite(age) || age < -15))
    throw new WeatherDataUnavailableError(
      "Weather timestamps are missing or implausibly in the future.",
    );
  const maximumAgeMinutes = Math.max(...agesMinutes);
  const freshnessStatus =
    maximumAgeMinutes > t.veryStaleAfterMinutes
      ? "VERY_STALE"
      : maximumAgeMinutes > t.staleAfterMinutes
        ? "STALE"
        : "FRESH";
  const staleUncertainty =
    freshnessStatus === "VERY_STALE"
      ? WEATHER_RISK_POLICY.dataUncertainty.veryStale
      : freshnessStatus === "STALE"
        ? WEATHER_RISK_POLICY.dataUncertainty.stale
        : 0;
  if (freshnessStatus !== "FRESH")
    rules.push({
      code: "STALE_WEATHER_DATA",
      contribution: staleUncertainty,
      checkpointIds: evidence
        .filter(
          (checkpoint) =>
            (evaluatedAt.getTime() - Date.parse(checkpoint.sourceTimestamp)) /
              60_000 >
            t.staleAfterMinutes,
        )
        .map((checkpoint) => checkpoint.id),
      explanation: `Weather evidence is older than ${t.staleAfterMinutes} minutes.`,
    });

  const triggeredRules = rules.filter(
    (rule): rule is WeatherRiskRuleResult => rule !== null,
  );
  const triggeredByCheckpoint = new Map<string, string[]>();
  for (const rule of triggeredRules)
    for (const checkpointId of rule.checkpointIds)
      triggeredByCheckpoint.set(checkpointId, [
        ...(triggeredByCheckpoint.get(checkpointId) ?? []),
        rule.code,
      ]);
  const checkpointEvidence = evidence.map((checkpoint) => ({
    ...checkpoint,
    triggeredReasonCodes: triggeredByCheckpoint.get(checkpoint.id) ?? [],
  }));
  const structural = structuralRiskFactors(route);
  const liveWeatherExposure = Math.min(
    74,
    triggeredRules
      .filter((rule) => rule.code !== "STALE_WEATHER_DATA")
      .reduce((sum, rule) => sum + rule.contribution, 0),
  );
  const cargoSensitivity = cargoSensitivityScore(route);
  const dataUncertainty = Math.min(
    13,
    staleUncertainty +
      (weather.dataSource === "CACHE"
        ? WEATHER_RISK_POLICY.dataUncertainty.cache
        : 0),
  );
  const score = Math.min(
    WEATHER_RISK_POLICY.score.maximum,
    structural.total +
      liveWeatherExposure +
      cargoSensitivity +
      dataUncertainty,
  );
  const freshnessConfidence =
    maximumAgeMinutes > t.veryStaleAfterMinutes
      ? WEATHER_RISK_POLICY.confidence.veryStale
      : maximumAgeMinutes > t.staleAfterMinutes
        ? WEATHER_RISK_POLICY.confidence.stale
        : WEATHER_RISK_POLICY.confidence.fresh;
  const confidence = Math.max(
    0,
    Number(
      (
        freshnessConfidence -
        (weather.dataSource === "CACHE"
          ? WEATHER_RISK_POLICY.confidence.cachePenalty
          : 0)
      ).toFixed(2),
    ),
  );

  return LiveRouteRiskResultSchema.parse({
    route,
    status: "AVAILABLE",
    dataSource: weather.dataSource,
    retrievedAt: weather.retrievedAt,
    sourceTimestamp: weather.sourceTimestamp,
    score,
    riskBand: bandFor(score),
    confidence,
    triggeredReasonCodes: triggeredRules.map((rule) => rule.code),
    triggeredRules,
    checkpointEvidence,
    riskContributions: {
      structuralComplexity: structural.total,
      liveWeatherExposure,
      cargoSensitivity,
      dataUncertainty,
      total: score,
    },
    structuralFactors: structural.factors,
    dataFreshness: {
      maximumAgeMinutes: Math.max(0, Number(maximumAgeMinutes.toFixed(2))),
      status: freshnessStatus,
      fromCache: weather.dataSource === "CACHE",
    },
    policyVersion: WEATHER_RISK_POLICY.policyVersion,
    policyHash: WEATHER_RISK_POLICY.policyHash,
    premiumReportRecommended:
      score >= 25 ||
      route.cargoProfile === "TEMPERATURE_CONTROLLED" ||
      route.cargoProfile === "FRAGILE_HIGH_VALUE",
    purchaseMode: "POLICY_GATED",
    disclaimer: WEATHER_RISK_POLICY.disclaimer,
  });
}
