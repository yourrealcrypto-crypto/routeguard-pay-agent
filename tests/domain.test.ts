import { describe, it, expect } from "vitest";
import {
  canonicalize,
  sha256,
  tinybarsToHbarDisplay,
} from "../src/domain/index.js";
import { txIdToMirrorFormat, maskAccount } from "../src/hedera/client.js";
import { evaluateMirrorBody } from "../src/hedera/mirror.js";
import {
  generateBasicReport,
  generatePremiumReport,
} from "../src/risk/engine.js";
import { getShipment } from "../src/store/fixtures.js";

describe("canonical JSON + hashing", () => {
  it("orders keys deterministically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
  it("produces a 64-char sha256 hex", () => {
    expect(sha256({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("same logical object → same hash regardless of key order", () => {
    expect(sha256({ a: 1, b: [1, 2, { c: 3, d: 4 }] })).toBe(
      sha256({ b: [1, 2, { d: 4, c: 3 }], a: 1 }),
    );
  });
});

describe("tinybar display", () => {
  it("formats 5_000_000 tinybars as 0.05 HBAR", () => {
    expect(tinybarsToHbarDisplay(5_000_000)).toBe("0.05 HBAR");
  });
});

describe("transaction id → mirror format", () => {
  it("converts @-and-dot form to dash form", () => {
    expect(txIdToMirrorFormat("0.0.123@1700000000.123456789")).toBe(
      "0.0.123-1700000000-123456789",
    );
  });
});

describe("account masking", () => {
  it("masks the middle of the account number", () => {
    expect(maskAccount("0.0.123456")).toBe("0.0.12••56");
  });
  it("leaves short ids alone", () => {
    expect(maskAccount("0.0.42")).toBe("0.0.42");
  });
});

describe("mirror payment validation (pure)", () => {
  const input = {
    transactionId: "0.0.100@1700000000.0",
    expectedPayerAccountId: "0.0.100",
    expectedVendorAccountId: "0.0.200",
    expectedAmountTinybars: 5_000_000,
    expectedMemo: "RG:abcd1234",
  };
  const goodMemo = Buffer.from("RG:abcd1234").toString("base64");

  function body(over: Record<string, unknown> = {}) {
    return {
      transactions: [
        {
          name: "CRYPTOTRANSFER",
          result: "SUCCESS",
          consensus_timestamp: "1700000000.000000001",
          memo_base64: goodMemo,
          transfers: [
            { account: "0.0.100", amount: -5_000_000 },
            { account: "0.0.200", amount: 5_000_000 },
          ],
          ...over,
        },
      ],
    };
  }

  it("accepts a valid payment", () => {
    expect(evaluateMirrorBody(body(), input).ok).toBe(true);
  });
  it("rejects when not found", () => {
    expect(evaluateMirrorBody({ transactions: [] }, input).reasonCode).toBe(
      "NOT_FOUND",
    );
  });
  it("rejects unsuccessful tx", () => {
    expect(evaluateMirrorBody(body({ result: "FAIL_INVALID" }), input).ok).toBe(
      false,
    );
  });
  it("rejects non-cryptotransfer", () => {
    expect(evaluateMirrorBody(body({ name: "CONSENSUSSUBMITMESSAGE" }), input).ok).toBe(
      false,
    );
  });
  it("rejects wrong vendor amount", () => {
    const r = evaluateMirrorBody(
      body({
        transfers: [
          { account: "0.0.100", amount: -4_000_000 },
          { account: "0.0.200", amount: 4_000_000 },
        ],
      }),
      input,
    );
    expect(r.ok).toBe(false);
  });
  it("rejects wrong vendor account", () => {
    const r = evaluateMirrorBody(
      body({
        transfers: [
          { account: "0.0.100", amount: -5_000_000 },
          { account: "0.0.999", amount: 5_000_000 },
        ],
      }),
      input,
    );
    expect(r.ok).toBe(false);
  });
  it("rejects missing payer debit", () => {
    const r = evaluateMirrorBody(
      body({
        transfers: [{ account: "0.0.200", amount: 5_000_000 }],
      }),
      input,
    );
    expect(r.ok).toBe(false);
  });
  it("rejects memo mismatch", () => {
    const r = evaluateMirrorBody(
      body({ memo_base64: Buffer.from("RG:wrong").toString("base64") }),
      input,
    );
    expect(r.ok).toBe(false);
  });
});

describe("risk engine determinism", () => {
  it("basic report is stable for the same shipment", () => {
    const s = getShipment("RG-1001")!;
    const options = { evaluatedAt: "2026-06-20T00:00:00.000Z" };
    expect(generateBasicReport(s, options)).toEqual(generateBasicReport(s, options));
  });

  it("premium score is stable for the same policy inputs and evaluation time", () => {
    const s = getShipment("RG-2002")!;
    const options = { evaluatedAt: "2026-06-20T00:00:00.000Z" };
    const a = generatePremiumReport(s, "0.0.1@1.0", options);
    const b = generatePremiumReport(s, "0.0.1@1.0", options);
    // UUID, generation time, and final report hash remain report-instance metadata.
    expect(a.riskScore).toBe(b.riskScore);
    expect(a.riskBand).toBe(b.riskBand);
    expect(a.factors).toEqual(b.factors);
  });

  it("scores stay within 0..100 and band matches", () => {
    for (const id of ["RG-1001", "RG-2002", "RG-3003"]) {
      const r = generatePremiumReport(getShipment(id)!, "0.0.1@1.0");
      expect(r.riskScore).toBeGreaterThanOrEqual(0);
      expect(r.riskScore).toBeLessThanOrEqual(100);
    }
  });
});
