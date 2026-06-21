import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ProviderEvidenceInputSchema,
  ProviderExtractedFactSchema,
  ProviderEvidenceRecordSchema,
  ProviderEvidencePublicViewSchema,
  ProviderReliabilitySignalSchema,
  RGError,
  RouteGuardError,
  sha256,
  type ProviderEvidenceInput,
  type ProviderEvidencePublicView,
  type ProviderEvidenceRecord,
  type ProviderReliabilitySignal,
} from "../domain/index.js";
import { store } from "../store/store.js";

export const DEMO_TENANT_ID = "routeguard-demo-tenant";
export const PROVIDER_EVIDENCE_SCOPE =
  "Customer-specific · not shared across customers" as const;

const KNOWN_INPUT_FIELDS = new Set(Object.keys(ProviderEvidenceInputSchema.shape));
const FORBIDDEN_TEXT = [
  /https?:\/\//i,
  /\bwww\./i,
  /<script\b/i,
  /javascript:/i,
  /\b(?:require|import|eval)\s*\(/i,
  /\b0\.0\.\d+\b/,
  /\b(?:private[_ -]?key|seed phrase|api[_ -]?key|bearer token|password)\b/i,
];

export interface ProviderEvidenceTarget {
  reference: string;
  lane: string;
  transportMode: ProviderEvidenceInput["transportMode"];
}

export class ProviderEvidenceService {
  create(
    tenantId: string,
    input: unknown,
    now = new Date(),
  ): ProviderEvidencePublicView {
    this.assertInputEnvelope(input);
    const parsed = ProviderEvidenceInputSchema.safeParse(input);
    if (!parsed.success)
      throw this.validationError(parsed.error);
    this.assertSafeStrings(parsed.data);

    const createdAt = now.toISOString();
    const delayMinutes = deriveDelayMinutes(parsed.data);
    const extractedFacts = extractFacts(parsed.data);
    const hashContent = {
      providerAlias: parsed.data.providerAlias,
      lane: normalizeLane(parsed.data.lane),
      transportMode: parsed.data.transportMode,
      shipmentReference: parsed.data.shipmentReference ?? null,
      promisedDeliveryAt: parsed.data.promisedDeliveryAt ?? null,
      actualDeliveryAt: parsed.data.actualDeliveryAt ?? null,
      delayMinutes,
      deliveredOnTime: parsed.data.deliveredOnTime,
      trackingCompletenessPercent: parsed.data.trackingCompletenessPercent,
      cancellationOrIssue: parsed.data.cancellationOrIssue,
      temperatureExcursion: parsed.data.temperatureExcursion,
      documentIssue: parsed.data.documentIssue,
      damageClaim: parsed.data.damageClaim,
      customerRating: parsed.data.customerRating ?? null,
      documentType: parsed.data.documentType ?? null,
      extractedFacts,
      confidence: parsed.data.confidence,
      createdAt,
    };
    const record = ProviderEvidenceRecordSchema.parse({
      evidenceId: randomUUID(),
      tenantId,
      providerAlias: parsed.data.providerAlias,
      providerDisplayName: parsed.data.providerDisplayName ?? null,
      lane: parsed.data.lane.trim(),
      transportMode: parsed.data.transportMode,
      shipmentReference: parsed.data.shipmentReference ?? null,
      promisedDeliveryAt: parsed.data.promisedDeliveryAt ?? null,
      actualDeliveryAt: parsed.data.actualDeliveryAt ?? null,
      delayMinutes,
      deliveredOnTime: parsed.data.deliveredOnTime,
      trackingCompletenessPercent: parsed.data.trackingCompletenessPercent,
      cancellationOrIssue: parsed.data.cancellationOrIssue,
      temperatureExcursion: parsed.data.temperatureExcursion,
      documentIssue: parsed.data.documentIssue,
      damageClaim: parsed.data.damageClaim,
      customerRating: parsed.data.customerRating ?? null,
      documentType: parsed.data.documentType ?? null,
      extractedFacts,
      confidence: parsed.data.confidence,
      evidenceHash: sha256(hashContent),
      createdAt,
      updatedAt: createdAt,
    });
    store.providerEvidence.set(record.evidenceId, record);
    return publicView(record);
  }

  list(tenantId: string): ProviderEvidencePublicView[] {
    return [...store.providerEvidence.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicView);
  }

  recalculate(
    tenantId: string,
    evidenceId: string,
  ): ProviderReliabilitySignal {
    const record = store.providerEvidence.get(evidenceId);
    if (!record || record.tenantId !== tenantId)
      throw new RouteGuardError(
        RGError.PROVIDER_EVIDENCE_NOT_FOUND,
        "Provider evidence was not found for this customer-specific vault.",
      );
    return this.reliabilitySignal(tenantId, record.providerAlias);
  }

  reliabilitySignal(
    tenantId: string,
    providerAlias: string,
    records?: ProviderEvidenceRecord[],
  ): ProviderReliabilitySignal {
    const evidence = (records ?? [...store.providerEvidence.values()]).filter(
      (record) =>
        record.tenantId === tenantId && record.providerAlias === providerAlias,
    );
    if (evidence.length === 0)
      throw new RouteGuardError(
        RGError.PROVIDER_EVIDENCE_NOT_FOUND,
        "No customer-specific evidence exists for this provider alias.",
      );

    const sampleSize = evidence.length;
    const onTimeRate = percentage(
      evidence.filter((record) => record.deliveredOnTime).length,
      sampleSize,
    );
    const averageDelayMinutes = roundedAverage(
      evidence.map((record) => record.delayMinutes),
    );
    const trackingCompletenessPercent = roundedAverage(
      evidence.map((record) => record.trackingCompletenessPercent),
    );
    const issueRate = percentage(
      evidence.filter((record) => record.cancellationOrIssue).length,
      sampleSize,
    );
    const temperatureExcursionRate = percentage(
      evidence.filter((record) => record.temperatureExcursion).length,
      sampleSize,
    );
    const documentIssueRate = percentage(
      evidence.filter((record) => record.documentIssue).length,
      sampleSize,
    );
    const damageClaimRate = percentage(
      evidence.filter((record) => record.damageClaim).length,
      sampleSize,
    );
    const delayPerformance = clamp(100 - averageDelayMinutes / 14.4, 0, 100);
    const reliabilityScore = round2(
      onTimeRate * 0.3 +
        delayPerformance * 0.2 +
        trackingCompletenessPercent * 0.2 +
        (100 - issueRate) * 0.1 +
        (100 - temperatureExcursionRate) * 0.07 +
        (100 - documentIssueRate) * 0.06 +
        (100 - damageClaimRate) * 0.07,
    );
    const averageConfidence = roundedAverage(
      evidence.map((record) => record.confidence),
    );
    const confidence = round2(
      averageConfidence * Math.min(1, Math.sqrt(sampleSize / 10)),
    );
    const reliabilityBand =
      confidence < 0.35
        ? "INSUFFICIENT_EVIDENCE"
        : reliabilityScore >= 80
          ? "HIGHER_OBSERVED_RELIABILITY"
          : reliabilityScore >= 60
            ? "MIXED_OBSERVED_RELIABILITY"
            : "ELEVATED_OPERATIONAL_ATTENTION";

    return ProviderReliabilitySignalSchema.parse({
      providerAlias,
      sampleSize,
      onTimeRate,
      averageDelayMinutes,
      trackingCompletenessPercent,
      issueRate,
      temperatureExcursionRate,
      documentIssueRate,
      damageClaimRate,
      reliabilityScore,
      reliabilityBand,
      confidence,
      reasonCodes: reasonCodes({
        sampleSize,
        onTimeRate,
        averageDelayMinutes,
        trackingCompletenessPercent,
        issueRate,
        temperatureExcursionRate,
        documentIssueRate,
        damageClaimRate,
      }),
      evidenceHashes: evidence
        .map((record) => record.evidenceHash)
        .sort(),
      scopeLabel: PROVIDER_EVIDENCE_SCOPE,
      evidenceLabel: "Customer-specific evidence only",
      sharingLabel: "Not shared across customers",
      ratingLabel: "Not a public carrier rating",
    });
  }

  signalForTarget(
    tenantId: string,
    target: ProviderEvidenceTarget,
  ): ProviderReliabilitySignal | null {
    const tenantEvidence = [...store.providerEvidence.values()].filter(
      (record) => record.tenantId === tenantId,
    );
    const referenceMatches = tenantEvidence.filter(
      (record) => record.shipmentReference === target.reference,
    );
    const matches =
      referenceMatches.length > 0
        ? referenceMatches
        : tenantEvidence.filter(
            (record) =>
              normalizeLane(record.lane) === normalizeLane(target.lane) &&
              record.transportMode === target.transportMode,
          );
    if (matches.length === 0) return null;

    const byAlias = new Map<string, ProviderEvidenceRecord[]>();
    for (const record of matches) {
      const group = byAlias.get(record.providerAlias) ?? [];
      group.push(record);
      byAlias.set(record.providerAlias, group);
    }
    const selected = [...byAlias.entries()].sort(
      ([aliasA, recordsA], [aliasB, recordsB]) =>
        recordsB.length - recordsA.length || aliasA.localeCompare(aliasB),
    )[0]!;
    return this.reliabilitySignal(tenantId, selected[0], selected[1]);
  }

  private assertInputEnvelope(input: unknown): asserts input is Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new RouteGuardError(
        RGError.PROVIDER_EVIDENCE_INVALID,
        "Provider evidence must be a structured object.",
      );
    const envelope = input as Record<string, unknown>;
    const keys = Object.keys(envelope);
    if (keys.some((key) => !KNOWN_INPUT_FIELDS.has(key)))
      throw new RouteGuardError(
        RGError.PROVIDER_EVIDENCE_UNKNOWN_FIELD,
        "Provider evidence contains an unknown or prohibited field.",
      );
    const summary = envelope.documentSummary;
    if (typeof summary === "string" && summary.length > 1_000)
      throw new RouteGuardError(
        RGError.PROVIDER_EVIDENCE_TOO_LARGE,
        "Document summaries are limited to 1,000 characters.",
      );
  }

  private assertSafeStrings(input: ProviderEvidenceInput): void {
    for (const value of Object.values(input)) {
      if (typeof value === "string" && FORBIDDEN_TEXT.some((pattern) => pattern.test(value)))
        throw new RouteGuardError(
          RGError.PROVIDER_EVIDENCE_INVALID,
          "Provider evidence cannot contain URLs, executable content, account IDs, or credential-like text.",
        );
    }
  }

  private validationError(error: z.ZodError): RouteGuardError {
    return new RouteGuardError(
      RGError.PROVIDER_EVIDENCE_INVALID,
      `Provider evidence failed structured validation: ${error.issues[0]?.message ?? "invalid input"}.`,
    );
  }
}

function publicView(record: ProviderEvidenceRecord): ProviderEvidencePublicView {
  const { tenantId: _tenantId, providerDisplayName: _privateName, ...safe } = record;
  return ProviderEvidencePublicViewSchema.parse({
    ...structuredClone(safe),
    scopeLabel: PROVIDER_EVIDENCE_SCOPE,
  });
}

function deriveDelayMinutes(input: ProviderEvidenceInput): number {
  if (input.delayMinutes !== undefined) return input.delayMinutes;
  if (input.promisedDeliveryAt && input.actualDeliveryAt) {
    return Math.min(
      10_080,
      Math.max(
        0,
        Math.round(
          (Date.parse(input.actualDeliveryAt) -
            Date.parse(input.promisedDeliveryAt)) /
            60_000,
        ),
      ),
    );
  }
  return 0;
}

function extractFacts(input: ProviderEvidenceInput) {
  const facts = new Set<z.infer<typeof ProviderExtractedFactSchema>>();
  const summary = input.documentSummary?.toLowerCase() ?? "";
  if (summary.trim()) facts.add("DOCUMENT_SUMMARY_PRESENT");
  if (input.delayMinutes || /\b(delay|late|overdue)\b/.test(summary))
    facts.add("DELAY_MENTIONED");
  if (input.cancellationOrIssue || /\b(cancel|issue|exception)\b/.test(summary))
    facts.add("CANCELLATION_OR_ISSUE_MENTIONED");
  if (
    input.temperatureExcursion ||
    /\b(temperature excursion|out of range|reefer alarm)\b/.test(summary)
  )
    facts.add("TEMPERATURE_EXCURSION_MENTIONED");
  if (
    input.documentIssue ||
    /\b(document issue|missing document|incorrect document|paperwork issue|customs hold)\b/.test(
      summary,
    )
  )
    facts.add("DOCUMENT_ISSUE_MENTIONED");
  if (input.damageClaim || /\b(damage|claim)\b/.test(summary))
    facts.add("DAMAGE_CLAIM_MENTIONED");
  if (input.deliveredOnTime || /\bon[ -]?time\b/.test(summary))
    facts.add("ON_TIME_DELIVERY_MENTIONED");
  return [...facts].sort();
}

function normalizeLane(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[→–—]/g, "-")
    .replace(/\s+/g, " ");
}

function percentage(count: number, total: number): number {
  return round2((count / total) * 100);
}

function roundedAverage(values: number[]): number {
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function reasonCodes(metrics: {
  sampleSize: number;
  onTimeRate: number;
  averageDelayMinutes: number;
  trackingCompletenessPercent: number;
  issueRate: number;
  temperatureExcursionRate: number;
  documentIssueRate: number;
  damageClaimRate: number;
}): string[] {
  const codes: string[] = [];
  if (metrics.sampleSize < 5) codes.push("LIMITED_SAMPLE_SIZE");
  if (metrics.onTimeRate >= 90) codes.push("ON_TIME_RATE_AT_LEAST_90");
  if (metrics.onTimeRate < 80) codes.push("ON_TIME_RATE_BELOW_80");
  if (metrics.averageDelayMinutes > 120) codes.push("AVERAGE_DELAY_OVER_120_MIN");
  if (metrics.trackingCompletenessPercent < 80)
    codes.push("TRACKING_COMPLETENESS_BELOW_80");
  if (metrics.issueRate > 20) codes.push("ISSUE_RATE_ABOVE_20");
  if (metrics.temperatureExcursionRate > 0)
    codes.push("TEMPERATURE_EXCURSION_OBSERVED");
  if (metrics.documentIssueRate > 0) codes.push("DOCUMENT_ISSUE_OBSERVED");
  if (metrics.damageClaimRate > 0) codes.push("DAMAGE_CLAIM_OBSERVED");
  return codes.length ? codes : ["MEASURED_EVIDENCE_WITHIN_DEMO_THRESHOLDS"];
}

export const providerEvidenceService = new ProviderEvidenceService();
