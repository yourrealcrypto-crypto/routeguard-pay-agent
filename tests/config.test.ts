import { describe, expect, it } from "vitest";
import { isLiveHederaConfigured } from "../src/config/index.js";

const configuredCredentials = {
  HEDERA_OPERATOR_ID: "0.0.1001",
  HEDERA_OPERATOR_KEY: "test-key-placeholder",
  HEDERA_VENDOR_ACCOUNT_ID: "0.0.2002",
};

describe("live Hedera configuration kill switches", () => {
  it("stays disabled when ENABLE_HEDERA_TX is false", () => {
    expect(
      isLiveHederaConfigured({
        ...configuredCredentials,
        ENABLE_HEDERA_TX: false,
        LIVE_TESTNET_PAYMENTS_ENABLED: true,
      }),
    ).toBe(false);
  });

  it("becomes configured only when both switches and all credentials are present", () => {
    const fullyEnabled = {
      ...configuredCredentials,
      ENABLE_HEDERA_TX: true,
      LIVE_TESTNET_PAYMENTS_ENABLED: true,
    };

    expect(isLiveHederaConfigured(fullyEnabled)).toBe(true);

    for (const credential of [
      "HEDERA_OPERATOR_ID",
      "HEDERA_OPERATOR_KEY",
      "HEDERA_VENDOR_ACCOUNT_ID",
    ] as const) {
      expect(
        isLiveHederaConfigured({ ...fullyEnabled, [credential]: undefined }),
      ).toBe(false);
    }
  });
});
