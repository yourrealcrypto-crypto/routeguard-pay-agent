import { LiveRouteId, type LiveRouteRiskResult } from "../domain/index.js";
import { evaluateWeatherRisk, WEATHER_RISK_POLICY } from "../risk/weather-policy.js";
import { getLiveRoute, listLiveRoutes } from "../store/live-routes.js";
import { retrieveRouteWeather } from "./open-meteo.js";

export class UnknownLiveRouteError extends Error {
  readonly code = "UNKNOWN_LIVE_ROUTE";

  constructor() {
    super("The requested live route is not allowlisted.");
    this.name = "UnknownLiveRouteError";
  }
}

export function liveRouteCatalog() {
  return {
    routes: listLiveRoutes(),
    policy: {
      policyVersion: WEATHER_RISK_POLICY.policyVersion,
      policyHash: WEATHER_RISK_POLICY.policyHash,
      thresholds: WEATHER_RISK_POLICY.thresholds,
      contributions: WEATHER_RISK_POLICY.contributions,
      missingDataBehavior: WEATHER_RISK_POLICY.missingDataBehavior,
      disclaimer: WEATHER_RISK_POLICY.disclaimer,
    },
    provider: {
      name: "Open-Meteo",
      attribution: "Weather data by Open-Meteo",
      url: "https://open-meteo.com/",
    },
  };
}

export async function assessLiveRouteRisk(
  routeIdInput: unknown,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
  } = {},
): Promise<LiveRouteRiskResult> {
  const parsedRouteId = LiveRouteId.safeParse(routeIdInput);
  if (!parsedRouteId.success) throw new UnknownLiveRouteError();
  const route = getLiveRoute(parsedRouteId.data);
  const now = options.now?.() ?? new Date();
  const weather = await retrieveRouteWeather(route, {
    fetchImpl: options.fetchImpl,
    now: () => now,
    timeoutMs: options.timeoutMs,
  });
  return evaluateWeatherRisk(route, weather, now);
}
