import {
  LiveFreightRouteSchema,
  type LiveFreightRoute,
  type LiveRouteId,
} from "../domain/index.js";

const ROUTE_SOURCE: LiveFreightRoute[] = [
  {
    id: "LIVE-HAM-RTM",
    origin: "Hamburg",
    destination: "Rotterdam",
    cargo: "Temperature controlled freight",
    cargoProfile: "TEMPERATURE_CONTROLLED",
    temperatureToleranceC: { minimum: 2, maximum: 8 },
    checkpoints: [
      { id: "HAM", name: "Hamburg", role: "ORIGIN", latitude: 53.5511, longitude: 9.9937 },
      { id: "BRE", name: "Bremen checkpoint", role: "CHECKPOINT", latitude: 53.0793, longitude: 8.8017 },
      { id: "RTM", name: "Rotterdam", role: "DESTINATION", latitude: 51.9244, longitude: 4.4777 },
    ],
  },
  {
    id: "LIVE-MUC-MIL",
    origin: "Munich",
    destination: "Milan",
    cargo: "Fragile / high-value freight",
    cargoProfile: "FRAGILE_HIGH_VALUE",
    temperatureToleranceC: { minimum: -5, maximum: 30 },
    checkpoints: [
      { id: "MUC", name: "Munich", role: "ORIGIN", latitude: 48.1351, longitude: 11.582 },
      { id: "INN", name: "Innsbruck Alpine checkpoint", role: "CHECKPOINT", latitude: 47.2692, longitude: 11.4041 },
      { id: "MIL", name: "Milan", role: "DESTINATION", latitude: 45.4642, longitude: 9.19 },
    ],
  },
  {
    id: "LIVE-LEJ-WAW",
    origin: "Leipzig",
    destination: "Warsaw",
    cargo: "General cargo",
    cargoProfile: "GENERAL_CARGO",
    temperatureToleranceC: { minimum: -20, maximum: 40 },
    checkpoints: [
      { id: "LEJ", name: "Leipzig", role: "ORIGIN", latitude: 51.3397, longitude: 12.3731 },
      { id: "WRO", name: "Wrocław checkpoint", role: "CHECKPOINT", latitude: 51.1079, longitude: 17.0385 },
      { id: "WAW", name: "Warsaw", role: "DESTINATION", latitude: 52.2297, longitude: 21.0122 },
    ],
  },
];

export const LIVE_ROUTES = LiveFreightRouteSchema.array().length(3).parse(ROUTE_SOURCE);

export function listLiveRoutes(): LiveFreightRoute[] {
  return structuredClone(LIVE_ROUTES);
}

export function getLiveRoute(routeId: LiveRouteId): LiveFreightRoute {
  const route = LIVE_ROUTES.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`Unknown allowlisted live route ${routeId}.`);
  return structuredClone(route);
}
