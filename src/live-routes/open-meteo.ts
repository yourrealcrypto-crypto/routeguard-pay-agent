import { z } from "zod";
import type {
  LiveFreightRoute,
  LiveRouteId,
  WeatherCheckpointEvidence,
} from "../domain/index.js";

export const OPEN_METEO_HOSTNAME = "api.open-meteo.com";
export const OPEN_METEO_TIMEOUT_MS = 5_000;
export const WEATHER_CACHE_TTL_MS = 10 * 60 * 1_000;

const CurrentWeatherSchema = z.object({
  time: z.string().min(1),
  temperature_2m: z.number().finite(),
  precipitation: z.number().finite().nonnegative(),
  wind_speed_10m: z.number().finite().nonnegative(),
  wind_gusts_10m: z.number().finite().nonnegative(),
  weather_code: z.number().int().nonnegative(),
});

const LocationWeatherSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  current: CurrentWeatherSchema,
  hourly: z.object({
    time: z.array(z.string().min(1)).min(1),
    visibility: z.array(z.number().finite().nonnegative().nullable()).min(1),
  }),
});

const MultiLocationWeatherSchema = z.array(LocationWeatherSchema).min(3).max(6);

export class WeatherDataUnavailableError extends Error {
  readonly code = "WEATHER_DATA_UNAVAILABLE";

  constructor(message = "Current route weather evidence is unavailable.") {
    super(message);
    this.name = "WeatherDataUnavailableError";
  }
}

export interface RouteWeatherEvidence {
  routeId: LiveRouteId;
  dataSource: "LIVE" | "CACHE";
  retrievedAt: string;
  sourceTimestamp: string;
  checkpointEvidence: WeatherCheckpointEvidence[];
}

interface CacheEntry {
  expiresAt: number;
  value: Omit<RouteWeatherEvidence, "dataSource">;
}

const weatherCache = new Map<LiveRouteId, CacheEntry>();

export function clearWeatherCache(): void {
  weatherCache.clear();
}

function utcTimestamp(value: string): string {
  const explicitZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const timestamp = Date.parse(explicitZone ? value : `${value}Z`);
  if (!Number.isFinite(timestamp))
    throw new WeatherDataUnavailableError("Weather source timestamp is invalid.");
  return new Date(timestamp).toISOString();
}

function nearestVisibility(
  times: string[],
  values: Array<number | null>,
  sourceTimestamp: string,
): number {
  if (times.length !== values.length)
    throw new WeatherDataUnavailableError("Visibility evidence is malformed.");
  const sourceMs = Date.parse(sourceTimestamp);
  let nearest: { distance: number; value: number } | null = null;
  for (let index = 0; index < times.length; index += 1) {
    const value = values[index];
    if (value == null) continue;
    const observedAt = Date.parse(utcTimestamp(times[index]!));
    const distance = Math.abs(observedAt - sourceMs);
    if (!nearest || distance < nearest.distance) nearest = { distance, value };
  }
  if (!nearest)
    throw new WeatherDataUnavailableError("Visibility evidence is unavailable.");
  return nearest.value;
}

function forecastUrl(route: LiveFreightRoute): URL {
  const url = new URL(`https://${OPEN_METEO_HOSTNAME}/v1/forecast`);
  url.searchParams.set(
    "latitude",
    route.checkpoints.map((checkpoint) => checkpoint.latitude).join(","),
  );
  url.searchParams.set(
    "longitude",
    route.checkpoints.map((checkpoint) => checkpoint.longitude).join(","),
  );
  url.searchParams.set(
    "current",
    "temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,weather_code",
  );
  url.searchParams.set("hourly", "visibility");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("wind_speed_unit", "kmh");
  if (url.protocol !== "https:" || url.hostname !== OPEN_METEO_HOSTNAME)
    throw new WeatherDataUnavailableError("Weather provider is not allowlisted.");
  return url;
}

export async function retrieveRouteWeather(
  route: LiveFreightRoute,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
  } = {},
): Promise<RouteWeatherEvidence> {
  const now = options.now?.() ?? new Date();
  const cached = weatherCache.get(route.id);
  if (cached && cached.expiresAt > now.getTime())
    return structuredClone({ ...cached.value, dataSource: "CACHE" as const });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? OPEN_METEO_TIMEOUT_MS,
  );

  try {
    const response = await (options.fetchImpl ?? fetch)(forecastUrl(route), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new WeatherDataUnavailableError(
        `Weather provider returned HTTP ${response.status}.`,
      );
    const parsed = MultiLocationWeatherSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.length !== route.checkpoints.length)
      throw new WeatherDataUnavailableError("Weather provider response failed validation.");

    const checkpointEvidence = parsed.data.map((location, index) => {
      const checkpoint = route.checkpoints[index]!;
      if (
        Math.abs(location.latitude - checkpoint.latitude) > 0.25 ||
        Math.abs(location.longitude - checkpoint.longitude) > 0.25
      )
        throw new WeatherDataUnavailableError(
          "Weather provider returned evidence for an unexpected coordinate.",
        );
      const sourceTimestamp = utcTimestamp(location.current.time);
      return {
        ...checkpoint,
        temperatureC: location.current.temperature_2m,
        precipitationMm: location.current.precipitation,
        windSpeedKph: location.current.wind_speed_10m,
        windGustsKph: location.current.wind_gusts_10m,
        visibilityM: nearestVisibility(
          location.hourly.time,
          location.hourly.visibility,
          sourceTimestamp,
        ),
        weatherCode: location.current.weather_code,
        sourceTimestamp,
        triggeredReasonCodes: [],
      } satisfies WeatherCheckpointEvidence;
    });
    const retrievedAt = now.toISOString();
    const sourceTimestamp = checkpointEvidence
      .map((checkpoint) => checkpoint.sourceTimestamp)
      .sort()[0]!;
    const value = {
      routeId: route.id,
      retrievedAt,
      sourceTimestamp,
      checkpointEvidence,
    };
    weatherCache.set(route.id, {
      expiresAt: now.getTime() + WEATHER_CACHE_TTL_MS,
      value: structuredClone(value),
    });
    return { ...structuredClone(value), dataSource: "LIVE" };
  } catch (error) {
    if (error instanceof WeatherDataUnavailableError) throw error;
    throw new WeatherDataUnavailableError(
      error instanceof Error && error.name === "AbortError"
        ? "Weather provider timed out after five seconds."
        : "Weather retrieval or validation failed.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
