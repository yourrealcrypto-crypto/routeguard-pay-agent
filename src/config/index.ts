import { z } from "zod";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

/**
 * All configuration is validated once at startup. Invalid financial values or a
 * non-testnet network must fail fast — there is no hidden mainnet fallback.
 */
const RawEnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().default("http://localhost:3000"),

  // LLM (provider-agnostic; defaults make the app run with no key in heuristic mode)
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_BASE_URL: z.string().optional(),

  // Hedera — testnet only by construction.
  HEDERA_NETWORK: z.literal("testnet").default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_VENDOR_ACCOUNT_ID: z.string().optional(),
  HCS_AUDIT_TOPIC_ID: z.string().optional(),
  HEDERA_MIRROR_BASE_URL: z
    .string()
    .default("https://testnet.mirrornode.hedera.com"),

  // Safety switches. Live payments are OFF unless explicitly enabled.
  ENABLE_HEDERA_TX: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LIVE_TESTNET_PAYMENTS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Approval identity. No authentication adapter is installed by default.
  APPROVAL_AUTH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  APPROVER_EMAILS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),

  // Policy values, in tinybars (1 HBAR = 100_000_000 tinybars).
  CATALOG_PRICE_TINYBARS: z.coerce.number().int().positive().default(5_000_000),
  MAX_PER_PURCHASE_TINYBARS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000_000),
  AUTO_APPROVE_AT_OR_BELOW_TINYBARS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000_000),
  DAILY_BUDGET_TINYBARS: z.coerce.number().int().positive().default(20_000_000),

  // Public-demo rate limiting.
  PUBLIC_LIVE_PURCHASES_PER_IP_PER_HOUR: z.coerce.number().int().default(2),
  PUBLIC_GLOBAL_LIVE_PURCHASES_PER_DAY: z.coerce.number().int().default(25),

  FEEDBACK_URL: z
    .string()
    .default(
      "https://github.com/hashgraph/hedera-agent-kit/issues/new?title=RouteGuard%20Pay%20Agent%20feedback",
    ),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = RawEnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Invalid environment configuration:\n",
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

const env = parsed.data;

// Cross-field invariants. These would be silent foot-guns if left unchecked.
if (env.AUTO_APPROVE_AT_OR_BELOW_TINYBARS > env.MAX_PER_PURCHASE_TINYBARS) {
  console.error(
    "Config error: AUTO_APPROVE_AT_OR_BELOW_TINYBARS must be <= MAX_PER_PURCHASE_TINYBARS",
  );
  process.exit(1);
}

interface LiveHederaConfigInput {
  ENABLE_HEDERA_TX: boolean;
  LIVE_TESTNET_PAYMENTS_ENABLED: boolean;
  HEDERA_OPERATOR_ID?: string;
  HEDERA_OPERATOR_KEY?: string;
  HEDERA_VENDOR_ACCOUNT_ID?: string;
}

/** True only when both switches are on and every required account value is present. */
export function isLiveHederaConfigured(env: LiveHederaConfigInput): boolean {
  return (
    env.ENABLE_HEDERA_TX &&
    env.LIVE_TESTNET_PAYMENTS_ENABLED &&
    Boolean(env.HEDERA_OPERATOR_ID) &&
    Boolean(env.HEDERA_OPERATOR_KEY) &&
    Boolean(env.HEDERA_VENDOR_ACCOUNT_ID)
  );
}

export const liveHederaConfigured = isLiveHederaConfigured(env);

/** True when an HCS topic is configured and live mode can write to it. */
export const hcsConfigured: boolean =
  Boolean(env.HCS_AUDIT_TOPIC_ID) &&
  Boolean(env.HEDERA_OPERATOR_ID) &&
  Boolean(env.HEDERA_OPERATOR_KEY);

export const llmConfigured: boolean = Boolean(env.LLM_API_KEY);
export const approvalAuthConfigured: boolean =
  env.APPROVAL_AUTH_ENABLED && env.APPROVER_EMAILS.length > 0;

export const config = {
  ...env,
  liveHederaConfigured,
  hcsConfigured,
  llmConfigured,
  approvalAuthConfigured,
  /** Vendor identity is server-controlled; the model can never supply it. */
  vendor: {
    vendorId: "route-risk-labs" as const,
    serviceCategory: "logistics.route-risk" as const,
    sku: "premium-route-risk-v1" as const,
    version: "1.0" as const,
  },
};

export type AppConfig = typeof config;
