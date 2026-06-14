import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config, liveHederaConfigured, hcsConfigured, llmConfigured } from "../config/index.js";
import { AgentService } from "./agent-service.js";
import { getClient } from "../hedera/client.js";
import { SHIPMENTS, SCENARIOS, type ExecutionMode } from "../store/fixtures.js";
import { store } from "../store/store.js";
import { maskAccount } from "../hedera/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "256kb" }));

/* ----------------------------- rate limiting ------------------------------ */
const ipHits = new Map<string, { hour: number; count: number }>();
let globalLiveToday = { day: "", count: 0 };

function liveRateLimit(req: Request, res: Response, next: NextFunction) {
  const mode = (req.body?.executionMode ?? "SIMULATION") as ExecutionMode;
  if (mode !== "AUTONOMOUS_TESTNET") return next();

  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13);
  const dayKey = now.toISOString().slice(0, 10);
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0] ?? req.ip ?? "anon";

  const rec = ipHits.get(ip);
  const ipCount = rec && rec.hour === Number(hourKey.replace(/\D/g, "")) ? rec.count : 0;
  if (ipCount >= config.PUBLIC_LIVE_PURCHASES_PER_IP_PER_HOUR)
    return res.status(429).json({ kind: "FAILED", errorCode: "RG_RATE_LIMITED", message: "Per-IP live purchase limit reached. Use simulation mode." });

  if (globalLiveToday.day !== dayKey) globalLiveToday = { day: dayKey, count: 0 };
  if (globalLiveToday.count >= config.PUBLIC_GLOBAL_LIVE_PURCHASES_PER_DAY)
    return res.status(429).json({ kind: "FAILED", errorCode: "RG_RATE_LIMITED", message: "Global daily live-purchase cap reached. Use simulation mode." });

  ipHits.set(ip, { hour: Number(hourKey.replace(/\D/g, "")), count: ipCount + 1 });
  globalLiveToday.count += 1;
  next();
}

/* ------------------------------- service ---------------------------------- */
// A client is only needed for live testnet mode; in simulation we never touch it.
function makeService(): AgentService {
  const client = liveHederaConfigured ? getClient() : ({} as never);
  return new AgentService(client);
}

/* -------------------------------- routes ---------------------------------- */

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hederaNetwork: "testnet",
    hcsConfigured,
    livePaymentsEnabled: liveHederaConfigured,
    llmConfigured,
    version: "1.0.0",
  });
});

app.get("/api/catalog", (_req, res) => {
  res.json({
    vendorId: config.vendor.vendorId,
    vendorAccountId: config.HEDERA_VENDOR_ACCOUNT_ID
      ? maskAccount(config.HEDERA_VENDOR_ACCOUNT_ID)
      : "0.0.(set HEDERA_VENDOR_ACCOUNT_ID)",
    sku: config.vendor.sku,
    serviceCategory: config.vendor.serviceCategory,
    priceTinybars: config.CATALOG_PRICE_TINYBARS,
    priceHbar: config.CATALOG_PRICE_TINYBARS / 100_000_000,
    network: "testnet",
  });
});

app.get("/api/shipments", (_req, res) => res.json(SHIPMENTS));
app.get("/api/scenarios", (_req, res) =>
  res.json(
    SCENARIOS.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      shipmentId: s.shipmentId,
      expectation: s.expectation,
    })),
  ),
);

app.post("/api/agent/run", liveRateLimit, async (req, res) => {
  try {
    const { shipmentId, scenarioId, executionMode } = req.body ?? {};
    const mode: ExecutionMode =
      executionMode === "AUTONOMOUS_TESTNET" && liveHederaConfigured
        ? "AUTONOMOUS_TESTNET"
        : "SIMULATION";
    const svc = makeService();
    const result = await svc.run({ shipmentId, scenarioId, executionMode: mode });
    // Stash the orchestrator so approval can reuse lifecycle state for the demo.
    serviceCache.set(result.kind === "FAILED" ? "_" : (result as { proposalId?: string }).proposalId ?? "_", svc);
    res.json(result);
  } catch (err) {
    res.status(500).json({ kind: "FAILED", errorCode: "RG_HEDERA_SUBMISSION_FAILED", message: String(err) });
  }
});

const serviceCache = new Map<string, AgentService>();

app.post("/api/approvals/:proposalId", liveRateLimit, async (req, res) => {
  try {
    const proposalId = req.params.proposalId ?? "";
    const mode: ExecutionMode =
      req.body?.executionMode === "AUTONOMOUS_TESTNET" && liveHederaConfigured
        ? "AUTONOMOUS_TESTNET"
        : "SIMULATION";
    const svc = serviceCache.get(proposalId) ?? makeService();
    const result = await svc.approveAndExecute(proposalId, mode);
    res.json(result);
  } catch (err) {
    res.status(500).json({ kind: "FAILED", errorCode: "RG_HEDERA_SUBMISSION_FAILED", message: String(err) });
  }
});

app.get("/api/purchases/:proposalId", (req, res) => {
  const proposalId = req.params.proposalId ?? "";
  const proposal = store.proposals.get(proposalId);
  const purchase = store.purchases.get(proposalId);
  const decision = store.decisions.get(proposalId);
  if (!proposal) return res.status(404).json({ error: "not found" });
  res.json({ proposal, decision, purchase });
});

app.post("/api/sandbox/reset", (_req, res) => {
  store.reset();
  serviceCache.clear();
  res.json({ ok: true, message: "Local demo state reset. On-chain history is never deleted." });
});

/* ------------------------------ static UI --------------------------------- */
app.use(express.static(path.join(__dirname, "..", "..", "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "..", "public", "index.html")),
);

const port = config.PORT;
app.listen(port, () => {
  console.log(`\n  RouteGuard Pay Agent`);
  console.log(`  The LLM proposes. Policy decides. Hedera proves.\n`);
  console.log(`  ▸ http://localhost:${port}`);
  console.log(`  ▸ network: testnet`);
  console.log(`  ▸ live testnet payments: ${liveHederaConfigured ? "ENABLED" : "disabled (simulation)"}`);
  console.log(`  ▸ HCS audit: ${hcsConfigured ? "configured" : "local-hash only"}`);
  console.log(`  ▸ LLM: ${llmConfigured ? config.LLM_MODEL : "heuristic fallback (no key)"}\n`);
});
