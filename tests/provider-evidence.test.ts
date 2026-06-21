import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_TENANT_ID,
  ProviderEvidenceService,
} from "../src/provider-evidence/service.js";
import { RouteGuardError } from "../src/domain/index.js";
import { store } from "../src/store/store.js";

const NOW = new Date("2026-06-21T10:00:00.000Z");

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    providerAlias: "PRV-001",
    providerDisplayName: "Private Provider Name",
    lane: "Rotterdam → Leipzig",
    transportMode: "road",
    shipmentReference: "RG-1001",
    promisedDeliveryAt: "2026-06-20T08:00:00.000Z",
    actualDeliveryAt: "2026-06-20T10:00:00.000Z",
    delayMinutes: 120,
    deliveredOnTime: false,
    trackingCompletenessPercent: 80,
    cancellationOrIssue: false,
    temperatureExcursion: false,
    documentIssue: true,
    damageClaim: false,
    customerRating: 3,
    documentType: "delivery-note",
    documentSummary: "Delivery note records a delay and document issue.",
    confidence: 0.85,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RouteGuardError);
    expect((error as RouteGuardError).code).toBe(code);
  }
}

describe("private provider evidence vault", () => {
  const service = new ProviderEvidenceService();

  beforeEach(() => store.reset());

  it("creates structured customer-specific evidence", () => {
    const created = service.create(DEMO_TENANT_ID, evidence(), NOW);
    expect(created.providerAlias).toBe("PRV-001");
    expect(created.delayMinutes).toBe(120);
    expect(created.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.scopeLabel).toBe(
      "Customer-specific · not shared across customers",
    );
  });

  it("rejects unknown fields", () => {
    expectCode(
      () => service.create(DEMO_TENANT_ID, evidence({ paymentAmount: 10 }), NOW),
      "RG_PROVIDER_EVIDENCE_UNKNOWN_FIELD",
    );
  });

  it("rejects oversized document summaries", () => {
    expectCode(
      () =>
        service.create(
          DEMO_TENANT_ID,
          evidence({ documentSummary: "x".repeat(1_001) }),
          NOW,
        ),
      "RG_PROVIDER_EVIDENCE_TOO_LARGE",
    );
  });

  it("rejects URLs, executable content, account IDs, and credential-like text", () => {
    for (const documentSummary of [
      "See https://example.com/private-record",
      "<script>alert('x')</script>",
      "Send the record to 0.0.123456",
      "Private key: secret-value",
    ]) {
      expectCode(
        () =>
          service.create(
            DEMO_TENANT_ID,
            evidence({ documentSummary }),
            NOW,
          ),
        "RG_PROVIDER_EVIDENCE_INVALID",
      );
    }
  });

  it("hashes identical evidence deterministically at the same evidence time", () => {
    const first = service.create(DEMO_TENANT_ID, evidence(), NOW);
    const second = service.create(DEMO_TENANT_ID, evidence(), NOW);
    expect(first.evidenceId).not.toBe(second.evidenceId);
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });

  it("never returns provider display names or raw document summaries", () => {
    service.create(DEMO_TENANT_ID, evidence(), NOW);
    const serialized = JSON.stringify(service.list(DEMO_TENANT_ID));
    expect(serialized).not.toContain("Private Provider Name");
    expect(serialized).not.toContain("Delivery note records a delay");
    expect(serialized).not.toContain("documentSummary");
    expect(serialized).toContain("DOCUMENT_SUMMARY_PRESENT");
  });

  it("keeps reliability signals isolated by tenant", () => {
    service.create("tenant-a", evidence({ deliveredOnTime: true, delayMinutes: 0 }), NOW);
    service.create("tenant-b", evidence({ deliveredOnTime: false, delayMinutes: 600 }), NOW);
    expect(service.reliabilitySignal("tenant-a", "PRV-001").onTimeRate).toBe(100);
    expect(service.reliabilitySignal("tenant-b", "PRV-001").onTimeRate).toBe(0);
    expect(service.list("tenant-a")).toHaveLength(1);
  });

  it("uses measurable reliability metrics without creating a public rating", () => {
    service.create(DEMO_TENANT_ID, evidence(), NOW);
    const signal = service.reliabilitySignal(DEMO_TENANT_ID, "PRV-001");
    expect(signal.sampleSize).toBe(1);
    expect(signal.averageDelayMinutes).toBe(120);
    expect(signal.trackingCompletenessPercent).toBe(80);
    expect(signal.issueRate).toBe(0);
    expect(signal.documentIssueRate).toBe(100);
    expect(signal.reasonCodes).toContain("LIMITED_SAMPLE_SIZE");
    expect(signal.ratingLabel).toBe("Not a public carrier rating");
    expect(signal).not.toHaveProperty("providerDisplayName");
  });

  it("matches reports only to exact customer references or lane and mode", () => {
    service.create(DEMO_TENANT_ID, evidence(), NOW);
    expect(
      service.signalForTarget(DEMO_TENANT_ID, {
        reference: "RG-1001",
        lane: "Elsewhere → Elsewhere",
        transportMode: "road",
      })?.providerAlias,
    ).toBe("PRV-001");
    expect(
      service.signalForTarget(DEMO_TENANT_ID, {
        reference: "RG-9999",
        lane: "Rotterdam → Leipzig",
        transportMode: "ocean",
      }),
    ).toBeNull();
  });
});
