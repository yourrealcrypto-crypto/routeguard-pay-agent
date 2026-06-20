import { z } from "zod";
import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/*  Canonical JSON + hashing                                                  */
/*  Deterministic key ordering so the same logical object always hashes the   */
/*  same way — this is what makes our policy + report hashes verifiable.      */
/* -------------------------------------------------------------------------- */

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  const input = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(input).digest("hex");
}

/* -------------------------------------------------------------------------- */
/*  Money — integer tinybars only. Never floats in a payment decision.        */
/* -------------------------------------------------------------------------- */

export const TINYBARS_PER_HBAR = 100_000_000;
export const tinybarsToHbarDisplay = (t: number): string =>
  `${(t / TINYBARS_PER_HBAR).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  })} HBAR`;

/* -------------------------------------------------------------------------- */
/*  Shipment                                                                  */
/* -------------------------------------------------------------------------- */

export const ShipmentSchema = z.object({
  id: z.string().regex(/^RG-\d{4}$/),
  origin: z.object({ city: z.string(), countryCode: z.string().length(2) }),
  destination: z.object({
    city: z.string(),
    countryCode: z.string().length(2),
  }),
  mode: z.enum(["road", "ocean", "air", "rail"]),
  cargoType: z.enum([
    "general",
    "temperature_controlled",
    "fragile",
    "high_value",
  ]),
  cargoValueEur: z.number().nonnegative(),
  promisedDeliveryAt: z.string().datetime(),
  riskSignals: z.array(z.string()).max(10),
  /** Free-tier model confidence, 0–1. Low confidence is a real reason to buy premium. */
  freeAssessmentConfidence: z.number().min(0).max(1),
  /** UNTRUSTED free text. Must never alter vendor, price, policy, or execution. */
  notes: z.string().max(500).optional(),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

/* -------------------------------------------------------------------------- */
/*  Live freight routes + weather evidence                                    */
/* -------------------------------------------------------------------------- */

export const LiveRouteId = z.enum([
  "LIVE-HAM-RTM",
  "LIVE-MUC-MIL",
  "LIVE-LEJ-WAW",
]);
export type LiveRouteId = z.infer<typeof LiveRouteId>;

export const LiveCargoProfile = z.enum([
  "TEMPERATURE_CONTROLLED",
  "FRAGILE_HIGH_VALUE",
  "GENERAL_CARGO",
]);
export type LiveCargoProfile = z.infer<typeof LiveCargoProfile>;

export const LiveRouteCheckpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["ORIGIN", "CHECKPOINT", "DESTINATION"]),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type LiveRouteCheckpoint = z.infer<
  typeof LiveRouteCheckpointSchema
>;

export const LiveFreightRouteSchema = z.object({
  id: LiveRouteId,
  origin: z.string(),
  destination: z.string(),
  cargo: z.string(),
  cargoProfile: LiveCargoProfile,
  temperatureToleranceC: z.object({ minimum: z.number(), maximum: z.number() }),
  checkpoints: z.array(LiveRouteCheckpointSchema).length(3),
});
export type LiveFreightRoute = z.infer<typeof LiveFreightRouteSchema>;

export const WeatherCheckpointEvidenceSchema = LiveRouteCheckpointSchema.extend({
  temperatureC: z.number(),
  precipitationMm: z.number().nonnegative(),
  windSpeedKph: z.number().nonnegative(),
  windGustsKph: z.number().nonnegative(),
  visibilityM: z.number().nonnegative(),
  weatherCode: z.number().int().nonnegative(),
  sourceTimestamp: z.string().datetime(),
  triggeredReasonCodes: z.array(z.string()).default([]),
});
export type WeatherCheckpointEvidence = z.infer<
  typeof WeatherCheckpointEvidenceSchema
>;

export const WeatherRiskRuleResultSchema = z.object({
  code: z.string(),
  contribution: z.number().nonnegative(),
  checkpointIds: z.array(z.string()),
  explanation: z.string(),
});
export type WeatherRiskRuleResult = z.infer<
  typeof WeatherRiskRuleResultSchema
>;

export const LiveRouteRiskResultSchema = z.object({
  route: LiveFreightRouteSchema,
  status: z.literal("AVAILABLE"),
  dataSource: z.enum(["LIVE", "CACHE"]),
  retrievedAt: z.string().datetime(),
  sourceTimestamp: z.string().datetime(),
  score: z.number().int().min(0).max(100),
  riskBand: z.enum(["low", "moderate", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  triggeredReasonCodes: z.array(z.string()),
  triggeredRules: z.array(WeatherRiskRuleResultSchema),
  checkpointEvidence: z.array(WeatherCheckpointEvidenceSchema).length(3),
  policyVersion: z.string(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  premiumReportRecommended: z.boolean(),
  purchaseMode: z.literal("SIMULATION_ONLY"),
  disclaimer: z.string(),
});
export type LiveRouteRiskResult = z.infer<
  typeof LiveRouteRiskResultSchema
>;

/* -------------------------------------------------------------------------- */
/*  Service catalog (server-controlled)                                       */
/* -------------------------------------------------------------------------- */

export const ServiceCatalogItemSchema = z.object({
  vendorId: z.literal("route-risk-labs"),
  vendorAccountId: z.string(),
  serviceCategory: z.literal("logistics.route-risk"),
  sku: z.literal("premium-route-risk-v1"),
  version: z.literal("1.0"),
  priceTinybars: z.number().int().positive(),
  currency: z.literal("HBAR"),
  network: z.literal("testnet"),
  active: z.boolean(),
});
export type ServiceCatalogItem = z.infer<typeof ServiceCatalogItemSchema>;

/* -------------------------------------------------------------------------- */
/*  Policy profiles + statuses                                                */
/* -------------------------------------------------------------------------- */

export const PolicyProfile = z.enum([
  "standard",
  "strict",
  "budget_exhausted",
  "blocked_vendor",
]);
export type PolicyProfile = z.infer<typeof PolicyProfile>;

export const ProposalStatus = z.enum([
  "PROPOSED",
  "AUTO_APPROVED",
  "APPROVAL_REQUIRED",
  "HUMAN_APPROVED",
  "REJECTED",
  "BLOCKED",
  "EXECUTING",
  "PAYMENT_CONFIRMED",
  "API_UNLOCKED",
  "COMPLETED",
  "FAILED",
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/* -------------------------------------------------------------------------- */
/*  Purchase proposal                                                         */
/* -------------------------------------------------------------------------- */

export const PurchaseProposalSchema = z.object({
  id: z.string().uuid(),
  shipmentId: z.string(),
  requestedSku: z.literal("premium-route-risk-v1"),
  rationale: z.string().min(20).max(800),
  expectedBenefit: z.string().min(10).max(500),
  status: ProposalStatus,
  policyProfile: PolicyProfile,
  createdAt: z.string().datetime(),
});
export type PurchaseProposal = z.infer<typeof PurchaseProposalSchema>;

export type ApprovalMode =
  | "SIMULATED_DEMO"
  | "AUTHENTICATED_LIVE_TESTNET";
export type ApprovalStatus = "APPROVED" | "IN_USE" | "USED" | "REJECTED";

export interface ApprovalRecord {
  proposalId: string;
  proposalHash: string;
  policyHash: string;
  mode: ApprovalMode;
  status: ApprovalStatus;
  approverLabel: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  usedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Policy results                                                            */
/* -------------------------------------------------------------------------- */

export const PolicyOutcome = z.enum(["PASS", "REQUIRE_APPROVAL", "BLOCK"]);
export type PolicyOutcome = z.infer<typeof PolicyOutcome>;

export const PolicyCheckSchema = z.object({
  policyId: z.string(),
  name: z.string(),
  outcome: PolicyOutcome,
  reasonCode: z.string(),
  publicMessage: z.string(),
  evidence: z.record(z.string(), z.unknown()),
});
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const PolicyDecision = z.enum([
  "ALLOW_AUTONOMOUS",
  "REQUIRE_APPROVAL",
  "BLOCK",
]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const PolicyDecisionResultSchema = z.object({
  decision: PolicyDecision,
  checks: z.array(PolicyCheckSchema),
  policyVersion: z.literal("1.0"),
  canonicalHash: z.string(),
  evaluatedAt: z.string().datetime(),
});
export type PolicyDecisionResult = z.infer<typeof PolicyDecisionResultSchema>;

/* -------------------------------------------------------------------------- */
/*  Payment proof                                                             */
/* -------------------------------------------------------------------------- */

export const PaymentProofSchema = z.object({
  network: z.literal("testnet"),
  mode: z.enum(["SIMULATION", "AUTONOMOUS_TESTNET"]),
  transactionId: z.string(),
  payerAccountId: z.string(),
  vendorAccountId: z.string(),
  amountTinybars: z.number().int(),
  memo: z.string(),
  consensusTimestamp: z.string().nullable(),
  result: z.literal("SUCCESS"),
  explorerUrl: z.string(),
});
export type PaymentProof = z.infer<typeof PaymentProofSchema>;

/** Evidence retained when Hedera accepted a transaction but a later receipt or
 * verification step failed before a full PaymentProof could be produced. */
export const SubmittedTransactionEvidenceSchema = z.object({
  network: z.literal("testnet"),
  mode: z.literal("AUTONOMOUS_TESTNET"),
  transactionId: z.string(),
  hashscanUrl: z.string(),
  vendorAccountId: z.string(),
  amountTinybars: z.number().int(),
  memo: z.string(),
});
export type SubmittedTransactionEvidence = z.infer<
  typeof SubmittedTransactionEvidenceSchema
>;

/* -------------------------------------------------------------------------- */
/*  Authoritative verification result                                         */
/* -------------------------------------------------------------------------- */

export const VerificationStatus = z.enum([
  "SIMULATION_EVIDENCE",
  "VERIFICATION_PENDING",
  "VERIFIED_ON_HEDERA",
  "PARTIALLY_VERIFIED",
  "VERIFICATION_FAILED",
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const MirrorNodeConfirmation = z.enum([
  "NOT_APPLICABLE",
  "PENDING",
  "CONFIRMED",
  "FAILED",
]);
export type MirrorNodeConfirmation = z.infer<
  typeof MirrorNodeConfirmation
>;

export const HcsAnchoringStatus = z.enum([
  "NOT_APPLICABLE",
  "NOT_CONFIGURED",
  "PENDING",
  "ANCHORED",
  "PARTIAL",
  "FAILED",
]);
export type HcsAnchoringStatus = z.infer<typeof HcsAnchoringStatus>;

export const VerificationResultSchema = z.object({
  status: VerificationStatus,
  executionMode: z.enum(["SIMULATION", "AUTONOMOUS_TESTNET"]),
  transactionSubmitted: z.boolean(),
  transactionId: z.string().nullable(),
  hashscanUrl: z.string().nullable(),
  vendorAccountId: z.string().nullable(),
  amountTinybars: z.number().int().nullable(),
  memo: z.string().nullable(),
  mirrorNodeConfirmation: MirrorNodeConfirmation,
  consensusTimestamp: z.string().nullable(),
  hcsConfigured: z.boolean(),
  hcsAnchoringStatus: HcsAnchoringStatus,
  hcsTopicId: z.string().nullable(),
  hcsSequenceNumbers: z.array(z.number().int().nonnegative()),
  reportHash: z.string().nullable(),
  policyHash: z.string().nullable(),
  policyVersion: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

/* -------------------------------------------------------------------------- */
/*  Premium report                                                            */
/* -------------------------------------------------------------------------- */

export const RiskBand = z.enum(["low", "moderate", "high", "critical"]);
export type RiskBand = z.infer<typeof RiskBand>;

export const PremiumReportSchema = z.object({
  reportId: z.string().uuid(),
  shipmentId: z.string(),
  riskScore: z.number().int().min(0).max(100),
  riskBand: RiskBand,
  confidence: z.number().min(0).max(1),
  factors: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      contribution: z.number(),
      explanation: z.string(),
    }),
  ),
  recommendedControls: z.array(z.string()),
  totalBeforeCap: z.number().nonnegative(),
  evaluatedAt: z.string().datetime(),
  generatedAt: z.string().datetime(),
  algorithmVersion: z.literal("route-risk-1.0"),
  policyVersion: z.string(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  paymentTransactionId: z.string(),
  reportHash: z.string(),
  disclaimer: z.string(),
});
export type PremiumReport = z.infer<typeof PremiumReportSchema>;

export const BasicReportSchema = z.object({
  shipmentId: z.string(),
  riskBand: RiskBand,
  confidence: z.number().min(0).max(1),
  evaluatedAt: z.string().datetime(),
  policyVersion: z.string(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  visibleFactors: z.array(z.object({ label: z.string(), note: z.string() })),
  upsell: z.string(),
});
export type BasicReport = z.infer<typeof BasicReportSchema>;

/* -------------------------------------------------------------------------- */
/*  Audit events                                                              */
/* -------------------------------------------------------------------------- */

export const AuditEventType = z.enum([
  "PURCHASE_PROPOSED",
  "POLICY_AUTO_APPROVED",
  "POLICY_APPROVAL_REQUIRED",
  "POLICY_BLOCKED",
  "HUMAN_APPROVED",
  "HUMAN_REJECTED",
  "PAYMENT_SUBMITTED",
  "PAYMENT_CONFIRMED",
  "API_ACCESS_GRANTED",
  "REPORT_DELIVERED",
  "EXECUTION_FAILED",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export interface AuditAnchor {
  eventType: AuditEventType;
  payloadHash: string;
  hcsTopicId: string | null;
  hcsSequenceNumber: number | null;
  hcsTransactionId: string | null;
  hcsStatus: "ANCHORED" | "PENDING" | "FAILED" | "SKIPPED_SIMULATION";
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Stable error codes                                                        */
/* -------------------------------------------------------------------------- */

export const RGError = {
  POLICY_VENDOR_BLOCKED: "RG_POLICY_VENDOR_BLOCKED",
  POLICY_SERVICE_BLOCKED: "RG_POLICY_SERVICE_BLOCKED",
  POLICY_SHIPMENT_INELIGIBLE: "RG_POLICY_SHIPMENT_INELIGIBLE",
  POLICY_PER_PURCHASE_CAP: "RG_POLICY_PER_PURCHASE_CAP",
  POLICY_APPROVAL_REQUIRED: "RG_POLICY_APPROVAL_REQUIRED",
  POLICY_DAILY_BUDGET: "RG_POLICY_DAILY_BUDGET",
  POLICY_REPLAY: "RG_POLICY_REPLAY",
  POLICY_TRANSACTION_INTEGRITY: "RG_POLICY_TRANSACTION_INTEGRITY",
  HEDERA_SUBMISSION_FAILED: "RG_HEDERA_SUBMISSION_FAILED",
  HEDERA_RECEIPT_FAILED: "RG_HEDERA_RECEIPT_FAILED",
  MIRROR_TIMEOUT: "RG_MIRROR_TIMEOUT",
  VENDOR_PAYMENT_NOT_FOUND: "RG_VENDOR_PAYMENT_NOT_FOUND",
  VENDOR_PAYMENT_INVALID: "RG_VENDOR_PAYMENT_INVALID",
  VENDOR_PAYMENT_REPLAYED: "RG_VENDOR_PAYMENT_REPLAYED",
  VENDOR_API_FAILED: "RG_VENDOR_API_FAILED",
  HCS_AUDIT_FAILED: "RG_HCS_AUDIT_FAILED",
  MODEL_OUTPUT_INVALID: "RG_MODEL_OUTPUT_INVALID",
  RATE_LIMITED: "RG_RATE_LIMITED",
  LIVE_PAYMENTS_DISABLED: "RG_LIVE_PAYMENTS_DISABLED",
  APPROVER_AUTH_REQUIRED: "RG_APPROVER_AUTH_REQUIRED",
  APPROVAL_INVALID: "RG_APPROVAL_INVALID",
  APPROVAL_EXPIRED: "RG_APPROVAL_EXPIRED",
  APPROVAL_BINDING_MISMATCH: "RG_APPROVAL_BINDING_MISMATCH",
  APPROVAL_REPLAYED: "RG_APPROVAL_REPLAYED",
  APPROVAL_REJECTED: "RG_APPROVAL_REJECTED",
} as const;
export type RGErrorCode = (typeof RGError)[keyof typeof RGError];

export class RouteGuardError extends Error {
  constructor(
    public code: RGErrorCode,
    public publicMessage: string,
    public retryable = false,
  ) {
    super(publicMessage);
    this.name = "RouteGuardError";
  }
}
