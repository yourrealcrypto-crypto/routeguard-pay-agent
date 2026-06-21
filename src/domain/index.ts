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
  "LIVE-MUC-IST",
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
  transportMode: z.literal("ROAD_FREIGHT"),
  approximateDistanceKm: z.number().int().positive(),
  borderCount: z.number().int().nonnegative(),
  estimatedTransitHours: z.number().positive(),
  temperatureToleranceC: z.object({ minimum: z.number(), maximum: z.number() }),
  checkpoints: z.array(LiveRouteCheckpointSchema).min(3).max(6),
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

export const LiveRiskContributionsSchema = z.object({
  structuralComplexity: z.number().int().min(0).max(100),
  liveWeatherExposure: z.number().int().min(0).max(100),
  cargoSensitivity: z.number().int().min(0).max(100),
  dataUncertainty: z.number().int().min(0).max(100),
  total: z.number().int().min(0).max(100),
});
export type LiveRiskContributions = z.infer<
  typeof LiveRiskContributionsSchema
>;

export const StructuralRiskFactorsSchema = z.object({
  distance: z.number().int().nonnegative(),
  borders: z.number().int().nonnegative(),
  checkpoints: z.number().int().nonnegative(),
  schedule: z.number().int().nonnegative(),
});

export const WeatherDataFreshnessSchema = z.object({
  maximumAgeMinutes: z.number().nonnegative(),
  status: z.enum(["FRESH", "STALE", "VERY_STALE"]),
  fromCache: z.boolean(),
});

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
  checkpointEvidence: z.array(WeatherCheckpointEvidenceSchema).min(3).max(6),
  riskContributions: LiveRiskContributionsSchema,
  structuralFactors: StructuralRiskFactorsSchema,
  dataFreshness: WeatherDataFreshnessSchema,
  policyVersion: z.string(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  premiumReportRecommended: z.boolean(),
  purchaseMode: z.literal("POLICY_GATED"),
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
  liveRouteId: LiveRouteId.nullable().optional(),
  requestedSku: z.literal("premium-route-risk-v1"),
  rationale: z.string().min(20).max(800),
  expectedBenefit: z.string().min(10).max(500),
  status: ProposalStatus,
  policyProfile: PolicyProfile,
  createdAt: z.string().datetime(),
});
export type PurchaseProposal = z.infer<typeof PurchaseProposalSchema>;

export const PurchaseTargetType = z.enum(["SHIPMENT", "LIVE_ROUTE"]);
export type PurchaseTargetType = z.infer<typeof PurchaseTargetType>;

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
/*  Private, customer-specific provider evidence                              */
/* -------------------------------------------------------------------------- */

export const ProviderAliasSchema = z.string().regex(/^PRV-\d{3,6}$/);
export const ProviderTransportModeSchema = z.enum([
  "road",
  "ocean",
  "air",
  "rail",
]);
export const ProviderExtractedFactSchema = z.enum([
  "DOCUMENT_SUMMARY_PRESENT",
  "DELAY_MENTIONED",
  "CANCELLATION_OR_ISSUE_MENTIONED",
  "TEMPERATURE_EXCURSION_MENTIONED",
  "DOCUMENT_ISSUE_MENTIONED",
  "DAMAGE_CLAIM_MENTIONED",
  "ON_TIME_DELIVERY_MENTIONED",
]);

export const ProviderEvidenceInputSchema = z
  .object({
    providerAlias: ProviderAliasSchema,
    providerDisplayName: z.string().trim().min(1).max(120).optional(),
    lane: z.string().trim().min(3).max(120),
    transportMode: ProviderTransportModeSchema,
    shipmentReference: z.string().trim().min(1).max(50).optional(),
    promisedDeliveryAt: z.string().datetime().optional(),
    actualDeliveryAt: z.string().datetime().optional(),
    delayMinutes: z.number().int().min(0).max(10_080).optional(),
    deliveredOnTime: z.boolean(),
    trackingCompletenessPercent: z.number().min(0).max(100),
    cancellationOrIssue: z.boolean(),
    temperatureExcursion: z.boolean(),
    documentIssue: z.boolean(),
    damageClaim: z.boolean(),
    customerRating: z.number().min(1).max(5).optional(),
    documentType: z.string().trim().min(1).max(40).optional(),
    documentSummary: z.string().max(1_000).optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ProviderEvidenceInput = z.infer<
  typeof ProviderEvidenceInputSchema
>;

export const ProviderEvidenceRecordSchema = z.object({
  evidenceId: z.string().uuid(),
  tenantId: z.string(),
  providerAlias: ProviderAliasSchema,
  /** Private customer input. Never included in public views, hashes, or reports. */
  providerDisplayName: z.string().nullable(),
  lane: z.string(),
  transportMode: ProviderTransportModeSchema,
  shipmentReference: z.string().nullable(),
  promisedDeliveryAt: z.string().datetime().nullable(),
  actualDeliveryAt: z.string().datetime().nullable(),
  delayMinutes: z.number().int().min(0).max(10_080),
  deliveredOnTime: z.boolean(),
  trackingCompletenessPercent: z.number().min(0).max(100),
  cancellationOrIssue: z.boolean(),
  temperatureExcursion: z.boolean(),
  documentIssue: z.boolean(),
  damageClaim: z.boolean(),
  customerRating: z.number().min(1).max(5).nullable(),
  documentType: z.string().nullable(),
  extractedFacts: z.array(ProviderExtractedFactSchema),
  confidence: z.number().min(0).max(1),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProviderEvidenceRecord = z.infer<
  typeof ProviderEvidenceRecordSchema
>;

export const ProviderEvidencePublicViewSchema = ProviderEvidenceRecordSchema.omit({
  tenantId: true,
  providerDisplayName: true,
}).extend({
  scopeLabel: z.literal("Customer-specific · not shared across customers"),
});
export type ProviderEvidencePublicView = z.infer<
  typeof ProviderEvidencePublicViewSchema
>;

export const ProviderReliabilityBandSchema = z.enum([
  "INSUFFICIENT_EVIDENCE",
  "HIGHER_OBSERVED_RELIABILITY",
  "MIXED_OBSERVED_RELIABILITY",
  "ELEVATED_OPERATIONAL_ATTENTION",
]);

export const ProviderReliabilitySignalSchema = z.object({
  providerAlias: ProviderAliasSchema,
  sampleSize: z.number().int().positive(),
  onTimeRate: z.number().min(0).max(100),
  averageDelayMinutes: z.number().nonnegative(),
  trackingCompletenessPercent: z.number().min(0).max(100),
  issueRate: z.number().min(0).max(100),
  temperatureExcursionRate: z.number().min(0).max(100),
  documentIssueRate: z.number().min(0).max(100),
  damageClaimRate: z.number().min(0).max(100),
  reliabilityScore: z.number().min(0).max(100),
  reliabilityBand: ProviderReliabilityBandSchema,
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(z.string()),
  evidenceHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  scopeLabel: z.literal("Customer-specific · not shared across customers"),
  evidenceLabel: z.literal("Customer-specific evidence only"),
  sharingLabel: z.literal("Not shared across customers"),
  ratingLabel: z.literal("Not a public carrier rating"),
});
export type ProviderReliabilitySignal = z.infer<
  typeof ProviderReliabilitySignalSchema
>;

const EtaReliabilityRiskSchema = z.object({
  schedulePressure: z.string(),
  delayExposureMinutes: z.number().nonnegative().nullable(),
  contributingFactors: z.array(z.string()),
  onTimeRiskBand: z.enum(["LOW", "MODERATE", "HIGH"]),
  explanation: z.string(),
});

const InsuranceSupportEvidenceSchema = z.object({
  route: z.string(),
  cargo: z.string(),
  eta: z.string(),
  providerAlias: ProviderAliasSchema.nullable(),
  providerReliabilityBand: ProviderReliabilityBandSchema.nullable(),
  policyVersion: z.string(),
  evidenceHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  evaluatedAt: z.string().datetime(),
  generatedAt: z.string().datetime(),
  disclaimer: z.literal(
    "Insurance-support evidence only. This report does not sell, price, approve, or determine insurance.",
  ),
});

const AlternativeMitigationSchema = z.object({
  recommendation: z.string(),
  basis: z.array(z.string()),
  exactTravelTimeEstimated: z.literal(false),
});

/* -------------------------------------------------------------------------- */
/*  Premium report                                                            */
/* -------------------------------------------------------------------------- */

export const RiskBand = z.enum(["low", "moderate", "high", "critical"]);
export type RiskBand = z.infer<typeof RiskBand>;

const PremiumReportCommonSchema = z.object({
  reportId: z.string().uuid(),
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
  algorithmVersion: z.enum(["route-risk-1.0", "live-route-premium-1.1"]),
  policyVersion: z.string(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  paymentTransactionId: z.string(),
  reportHash: z.string(),
  triggeredReasonCodes: z.array(z.string()),
  mitigationRecommendations: z.array(z.string()),
  operationalRecommendations: z.array(z.string()),
  privateProviderReliabilitySignal: ProviderReliabilitySignalSchema.nullable(),
  providerEvidenceScopeLabel: z.literal(
    "Private customer-specific provider score · Not shared across customers · Not a public carrier rating",
  ),
  etaReliabilityRisk: EtaReliabilityRiskSchema,
  insuranceSupportEvidence: InsuranceSupportEvidenceSchema,
  alternativeRouteOrMitigationRecommendation: AlternativeMitigationSchema,
  disclaimer: z.string(),
});

export const ShipmentPremiumReportSchema = PremiumReportCommonSchema.extend({
  reportType: z.literal("SHIPMENT"),
  shipmentId: z.string(),
  route: z.object({
    origin: z.string(),
    destination: z.string(),
  }),
  cargoType: z.string(),
  declaredCargoValueEur: z.number().nonnegative(),
  transportMode: z.string(),
  riskSignals: z.array(z.string()),
  freeAssessmentComparison: z.object({
    riskBand: RiskBand,
    confidence: z.number().min(0).max(1),
    policyVersion: z.string(),
    policyHash: z.string(),
  }),
});

export const LiveRoutePremiumReportSchema = PremiumReportCommonSchema.extend({
  reportType: z.literal("LIVE_ROUTE"),
  routeId: LiveRouteId,
  origin: z.string(),
  destination: z.string(),
  checkpoints: z.array(LiveRouteCheckpointSchema),
  checkpointEvidence: z.array(WeatherCheckpointEvidenceSchema),
  weatherSourceTimestamp: z.string().datetime(),
  weatherDataSource: z.enum(["LIVE", "CACHE"]),
  structuralRouteComplexity: z.object({
    checkpointCount: z.number().int().positive(),
    crossBorder: z.boolean(),
    alpineExposure: z.boolean(),
    approximateDistanceKm: z.number().int().positive(),
    borderCount: z.number().int().nonnegative(),
    estimatedTransitHours: z.number().positive(),
    structuralScore: z.number().int().nonnegative(),
  }),
  riskContributions: LiveRiskContributionsSchema,
  dataFreshness: WeatherDataFreshnessSchema,
  cargoSensitivity: z.string(),
  temperatureToleranceAnalysis: z.object({
    minimumC: z.number(),
    maximumC: z.number(),
    exposedCheckpointIds: z.array(z.string()),
  }),
  borderAndCheckpointExposure: z.array(z.string()),
  freeAssessmentComparison: z.object({
    score: z.number().int().min(0).max(100),
    riskBand: RiskBand,
    confidence: z.number().min(0).max(1),
  }),
});

export const PremiumReportSchema = z.discriminatedUnion("reportType", [
  ShipmentPremiumReportSchema,
  LiveRoutePremiumReportSchema,
]);
export type PremiumReport = z.infer<typeof PremiumReportSchema>;

/* -------------------------------------------------------------------------- */
/*  Single-use premium API entitlement                                        */
/* -------------------------------------------------------------------------- */

export const EntitlementStatus = z.enum([
  "ISSUED",
  "REDEEMING",
  "REDEEMED",
  "EXPIRED",
  "FAILED",
]);
export type EntitlementStatus = z.infer<typeof EntitlementStatus>;

export const PremiumEntitlementRecordSchema = z.object({
  entitlementId: z.string().uuid(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  proposalId: z.string().uuid(),
  targetType: PurchaseTargetType,
  shipmentId: z.string().nullable(),
  liveRouteId: LiveRouteId.nullable(),
  vendorId: z.literal("route-risk-labs"),
  vendorAccountId: z.string(),
  sku: z.literal("premium-route-risk-v1"),
  amountTinybars: z.number().int().positive(),
  executionMode: z.enum(["SIMULATION", "AUTONOMOUS_TESTNET"]),
  paymentReference: z.string(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  redeemedAt: z.string().datetime().nullable(),
  status: EntitlementStatus,
});
export type PremiumEntitlementRecord = z.infer<
  typeof PremiumEntitlementRecordSchema
>;

export type PremiumEntitlementView = Omit<
  PremiumEntitlementRecord,
  "tokenHash" | "bindingHash"
>;

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
  ENTITLEMENT_REQUIRED: "RG_ENTITLEMENT_REQUIRED",
  ENTITLEMENT_NOT_FOUND: "RG_ENTITLEMENT_NOT_FOUND",
  ENTITLEMENT_EXPIRED: "RG_ENTITLEMENT_EXPIRED",
  ENTITLEMENT_REPLAYED: "RG_ENTITLEMENT_REPLAYED",
  ENTITLEMENT_MISMATCH: "RG_ENTITLEMENT_MISMATCH",
  PURCHASE_NOT_COMPLETED: "RG_PURCHASE_NOT_COMPLETED",
  PROVIDER_EVIDENCE_INVALID: "RG_PROVIDER_EVIDENCE_INVALID",
  PROVIDER_EVIDENCE_TOO_LARGE: "RG_PROVIDER_EVIDENCE_TOO_LARGE",
  PROVIDER_EVIDENCE_UNKNOWN_FIELD: "RG_PROVIDER_EVIDENCE_UNKNOWN_FIELD",
  PROVIDER_EVIDENCE_NOT_FOUND: "RG_PROVIDER_EVIDENCE_NOT_FOUND",
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
