import { randomUUID } from "node:crypto";
import { sha256, type RiskBand, type Shipment } from "../domain/index.js";
import { SHIPMENTS } from "../store/fixtures.js";
import {
  activateRiskPolicy,
  createRiskPolicy,
  getActiveRiskPolicy,
  getRiskPolicyHistory,
  nextPatchVersion,
  resetRiskPolicyRegistry,
  validateRiskPolicy,
  type RiskPolicy,
} from "../risk/policy.js";
import {
  explainRiskScore,
  premiumReportRecommended,
} from "../risk/engine.js";

export const GOVERNANCE_ROLES = [
  "Chief Executive Officer",
  "Chief Risk Officer",
  "Compliance Officer",
] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

export interface EditableRiskField {
  path: string;
  label: string;
  minimum: number;
  maximum: number;
  integer: boolean;
}

const pointField = (path: string, label: string): EditableRiskField => ({
  path,
  label,
  minimum: 0,
  maximum: 25,
  integer: true,
});

export const EDITABLE_RISK_FIELDS: EditableRiskField[] = [
  ...(["air", "rail", "road", "ocean"] as const).map((mode) =>
    pointField(`modeWeights.${mode}`, `Mode weight · ${mode}`),
  ),
  ...(["general", "high_value", "fragile", "temperature_controlled"] as const).map(
    (cargo) => pointField(`cargoWeights.${cargo}`, `Cargo weight · ${cargo}`),
  ),
  ...[0, 1, 2].map((index) =>
    pointField(
      `cargoValueThresholds.${index}.points`,
      `Cargo-value threshold ${index + 1} points`,
    ),
  ),
  pointField("cargoValueFallbackPoints", "Cargo-value fallback points"),
  pointField("routeRisk.base", "Route base points"),
  pointField("routeRisk.crossBorder", "Cross-border route points"),
  pointField("routeRisk.ocean", "Ocean route points"),
  { path: "routeRisk.cap", label: "Route-risk cap", minimum: 0, maximum: 100, integer: true },
  ...[0, 1, 2].map((index) =>
    pointField(
      `scheduleThresholds.${index}.points`,
      `Schedule threshold ${index + 1} points`,
    ),
  ),
  pointField("scheduleFallbackPoints", "Schedule fallback points"),
  pointField("riskSignals.pointsPerSignal", "Points per risk signal"),
  { path: "riskSignals.cap", label: "Risk-signal cap", minimum: 0, maximum: 100, integer: true },
  { path: "riskBands.0.maximum", label: "Low-band maximum", minimum: 0, maximum: 99, integer: true },
  { path: "riskBands.1.maximum", label: "Moderate-band maximum", minimum: 1, maximum: 99, integer: true },
  { path: "riskBands.2.maximum", label: "High-band maximum", minimum: 2, maximum: 99, integer: true },
  { path: "confidence.minimumUsableConfidence", label: "Minimum usable confidence", minimum: 0, maximum: 1, integer: false },
];

export interface GovernanceApproval {
  role: GovernanceRole;
  approvedAt: string;
  proposalHash: string;
}

export interface ImpactRow {
  shipmentId: string;
  oldScore: number;
  proposedScore: number;
  oldBand: RiskBand;
  proposedBand: RiskBand;
  scoreDifference: number;
  oldPremiumReportRecommended: boolean;
  proposedPremiumReportRecommended: boolean;
  premiumReportRecommendationChanged: boolean;
}

export interface PolicyProposal {
  proposalId: string;
  basePolicyVersion: string;
  field: string;
  oldValue: number;
  proposedValue: number;
  reason: string;
  proposerRole: GovernanceRole;
  createdAt: string;
  expiresAt: string;
  proposalHash: string;
  status: "PENDING" | "REJECTED" | "ACTIVATED";
  approvals: GovernanceApproval[];
  quorumRequired: 2;
  impactPreview: ImpactRow[];
  activatedPolicyVersion?: string;
  activatedAt?: string;
  rejectedBy?: GovernanceRole;
  rejectedAt?: string;
}

export class GovernanceError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

function isRole(value: unknown): value is GovernanceRole {
  return GOVERNANCE_ROLES.includes(value as GovernanceRole);
}

function getPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}

function setPath(root: unknown, path: string, value: number): void {
  const keys = path.split(".");
  let cursor = root as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys.at(-1)!] = value;
}

function proposalHash(proposal: Omit<PolicyProposal, "proposalHash" | "status" | "approvals" | "quorumRequired" | "impactPreview" | "activatedPolicyVersion" | "activatedAt" | "rejectedBy" | "rejectedAt">): string {
  return sha256(proposal);
}

function proposedPolicy(active: RiskPolicy, field: string, value: number): RiskPolicy {
  const draft = structuredClone(active);
  setPath(draft, field, value);
  const errors = validateRiskPolicy(draft);
  if (errors.length > 0)
    throw new GovernanceError("RG_GOVERNANCE_INVALID_POLICY", errors.join(" "));
  const { policyHash: _oldHash, ...source } = draft;
  return createRiskPolicy(source);
}

function impactFor(
  shipment: Shipment,
  active: RiskPolicy,
  draft: RiskPolicy,
  evaluatedAt: string,
): ImpactRow {
  const oldScore = explainRiskScore(shipment, { policy: active, evaluatedAt });
  const proposedScore = explainRiskScore(shipment, { policy: draft, evaluatedAt });
  const oldRecommended = premiumReportRecommended(shipment, active);
  const proposedRecommended = premiumReportRecommended(shipment, draft);
  return {
    shipmentId: shipment.id,
    oldScore: oldScore.riskScore,
    proposedScore: proposedScore.riskScore,
    oldBand: oldScore.riskBand,
    proposedBand: proposedScore.riskBand,
    scoreDifference: proposedScore.riskScore - oldScore.riskScore,
    oldPremiumReportRecommended: oldRecommended,
    proposedPremiumReportRecommended: proposedRecommended,
    premiumReportRecommendationChanged: oldRecommended !== proposedRecommended,
  };
}

export interface ProposalInput {
  basePolicyVersion: string;
  field: string;
  proposedValue: number;
  reason: string;
  proposerRole: GovernanceRole;
}

class GovernanceService {
  private proposals = new Map<string, PolicyProposal>();

  getConfiguration() {
    return {
      roles: [...GOVERNANCE_ROLES],
      editableFields: structuredClone(EDITABLE_RISK_FIELDS),
      quorumRequired: 2,
      proposalLifetimeHours: 24,
      identityNotice: "Simulation only · role identity is not authenticated.",
      persistenceNotice: "Public simulation metadata is held in memory and resets on restart.",
    };
  }

  list(): PolicyProposal[] {
    return [...this.proposals.values()].map((proposal) => structuredClone(proposal));
  }

  history() {
    return getRiskPolicyHistory();
  }

  preview(input: ProposalInput, now = new Date()): ImpactRow[] {
    const { active, draft } = this.validateInput(input);
    const evaluatedAt = now.toISOString();
    return SHIPMENTS.map((shipment) => impactFor(shipment, active, draft, evaluatedAt));
  }

  submit(input: ProposalInput, now = new Date()): PolicyProposal {
    const { active, descriptor, draft } = this.validateInput(input);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const core = {
      proposalId: randomUUID(),
      basePolicyVersion: active.policyVersion,
      field: descriptor.path,
      oldValue: getPath(active, descriptor.path) as number,
      proposedValue: input.proposedValue,
      reason: input.reason.trim(),
      proposerRole: input.proposerRole,
      createdAt,
      expiresAt,
    };
    const proposal: PolicyProposal = {
      ...core,
      proposalHash: proposalHash(core),
      status: "PENDING",
      approvals: [],
      quorumRequired: 2,
      impactPreview: SHIPMENTS.map((shipment) =>
        impactFor(shipment, active, draft, createdAt),
      ),
    };
    this.proposals.set(proposal.proposalId, proposal);
    return structuredClone(proposal);
  }

  approve(proposalId: string, role: GovernanceRole, suppliedHash: string, now = new Date()): PolicyProposal {
    const proposal = this.requireActionable(proposalId, suppliedHash, now);
    if (!isRole(role)) throw new GovernanceError("RG_GOVERNANCE_ROLE_INVALID", "Unknown governance role.");
    if (proposal.proposerRole === role)
      throw new GovernanceError("RG_GOVERNANCE_SELF_APPROVAL", "The proposer cannot approve their own proposal.");
    if (proposal.approvals.some((approval) => approval.role === role))
      throw new GovernanceError("RG_GOVERNANCE_DUPLICATE_APPROVAL", "This role has already approved the proposal.");
    proposal.approvals.push({ role, approvedAt: now.toISOString(), proposalHash: suppliedHash });

    if (proposal.approvals.length >= proposal.quorumRequired) {
      const active = getActiveRiskPolicy();
      if (active.policyVersion !== proposal.basePolicyVersion)
        throw new GovernanceError("RG_GOVERNANCE_STALE_POLICY", "The proposal is based on an outdated policy version.", 409);
      const draft = proposedPolicy(active, proposal.field, proposal.proposedValue);
      const { policyHash: _draftHash, ...source } = draft;
      const activatedAt = now.toISOString();
      const activated = activateRiskPolicy(
        {
          ...source,
          policyVersion: nextPatchVersion(active.policyVersion),
          status: "ACTIVE",
          effectiveDate: activatedAt,
        },
        proposal.proposalId,
      );
      proposal.status = "ACTIVATED";
      proposal.activatedAt = activatedAt;
      proposal.activatedPolicyVersion = activated.policyVersion;
    }
    return structuredClone(proposal);
  }

  reject(proposalId: string, role: GovernanceRole, suppliedHash: string, now = new Date()): PolicyProposal {
    const proposal = this.requireActionable(proposalId, suppliedHash, now);
    if (!isRole(role)) throw new GovernanceError("RG_GOVERNANCE_ROLE_INVALID", "Unknown governance role.");
    proposal.status = "REJECTED";
    proposal.rejectedBy = role;
    proposal.rejectedAt = now.toISOString();
    return structuredClone(proposal);
  }

  reset(): void {
    this.proposals.clear();
    resetRiskPolicyRegistry();
  }

  private validateInput(input: ProposalInput) {
    if (!input || typeof input !== "object")
      throw new GovernanceError("RG_GOVERNANCE_MALFORMED", "A proposal body is required.");
    const active = getActiveRiskPolicy();
    if (input.basePolicyVersion !== active.policyVersion)
      throw new GovernanceError("RG_GOVERNANCE_STALE_POLICY", "The proposal is based on an outdated policy version.", 409);
    const descriptor = EDITABLE_RISK_FIELDS.find((field) => field.path === input.field);
    if (!descriptor)
      throw new GovernanceError("RG_GOVERNANCE_FIELD_LOCKED", "Unknown or locked policy field.");
    if (typeof input.proposedValue !== "number" || !Number.isFinite(input.proposedValue))
      throw new GovernanceError("RG_GOVERNANCE_MALFORMED", "The proposed value must be numeric.");
    if (input.proposedValue < descriptor.minimum || input.proposedValue > descriptor.maximum || (descriptor.integer && !Number.isInteger(input.proposedValue)))
      throw new GovernanceError("RG_GOVERNANCE_OUT_OF_BOUNDS", `Value must be ${descriptor.integer ? "an integer " : ""}between ${descriptor.minimum} and ${descriptor.maximum}.`);
    if (!isRole(input.proposerRole))
      throw new GovernanceError("RG_GOVERNANCE_ROLE_INVALID", "Unknown governance proposer role.");
    if (typeof input.reason !== "string" || input.reason.trim().length < 10 || input.reason.trim().length > 500)
      throw new GovernanceError("RG_GOVERNANCE_MALFORMED", "Reason must contain 10 to 500 characters.");
    const oldValue = getPath(active, descriptor.path);
    if (oldValue === input.proposedValue)
      throw new GovernanceError("RG_GOVERNANCE_NO_CHANGE", "The proposed value must differ from the active value.");
    return { active, descriptor, draft: proposedPolicy(active, descriptor.path, input.proposedValue) };
  }

  private requireActionable(proposalId: string, suppliedHash: string, now: Date): PolicyProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new GovernanceError("RG_GOVERNANCE_UNKNOWN_PROPOSAL", "Unknown policy proposal.", 404);
    const expectedHash = proposalHash({
      proposalId: proposal.proposalId,
      basePolicyVersion: proposal.basePolicyVersion,
      field: proposal.field,
      oldValue: proposal.oldValue,
      proposedValue: proposal.proposedValue,
      reason: proposal.reason,
      proposerRole: proposal.proposerRole,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
    });
    if (expectedHash !== proposal.proposalHash) {
      proposal.approvals = [];
      throw new GovernanceError("RG_GOVERNANCE_HASH_MISMATCH", "Approval must bind to the exact canonical proposal hash.", 409);
    }
    if (suppliedHash !== proposal.proposalHash)
      throw new GovernanceError("RG_GOVERNANCE_HASH_MISMATCH", "Approval must bind to the exact canonical proposal hash.", 409);
    if (proposal.status !== "PENDING")
      throw new GovernanceError("RG_GOVERNANCE_NOT_ACTIONABLE", `Proposal is already ${proposal.status.toLowerCase()}.`, 409);
    if (now.getTime() >= new Date(proposal.expiresAt).getTime())
      throw new GovernanceError("RG_GOVERNANCE_EXPIRED", "The policy proposal has expired.", 409);
    if (getActiveRiskPolicy().policyVersion !== proposal.basePolicyVersion)
      throw new GovernanceError("RG_GOVERNANCE_STALE_POLICY", "The proposal is based on an outdated policy version.", 409);
    return proposal;
  }
}

export const governance = new GovernanceService();
