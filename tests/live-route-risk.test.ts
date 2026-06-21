import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRouteRiskResultSchema, sha256 } from "../src/domain/index.js";
import {
  clearWeatherCache,
  OPEN_METEO_HOSTNAME,
  OPEN_METEO_TIMEOUT_MS,
  WEATHER_CACHE_TTL_MS,
  WeatherDataUnavailableError,
} from "../src/live-routes/open-meteo.js";
import {
  assessLiveRouteRisk,
  UnknownLiveRouteError,
} from "../src/live-routes/service.js";
import { getLiveRoute, listLiveRoutes } from "../src/store/live-routes.js";
import { AgentService } from "../src/server/agent-service.js";
import { store } from "../src/store/store.js";

const NOW = new Date("2026-06-21T12:30:00.000Z");

function payload(
  routeId: "LIVE-HAM-RTM" | "LIVE-MUC-MIL" | "LIVE-LEJ-WAW" | "LIVE-MUC-IST",
  options: {
    time?: string;
    temperature?: number;
    precipitation?: number;
    wind?: number;
    gusts?: number;
    visibility?: number;
    weatherCode?: number;
  } = {},
) {
  const route = getLiveRoute(routeId);
  const time = options.time ?? "2026-06-21T12:00";
  return route.checkpoints.map((checkpoint) => ({
    latitude: checkpoint.latitude,
    longitude: checkpoint.longitude,
    current: {
      time,
      temperature_2m: options.temperature ?? 6,
      precipitation: options.precipitation ?? 0,
      wind_speed_10m: options.wind ?? 10,
      wind_gusts_10m: options.gusts ?? 20,
      weather_code: options.weatherCode ?? 1,
    },
    hourly: {
      time: [time],
      visibility: [options.visibility ?? 10_000],
    },
  }));
}

function fetchFor(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("Phase 1 live route intelligence", () => {
  beforeEach(() => {
    clearWeatherCache();
    store.reset();
  });

  it("contains all four allowlisted routes and the six-point Munich to Istanbul corridor", () => {
    const routes = listLiveRoutes();
    expect(routes.map((route) => route.id)).toEqual([
      "LIVE-HAM-RTM",
      "LIVE-MUC-MIL",
      "LIVE-LEJ-WAW",
      "LIVE-MUC-IST",
    ]);
    expect(routes.slice(0, 3).every((route) => route.checkpoints.length === 3)).toBe(true);
    expect(routes[1]?.checkpoints[1]?.name).toContain("Alpine");
    const munichIstanbul = routes[3]!;
    expect(munichIstanbul.checkpoints.map((checkpoint) => checkpoint.name)).toEqual([
      "Munich",
      "Vienna",
      "Budapest",
      "Belgrade",
      "Sofia",
      "Istanbul",
    ]);
    expect(munichIstanbul.cargo).toBe("Temperature-controlled pharmaceuticals");
    expect(munichIstanbul.transportMode).toBe("ROAD_FREIGHT");
    expect(munichIstanbul.temperatureToleranceC).toEqual({ minimum: 2, maximum: 8 });
    expect(OPEN_METEO_TIMEOUT_MS).toBe(5_000);
    expect(WEATHER_CACHE_TTL_MS).toBe(10 * 60 * 1_000);
  });

  it("rejects an unknown browser route ID before any network call", async () => {
    const fetchImpl = fetchFor([]);
    await expect(
      assessLiveRouteRisk("LIVE-UNKNOWN", { fetchImpl, now: () => NOW }),
    ).rejects.toBeInstanceOf(UnknownLiveRouteError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a valid Open-Meteo response into deterministic evidence and caches it", async () => {
    const fetchImpl = fetchFor(payload("LIVE-HAM-RTM"));
    const first = await assessLiveRouteRisk("LIVE-HAM-RTM", {
      fetchImpl,
      now: () => NOW,
    });
    const second = await assessLiveRouteRisk("LIVE-HAM-RTM", {
      fetchImpl,
      now: () => NOW,
    });
    expect(first.dataSource).toBe("LIVE");
    expect(second.dataSource).toBe("CACHE");
    expect(second.score).toBe(first.score + 1);
    expect(second.riskContributions.liveWeatherExposure).toBe(
      first.riskContributions.liveWeatherExposure,
    );
    expect(second.riskContributions.dataUncertainty).toBe(
      first.riskContributions.dataUncertainty + 1,
    );
    expect(second.triggeredReasonCodes).toEqual(first.triggeredReasonCodes);
    expect(first.checkpointEvidence).toHaveLength(3);
    expect(LiveRouteRiskResultSchema.safeParse(first).success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [request, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(new URL(String(request)).hostname).toBe(OPEN_METEO_HOSTNAME);
    expect(String(request)).toContain("wind_gusts_10m");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns WEATHER_DATA_UNAVAILABLE instead of a low-risk fallback", async () => {
    const fetchImpl = fetchFor({ reason: "provider down" }, 502);
    try {
      await assessLiveRouteRisk("LIVE-LEJ-WAW", {
        fetchImpl,
        now: () => NOW,
      });
      throw new Error("Expected weather retrieval to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(WeatherDataUnavailableError);
      expect((error as WeatherDataUnavailableError).code).toBe(
        "WEATHER_DATA_UNAVAILABLE",
      );
    }

    const malformed = fetchFor([{ latitude: 0 }]);
    await expect(
      assessLiveRouteRisk("LIVE-LEJ-WAW", {
        fetchImpl: malformed,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(WeatherDataUnavailableError);
  });

  it("reduces confidence and raises a reason code for stale evidence", async () => {
    const staleFetch = fetchFor(
      payload("LIVE-LEJ-WAW", { time: "2026-06-21T09:00" }),
    );
    const stale = await assessLiveRouteRisk("LIVE-LEJ-WAW", {
      fetchImpl: staleFetch,
      now: () => NOW,
    });
    clearWeatherCache();
    const fresh = await assessLiveRouteRisk("LIVE-LEJ-WAW", {
      fetchImpl: fetchFor(payload("LIVE-LEJ-WAW")),
      now: () => NOW,
    });
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.triggeredReasonCodes).toContain("STALE_WEATHER_DATA");
    expect(stale.riskContributions.dataUncertainty).toBeGreaterThan(
      fresh.riskContributions.dataUncertainty,
    );
  });

  it("reports structural, weather, cargo, and uncertainty contributions separately", async () => {
    const result = await assessLiveRouteRisk("LIVE-MUC-IST", {
      fetchImpl: fetchFor(payload("LIVE-MUC-IST", { temperature: 6 })),
      now: () => NOW,
    });
    expect(result.checkpointEvidence).toHaveLength(6);
    expect(result.riskContributions.structuralComplexity).toBeGreaterThan(0);
    expect(result.riskContributions.liveWeatherExposure).toBe(0);
    expect(result.riskContributions.cargoSensitivity).toBeGreaterThan(0);
    expect(result.riskContributions.dataUncertainty).toBe(0);
    expect(result.riskContributions.total).toBe(result.score);
    expect(result.score).toBeLessThan(50);
    expect(result.premiumReportRecommended).toBe(true);
  });

  it("flags temperature exposure for temperature-controlled cargo", async () => {
    const result = await assessLiveRouteRisk("LIVE-HAM-RTM", {
      fetchImpl: fetchFor(payload("LIVE-HAM-RTM", { temperature: 20 })),
      now: () => NOW,
    });
    expect(result.triggeredReasonCodes).toContain(
      "TEMPERATURE_EXPOSURE_OUTSIDE_TOLERANCE",
    );
    expect(
      result.checkpointEvidence.every((checkpoint) =>
        checkpoint.triggeredReasonCodes.includes(
          "TEMPERATURE_EXPOSURE_OUTSIDE_TOLERANCE",
        ),
      ),
    ).toBe(true);
  });

  it("caps an extreme deterministic score inside 0–100", async () => {
    const result = await assessLiveRouteRisk("LIVE-HAM-RTM", {
      fetchImpl: fetchFor(
        payload("LIVE-HAM-RTM", {
          temperature: -10,
          precipitation: 30,
          wind: 100,
          gusts: 140,
          visibility: 100,
          weatherCode: 99,
        }),
      ),
      now: () => NOW,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBe(100);
  });

  it("purchases and redeems a Munich to Istanbul premium report in simulation", async () => {
    const now = new Date();
    const time = now.toISOString().slice(0, 16);
    await assessLiveRouteRisk("LIVE-MUC-IST", {
      fetchImpl: fetchFor(payload("LIVE-MUC-IST", { time, temperature: 20 })),
      now: () => now,
    });
    const result = await new AgentService({} as never).runLiveRoute({
      routeId: "LIVE-MUC-IST",
      executionMode: "SIMULATION",
    });
    expect(result.kind).toBe("COMPLETED");
    if (result.kind !== "COMPLETED") return;
    expect(result.entitlement.status).toBe("REDEEMED");
    expect(result.entitlement.liveRouteId).toBe("LIVE-MUC-IST");
    expect(result.report.reportType).toBe("LIVE_ROUTE");
    if (result.report.reportType !== "LIVE_ROUTE") return;
    expect(result.report.checkpointEvidence).toHaveLength(6);
    expect(result.report.temperatureToleranceAnalysis.exposedCheckpointIds).toHaveLength(6);
    expect(result.report.structuralRouteComplexity.borderCount).toBe(5);
    expect(result.report.riskContributions).toEqual(result.freeAssessment.riskContributions);
    expect(result.report.dataFreshness).toEqual(result.freeAssessment.dataFreshness);
    expect(result.report.operationalRecommendations.length).toBeGreaterThan(0);
    const { reportHash, ...canonicalContent } = result.report;
    expect(reportHash).toBe(sha256(canonicalContent));
    expect(result.verification.status).toBe("SIMULATION_EVIDENCE");
  });

  it("does not create an entitlement when the free live-route assessment is sufficient", async () => {
    const now = new Date();
    const time = now.toISOString().slice(0, 16);
    await assessLiveRouteRisk("LIVE-LEJ-WAW", {
      fetchImpl: fetchFor(payload("LIVE-LEJ-WAW", { time })),
      now: () => now,
    });
    const result = await new AgentService({} as never).runLiveRoute({
      routeId: "LIVE-LEJ-WAW",
      executionMode: "SIMULATION",
    });
    expect(result.kind).toBe("NO_PURCHASE");
    expect(store.entitlements.size).toBe(0);
    expect(store.purchases.size).toBe(0);
  });
});
