import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  config,
  liveHederaConfigured,
  hcsConfigured,
  llmConfigured,
  approvalAuthConfigured,
} from "../config/index.js";
import { AgentService } from "./agent-service.js";
import { getClient } from "../hedera/client.js";
import { SHIPMENTS, SCENARIOS, type ExecutionMode } from "../store/fixtures.js";
import { store } from "../store/store.js";
import { maskAccount } from "../hedera/client.js";
import { getActiveRiskPolicy } from "../risk/policy.js";
import { explainRiskScore } from "../risk/engine.js";
import { getShipment } from "../store/fixtures.js";
import { baseConfig } from "../policy/engine.js";
import {
  governance,
  GovernanceError,
  type GovernanceRole,
  type ProposalInput,
} from "../governance/service.js";
import {
  assessLiveRouteRisk,
  liveRouteCatalog,
  UnknownLiveRouteError,
} from "../live-routes/service.js";
import { WeatherDataUnavailableError } from "../live-routes/open-meteo.js";
import { LiveRouteId, RouteGuardError } from "../domain/index.js";
import { premiumRouteRiskVendor } from "../vendor/premium-route-risk.js";
import {
  DEMO_TENANT_ID,
  PROVIDER_EVIDENCE_SCOPE,
  providerEvidenceService,
} from "../provider-evidence/service.js";

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
    approvalAuthConfigured,
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

app.get("/api/live-routes", (_req, res) => {
  res.json(liveRouteCatalog());
});

function providerEvidenceResponse() {
  const evidence = providerEvidenceService.list(DEMO_TENANT_ID);
  const aliases = [...new Set(evidence.map((record) => record.providerAlias))];
  return {
    scopeLabel: PROVIDER_EVIDENCE_SCOPE,
    persistenceNotice: "The in-memory provider evidence vault resets when the server restarts.",
    evidence,
    reliabilitySignals: aliases.map((alias) =>
      providerEvidenceService.reliabilitySignal(DEMO_TENANT_ID, alias),
    ),
  };
}

function providerEvidenceFailure(res: Response, error: unknown) {
  if (error instanceof RouteGuardError) {
    const statusByCode: Record<string, number> = {
      RG_PROVIDER_EVIDENCE_INVALID: 400,
      RG_PROVIDER_EVIDENCE_TOO_LARGE: 413,
      RG_PROVIDER_EVIDENCE_UNKNOWN_FIELD: 400,
      RG_PROVIDER_EVIDENCE_NOT_FOUND: 404,
    };
    return res.status(statusByCode[error.code] ?? 400).json({
      errorCode: error.code,
      message: error.publicMessage,
    });
  }
  return res.status(500).json({
    errorCode: "RG_PROVIDER_EVIDENCE_INVALID",
    message: "Provider evidence failed safely.",
  });
}

app.get("/api/provider-evidence", (_req, res) => {
  res.json(providerEvidenceResponse());
});

app.post("/api/provider-evidence", (req, res) => {
  try {
    const evidence = providerEvidenceService.create(DEMO_TENANT_ID, req.body);
    return res.status(201).json({
      evidence,
      reliabilitySignal: providerEvidenceService.recalculate(
        DEMO_TENANT_ID,
        evidence.evidenceId,
      ),
      scopeLabel: PROVIDER_EVIDENCE_SCOPE,
    });
  } catch (error) {
    return providerEvidenceFailure(res, error);
  }
});

app.post("/api/provider-evidence/:evidenceId/recalculate", (req, res) => {
  try {
    return res.json({
      reliabilitySignal: providerEvidenceService.recalculate(
        DEMO_TENANT_ID,
        req.params.evidenceId ?? "",
      ),
      scopeLabel: PROVIDER_EVIDENCE_SCOPE,
    });
  } catch (error) {
    return providerEvidenceFailure(res, error);
  }
});

app.post("/api/live-route-risk", async (req, res) => {
  try {
    // Route ID is the only browser-controlled input. Coordinates and cargo
    // tolerances are resolved from the server allowlist.
    res.json(await assessLiveRouteRisk(req.body?.routeId));
  } catch (error) {
    if (error instanceof UnknownLiveRouteError)
      return res.status(400).json({
        errorCode: error.code,
        message: error.message,
      });
    const unavailable =
      error instanceof WeatherDataUnavailableError
        ? error
        : new WeatherDataUnavailableError();
    return res.status(503).json({
      errorCode: unavailable.code,
      message: unavailable.message,
      status: "UNAVAILABLE",
      manualReviewRequired: true,
    });
  }
});

app.get("/api/policies/risk/active", (_req, res) => {
  res.json(getActiveRiskPolicy());
});

app.get("/api/policies/risk/explain/:shipmentId", (req, res) => {
  const shipment = getShipment(req.params.shipmentId ?? "");
  if (!shipment)
    return res.status(404).json({
      errorCode: "RG_GOVERNANCE_SHIPMENT_NOT_FOUND",
      message: "Unknown synthetic shipment.",
    });
  res.json(explainRiskScore(shipment));
});

app.get("/api/policies/payment/active", (_req, res) => {
  const payment = baseConfig();
  res.json({
    policyVersion: payment.policyVersion,
    status: "LOCKED",
    mutableThroughGovernance: false,
    network: payment.network,
    liveExecutionEnabled: payment.liveExecutionEnabled,
    enableHederaTx: config.ENABLE_HEDERA_TX,
    liveTestnetPaymentsEnabled: config.LIVE_TESTNET_PAYMENTS_ENABLED,
    approvalAuthConfigured,
    vendorId: config.vendor.vendorId,
    vendorAccountId: config.HEDERA_VENDOR_ACCOUNT_ID
      ? maskAccount(config.HEDERA_VENDOR_ACCOUNT_ID)
      : "not configured",
    sku: config.vendor.sku,
    catalogPriceTinybars: config.CATALOG_PRICE_TINYBARS,
    maxPerPurchaseTinybars: payment.maxPerPurchaseTinybars,
    autoApproveAtOrBelowTinybars: payment.autoApproveAtOrBelowTinybars,
    dailyBudgetTinybars: payment.dailyBudgetTinybars,
    approvalAuthenticationRequiredForLiveTestnet: true,
    immutableRules: [
      "Hedera testnet only",
      "Both live-payment kill switches must be explicitly enabled",
      "Vendor, account, SKU, amount, and network are server-controlled",
      "Hard payment cap cannot be overridden by approval",
      "Replay and transaction-integrity policies always execute",
      "Secrets are never exposed to browser governance",
    ],
  });
});

app.get("/api/policy-proposals", (_req, res) => {
  res.json({
    proposals: governance.list(),
    history: governance.history(),
    governance: governance.getConfiguration(),
  });
});

function governanceFailure(res: Response, error: unknown): void {
  if (error instanceof GovernanceError) {
    res.status(error.statusCode).json({ errorCode: error.code, message: error.message });
    return;
  }
  res.status(500).json({
    errorCode: "RG_GOVERNANCE_INTERNAL",
    message: "Governance simulation failed safely.",
  });
}

app.post("/api/policy-proposals/preview", (req, res) => {
  try {
    res.json({ impactPreview: governance.preview(req.body as ProposalInput) });
  } catch (error) {
    governanceFailure(res, error);
  }
});

app.post("/api/policy-proposals", (req, res) => {
  try {
    res.status(201).json(governance.submit(req.body as ProposalInput));
  } catch (error) {
    governanceFailure(res, error);
  }
});

app.post("/api/policy-proposals/:proposalId/approve", (req, res) => {
  try {
    res.json(
      governance.approve(
        req.params.proposalId ?? "",
        req.body?.role as GovernanceRole,
        String(req.body?.proposalHash ?? ""),
      ),
    );
  } catch (error) {
    governanceFailure(res, error);
  }
});

app.post("/api/policy-proposals/:proposalId/reject", (req, res) => {
  try {
    res.json(
      governance.reject(
        req.params.proposalId ?? "",
        req.body?.role as GovernanceRole,
        String(req.body?.proposalHash ?? ""),
      ),
    );
  } catch (error) {
    governanceFailure(res, error);
  }
});

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
      req.body?.executionMode === "AUTONOMOUS_TESTNET"
        ? "AUTONOMOUS_TESTNET"
        : "SIMULATION";
    const svc = serviceCache.get(proposalId) ?? makeService();
    // No auth middleware exists yet, so no verified approver context is supplied.
    // AgentService therefore refuses every live-testnet approval at this boundary.
    const result = await svc.approveAndExecute(proposalId, mode);
    res.json(result);
  } catch (err) {
    res.status(500).json({ kind: "FAILED", errorCode: "RG_HEDERA_SUBMISSION_FAILED", message: String(err) });
  }
});

app.post("/api/approvals/:proposalId/reject", liveRateLimit, async (req, res) => {
  try {
    const proposalId = req.params.proposalId ?? "";
    const mode: ExecutionMode =
      req.body?.executionMode === "AUTONOMOUS_TESTNET"
        ? "AUTONOMOUS_TESTNET"
        : "SIMULATION";
    const svc = serviceCache.get(proposalId) ?? makeService();
    const result = await svc.rejectProposal(proposalId, mode);
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
  const approval = store.approvals.get(proposalId);
  if (!proposal) return res.status(404).json({ error: "not found" });
  res.json({ proposal, decision, purchase, approval });
});

app.post("/api/agent/live-route/run", liveRateLimit, async (req, res) => {
  try {
    const parsedRouteId = LiveRouteId.safeParse(req.body?.routeId);
    if (!parsedRouteId.success)
      return res.status(400).json({
        kind: "FAILED",
        errorCode: "UNKNOWN_LIVE_ROUTE",
        message: "The requested live route is not allowlisted.",
      });
    const mode: ExecutionMode =
      req.body?.executionMode === "AUTONOMOUS_TESTNET" &&
      liveHederaConfigured
        ? "AUTONOMOUS_TESTNET"
        : "SIMULATION";
    const svc = makeService();
    const result = await svc.runLiveRoute({
      routeId: parsedRouteId.data,
      executionMode: mode,
    });
    if ("proposalId" in result && result.proposalId)
      serviceCache.set(result.proposalId, svc);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      kind: "FAILED",
      errorCode: "RG_VENDOR_API_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "Live-route purchase failed safely.",
    });
  }
});

app.post("/api/vendor/premium-route-risk/redeem", (req, res) => {
  try {
    const keys =
      req.body && typeof req.body === "object" ? Object.keys(req.body) : [];
    if (keys.length !== 1 || keys[0] !== "token")
      throw new RouteGuardError(
        "RG_ENTITLEMENT_REQUIRED",
        "The vendor API accepts only an opaque entitlement token.",
      );
    res.json(premiumRouteRiskVendor.redeem(req.body.token));
  } catch (error) {
    if (error instanceof RouteGuardError) {
      const statusByCode: Record<string, number> = {
        RG_ENTITLEMENT_REQUIRED: 400,
        RG_ENTITLEMENT_NOT_FOUND: 404,
        RG_ENTITLEMENT_EXPIRED: 410,
        RG_ENTITLEMENT_REPLAYED: 409,
        RG_ENTITLEMENT_MISMATCH: 409,
        RG_PURCHASE_NOT_COMPLETED: 409,
      };
      const status = statusByCode[error.code] ?? 500;
      return res.status(status).json({
        errorCode: error.code,
        message: error.publicMessage,
      });
    }
    return res.status(500).json({
      errorCode: "RG_VENDOR_API_FAILED",
      message: "Premium vendor API failed safely.",
    });
  }
});

app.post("/api/sandbox/reset", (_req, res) => {
  store.reset();
  governance.reset();
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
