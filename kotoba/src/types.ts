/**
 * open-power kotoba — record types.
 *
 * Per ADR-2605203000 Option B. Electric distribution grid: substation nodes +
 * feeders + outages. Registry on AT PDS records (replaces D1 nodes/feeders/
 * outages). ADR-2605172000 kotoba.
 *
 * Identity hierarchy:
 *   did:web:open-power.etzhayyim.com                          — controller
 *   did:web:open-power.etzhayyim.com:node:{substationId}     — a substation
 *   did:web:open-power.etzhayyim.com:feeder:{feederId}       — a feeder
 *   did:web:open-power.etzhayyim.com:outage:{outageId}       — an outage
 */

export const OPOW_DID_PREFIX = "did:web:open-power.etzhayyim.com:" as const;

export const SUBSTATION_COLLECTION = "com.etzhayyim.apps.openPower.substation";
export const FEEDER_COLLECTION = "com.etzhayyim.apps.openPower.feeder";
export const OUTAGE_COLLECTION = "com.etzhayyim.apps.openPower.outage";

// ─── Substation ─────────────────────────────────────────────────────

/** Voltage class: low/medium/high/extra-high voltage. */
export type VoltageClass = "lv" | "mv" | "hv" | "ehv";

export interface SubstationRecord {
  did: string;
  substationId: string;
  name: string;
  /** Primary voltage in kV (integer). */
  voltageKv?: number;
  voltageClass?: VoltageClass;
  location?: string;
  createdAt: string;
}

export interface SubstationView extends SubstationRecord {
  substationUri: string;
}

export interface DefineSubstationInput {
  substationId: string;
  name: string;
  voltageKv?: number;
  voltageClass?: VoltageClass;
  location?: string;
}

export interface DefineSubstationOutput {
  status: "defined" | "alreadyExists" | "rejected";
  substationUri?: string;
  did?: string;
  substationId?: string;
  error?: string;
}

export interface GetSubstationInput {
  substationId: string;
}

export interface GetSubstationOutput {
  substation?: SubstationView;
  error?: string;
}

export interface ListSubstationsInput {
  voltageClass?: VoltageClass;
  limit?: number;
  cursor?: string;
}

export interface ListSubstationsOutput {
  items: SubstationView[];
  cursor?: string;
  total: number;
}

// ─── Feeder ─────────────────────────────────────────────────────────

export type FeederStatus = "energized" | "deenergized" | "fault" | "planned";

export interface FeederRecord {
  did: string;
  feederId: string;
  /** Source substation. */
  substationId: string;
  serviceArea?: string;
  /** Rated current, A (integer). */
  ratedAmps?: number;
  status: FeederStatus;
  createdAt: string;
}

export interface FeederView extends FeederRecord {
  feederUri: string;
}

export interface DefineFeederInput {
  feederId: string;
  substationId: string;
  serviceArea?: string;
  ratedAmps?: number;
  status?: FeederStatus;
}

export interface DefineFeederOutput {
  status: "defined" | "alreadyExists" | "rejected" | "substationNotFound";
  feederUri?: string;
  did?: string;
  feederId?: string;
  error?: string;
}

export interface GetFeederInput {
  feederId: string;
}

export interface GetFeederOutput {
  feeder?: FeederView;
  error?: string;
}

export interface ListFeedersInput {
  substationId?: string;
  status?: FeederStatus;
  limit?: number;
  cursor?: string;
}

export interface ListFeedersOutput {
  items: FeederView[];
  cursor?: string;
  total: number;
}

// ─── Outage ─────────────────────────────────────────────────────────

export type OutageCause =
  | "weather"
  | "equipment"
  | "vegetation"
  | "planned"
  | "thirdParty"
  | "other";
export type OutageStatus = "active" | "restored";

export interface OutageRecord {
  did: string;
  outageId: string;
  feederId: string;
  cause: OutageCause;
  status: OutageStatus;
  /** Customers affected (integer). */
  customersAffected?: number;
  reportedAt: string;
  createdAt: string;
}

export interface OutageView extends OutageRecord {
  outageUri: string;
}

export interface ReportOutageInput {
  outageId: string;
  feederId: string;
  cause: OutageCause;
  customersAffected?: number;
  reportedAt?: string;
}

export interface ReportOutageOutput {
  status: "reported" | "alreadyExists" | "rejected" | "feederNotFound";
  outageUri?: string;
  did?: string;
  outageId?: string;
  error?: string;
}

export interface ListOutagesInput {
  feederId?: string;
  cause?: OutageCause;
  status?: OutageStatus;
  limit?: number;
  cursor?: string;
}

export interface ListOutagesOutput {
  items: OutageView[];
  cursor?: string;
  total: number;
}

export interface CoverageInput {
  maxScan?: number;
}

export interface CoverageOutput {
  substationCount?: number;
  feederCount?: number;
  feedersByStatus?: Record<string, number>;
  outageCount?: number;
  activeOutages?: number;
  truncated?: boolean;
  error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

export const VOLTAGE_CLASSES: ReadonlySet<VoltageClass> = new Set(["lv", "mv", "hv", "ehv"]);
export const OUTAGE_CAUSES: ReadonlySet<OutageCause> = new Set([
  "weather",
  "equipment",
  "vegetation",
  "planned",
  "thirdParty",
  "other",
]);

export function substationDid(id: string): string {
  return `${OPOW_DID_PREFIX}node:${id.toLowerCase()}`;
}
export function substationRkey(id: string): string {
  return `substation-${id.toLowerCase()}`;
}
export function feederDid(id: string): string {
  return `${OPOW_DID_PREFIX}feeder:${id.toLowerCase()}`;
}
export function feederRkey(id: string): string {
  return `feeder-${id.toLowerCase()}`;
}
export function outageDid(id: string): string {
  return `${OPOW_DID_PREFIX}outage:${id.toLowerCase()}`;
}
export function outageRkey(id: string): string {
  return `outage-${id.toLowerCase()}`;
}
