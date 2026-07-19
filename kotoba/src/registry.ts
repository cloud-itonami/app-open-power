/**
 * open-power kotoba — substation + feeder + outage registries + coverage.
 * AT PDS records (no RW). Feeders reference an existing substation; outages
 * reference an existing feeder.
 */

import type { Etzhayyim } from "@etzhayyim/sdk";
import {
  FEEDER_COLLECTION,
  OUTAGE_CAUSES,
  OUTAGE_COLLECTION,
  SUBSTATION_COLLECTION,
  VOLTAGE_CLASSES,
  feederDid,
  feederRkey,
  outageDid,
  outageRkey,
  substationDid,
  substationRkey,
  type CoverageInput,
  type CoverageOutput,
  type DefineFeederInput,
  type DefineFeederOutput,
  type DefineSubstationInput,
  type DefineSubstationOutput,
  type FeederRecord,
  type FeederStatus,
  type FeederView,
  type GetFeederInput,
  type GetFeederOutput,
  type GetSubstationInput,
  type GetSubstationOutput,
  type ListFeedersInput,
  type ListFeedersOutput,
  type ListOutagesInput,
  type ListOutagesOutput,
  type ListSubstationsInput,
  type ListSubstationsOutput,
  type OutageRecord,
  type OutageView,
  type ReportOutageInput,
  type ReportOutageOutput,
  type SubstationRecord,
  type SubstationView,
  type VoltageClass,
} from "./types.js";

const PAGE_LIMIT = 100;
const DEFAULT_MAX_SCAN = 10_000;

async function exists(e: Etzhayyim, collection: string, rkey: string): Promise<boolean> {
  const resp = await e.read({ collection, rkey }).catch(() => ({ records: [] }));
  return Boolean(resp.records[0]?.value);
}

// ─── Substation ─────────────────────────────────────────────────────

export async function defineSubstation(e: Etzhayyim, input: DefineSubstationInput): Promise<DefineSubstationOutput> {
  if (!input.substationId || !input.name) return { status: "rejected", error: "missingRequiredFields" };
  if (input.voltageClass && !VOLTAGE_CLASSES.has(input.voltageClass)) {
    return { status: "rejected", error: "invalidVoltageClass" };
  }
  const rkey = substationRkey(input.substationId);
  const existing = await e.read<SubstationRecord>({ collection: SUBSTATION_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", substationUri: existing.records[0].uri, did: existing.records[0].value.did, substationId: input.substationId };
  }
  const did = substationDid(input.substationId);
  const record: SubstationRecord = {
    did,
    substationId: input.substationId,
    name: input.name,
    voltageKv: input.voltageKv,
    voltageClass: input.voltageClass,
    location: input.location,
    createdAt: new Date().toISOString(),
  };
  const receipt = await e.write({ collection: SUBSTATION_COLLECTION, record: record as unknown as Record<string, unknown>, rkey });
  return { status: "defined", substationUri: receipt.uri, did, substationId: input.substationId };
}

export async function getSubstation(e: Etzhayyim, input: GetSubstationInput): Promise<GetSubstationOutput> {
  if (!input.substationId) return { error: "invalidSubstationId" };
  const resp = await e.read<SubstationRecord>({ collection: SUBSTATION_COLLECTION, rkey: substationRkey(input.substationId) }).catch(() => ({ records: [] }));
  const r = resp.records[0];
  if (!r) return { error: "notFound" };
  return { substation: { ...r.value, substationUri: r.uri } };
}

export async function listSubstations(e: Etzhayyim, input: ListSubstationsInput = {}): Promise<ListSubstationsOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<SubstationRecord>({ collection: SUBSTATION_COLLECTION, cursor: input.cursor, limit });
  const items: SubstationView[] = resp.records
    .filter((r) => (input.voltageClass ? r.value.voltageClass === input.voltageClass : true))
    .map((r) => ({ ...r.value, substationUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

// ─── Feeder ─────────────────────────────────────────────────────────

export async function defineFeeder(e: Etzhayyim, input: DefineFeederInput): Promise<DefineFeederOutput> {
  if (!input.feederId || !input.substationId) return { status: "rejected", error: "missingRequiredFields" };
  if (!(await exists(e, SUBSTATION_COLLECTION, substationRkey(input.substationId)))) {
    return { status: "substationNotFound", error: "substationNotFound" };
  }
  const rkey = feederRkey(input.feederId);
  const existing = await e.read<FeederRecord>({ collection: FEEDER_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", feederUri: existing.records[0].uri, did: existing.records[0].value.did, feederId: input.feederId };
  }
  const did = feederDid(input.feederId);
  const record: FeederRecord = {
    did,
    feederId: input.feederId,
    substationId: input.substationId.toLowerCase(),
    serviceArea: input.serviceArea,
    ratedAmps: input.ratedAmps,
    status: input.status ?? "energized",
    createdAt: new Date().toISOString(),
  };
  const receipt = await e.write({ collection: FEEDER_COLLECTION, record: record as unknown as Record<string, unknown>, rkey });
  return { status: "defined", feederUri: receipt.uri, did, feederId: input.feederId };
}

export async function getFeeder(e: Etzhayyim, input: GetFeederInput): Promise<GetFeederOutput> {
  if (!input.feederId) return { error: "invalidFeederId" };
  const resp = await e.read<FeederRecord>({ collection: FEEDER_COLLECTION, rkey: feederRkey(input.feederId) }).catch(() => ({ records: [] }));
  const r = resp.records[0];
  if (!r) return { error: "notFound" };
  return { feeder: { ...r.value, feederUri: r.uri } };
}

export async function listFeeders(e: Etzhayyim, input: ListFeedersInput = {}): Promise<ListFeedersOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<FeederRecord>({ collection: FEEDER_COLLECTION, cursor: input.cursor, limit });
  const items: FeederView[] = resp.records
    .filter((r) => {
      const v = r.value;
      if (input.substationId && v.substationId !== input.substationId.toLowerCase()) return false;
      if (input.status && v.status !== input.status) return false;
      return true;
    })
    .map((r) => ({ ...r.value, feederUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

// ─── Outage ─────────────────────────────────────────────────────────

export async function reportOutage(e: Etzhayyim, input: ReportOutageInput): Promise<ReportOutageOutput> {
  if (!input.outageId || !input.feederId || !input.cause) return { status: "rejected", error: "missingRequiredFields" };
  if (!OUTAGE_CAUSES.has(input.cause)) return { status: "rejected", error: "invalidCause" };
  if (!(await exists(e, FEEDER_COLLECTION, feederRkey(input.feederId)))) {
    return { status: "feederNotFound", error: "feederNotFound" };
  }
  const rkey = outageRkey(input.outageId);
  const existing = await e.read<OutageRecord>({ collection: OUTAGE_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", outageUri: existing.records[0].uri, did: existing.records[0].value.did, outageId: input.outageId };
  }
  const did = outageDid(input.outageId);
  const now = new Date().toISOString();
  const record: OutageRecord = {
    did,
    outageId: input.outageId,
    feederId: input.feederId.toLowerCase(),
    cause: input.cause,
    status: "active",
    customersAffected: input.customersAffected,
    reportedAt: input.reportedAt ?? now,
    createdAt: now,
  };
  const receipt = await e.write({ collection: OUTAGE_COLLECTION, record: record as unknown as Record<string, unknown>, rkey });
  return { status: "reported", outageUri: receipt.uri, did, outageId: input.outageId };
}

export async function listOutages(e: Etzhayyim, input: ListOutagesInput = {}): Promise<ListOutagesOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<OutageRecord>({ collection: OUTAGE_COLLECTION, cursor: input.cursor, limit });
  const items: OutageView[] = resp.records
    .filter((r) => {
      const v = r.value;
      if (input.feederId && v.feederId !== input.feederId.toLowerCase()) return false;
      if (input.cause && v.cause !== input.cause) return false;
      if (input.status && v.status !== input.status) return false;
      return true;
    })
    .map((r) => ({ ...r.value, outageUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

// ─── Coverage ───────────────────────────────────────────────────────

async function countAll<T>(e: Etzhayyim, collection: string, maxScan: number, onRow: (v: T) => void): Promise<number> {
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < maxScan) {
    const page = await e.read<T>({ collection, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      if (scanned >= maxScan) break;
      onRow(r.value);
      scanned += 1;
    }
    if (scanned >= maxScan || !page.cursor || page.records.length < PAGE_LIMIT) break;
    cursor = page.cursor;
  }
  return scanned;
}

export async function coverage(e: Etzhayyim, input: CoverageInput = {}): Promise<CoverageOutput> {
  const maxScan = Math.min(input.maxScan ?? DEFAULT_MAX_SCAN, DEFAULT_MAX_SCAN);
  const substationCount = await countAll<SubstationRecord>(e, SUBSTATION_COLLECTION, maxScan, () => {});
  const feedersByStatus: Record<string, number> = {};
  const feederCount = await countAll<FeederRecord>(e, FEEDER_COLLECTION, maxScan, (v) => {
    feedersByStatus[v.status as FeederStatus] = (feedersByStatus[v.status as FeederStatus] ?? 0) + 1;
  });
  let activeOutages = 0;
  const outageCount = await countAll<OutageRecord>(e, OUTAGE_COLLECTION, maxScan, (v) => {
    if (v.status === "active") activeOutages += 1;
  });
  return {
    substationCount,
    feederCount,
    feedersByStatus,
    outageCount,
    activeOutages,
    truncated: substationCount >= maxScan || feederCount >= maxScan || outageCount >= maxScan,
  };
}
