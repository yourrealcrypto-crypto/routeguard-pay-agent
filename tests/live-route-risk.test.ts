import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRouteRiskResultSchema } from "../src/domain/index.js";
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

const NOW = new Date("2026-06-21T12:30:00.000Z");

function payload(
  routeId: "LIVE-HAM-RTM" | "LIVE-MUC-MIL" | "LIVE-LEJ-WAW",
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
  beforeEach(() => clearWeatherCache());

  it("contains exactly the three allowlisted routes and their checkpoints", () => {
    const routes = listLiveRoutes();
    expect(routes.map((route) => route.id)).toEqual([
      "LIVE-HAM-RTM",
      "LIVE-MUC-MIL",
      "LIVE-LEJ-WAW",
    ]);
    expect(routes.every((route) => route.checkpoints.length === 3)).toBe(true);
    expect(routes[1]?.checkpoints[1]?.name).toContain("Alpine");
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
    expect(second.score).toBe(first.score);
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
});
