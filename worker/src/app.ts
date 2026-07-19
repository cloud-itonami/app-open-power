// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 etzhayyim Japan株式会社 / etzhayyim. All rights reserved.
// Licensed under the Apache License, Version 2.0 — see LICENSE at repo root.

// etzhayyim-project-open-power — electric distribution operations + grid design
//
// 8 XRPC under com.etzhayyim.apps.openPower.*:
//   defineSubstation  (proc)   network design — substation node
//   defineFeeder      (proc)   network design — feeder edge + downstream service points
//   getNode           (query)  node detail + downstream feeders
//   listFeeders       (query)  feeders by substation / status
//   recordReading     (proc)   meter kWh import / export
//   reportOutage      (proc)   outage with cause
//   listOutages       (query)  outages by feeder / since / minClass
//   getLoadProfile    (query)  hourly aggregate per feeder
//
// Storage: D1. Topology = nodes + feeders (directed substation → service points).
// Outage class via openPower.outageClass DMN (mirrored in code).
// class ∈ {regional, systemic} → app.bsky.feed.post audit via PDS.

import AV1 from "../../dodaf/AV-1.json";
import OV1 from "../../dodaf/OV-1.json";
import OV5b from "../../dodaf/OV-5b.json";
import OV6a from "../../dodaf/OV-6a.json";
import CV2 from "../../dodaf/CV-2.json";
import SV1 from "../../dodaf/SV-1.json";
import defineFeederForm from "../../forms/defineFeeder.form.json";
import reportOutageForm from "../../forms/reportOutage.form.json";
import { bootstrapDodaf } from "./dodaf-bootstrap";

const DODAF_VIEWS: Record<string, any> = {
  "open-power.AV-1": AV1, "open-power.OV-1": OV1, "open-power.OV-5b": OV5b,
  "open-power.OV-6a": OV6a, "open-power.CV-2": CV2, "open-power.SV-1": SV1,
};
const FORMS: Record<string, any> = {
  "openPower.defineFeeder.v1": defineFeederForm,
  "openPower.reportOutage.v1": reportOutageForm,
};

export interface Env {
  POWER_DB: D1Database;
  PDS?: Fetcher;
  AUTH_SERVICE?: Fetcher;
  APP_HANDLE: string;
  PRIMARY_DID: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nodes (
    node_did TEXT PRIMARY KEY,
    node_type TEXT NOT NULL CHECK (node_type IN ('substation','service_point')),
    node_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    voltage_class_kv REAL NOT NULL,
    operator_did TEXT NOT NULL,
    parent_feeder_did TEXT,
    defined_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(node_type)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_feeder_did)`,
  `CREATE TABLE IF NOT EXISTS feeders (
    feeder_did TEXT PRIMARY KEY,
    feeder_code TEXT NOT NULL UNIQUE,
    substation_did TEXT NOT NULL,
    voltage_class_kv REAL NOT NULL,
    rated_amps REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'in-service',
    defined_at TEXT NOT NULL,
    FOREIGN KEY (substation_did) REFERENCES nodes(node_did)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feeders_substation ON feeders(substation_did)`,
  `CREATE TABLE IF NOT EXISTS meter_readings (
    reading_id TEXT PRIMARY KEY,
    service_point_did TEXT NOT NULL,
    feeder_did TEXT NOT NULL,
    read_at TEXT NOT NULL,
    kwh_import REAL NOT NULL,
    kwh_export REAL NOT NULL DEFAULT 0,
    quality TEXT NOT NULL DEFAULT 'actual'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_readings_sp_time ON meter_readings(service_point_did, read_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_readings_feeder_time ON meter_readings(feeder_did, read_at)`,
  `CREATE TABLE IF NOT EXISTS outages (
    outage_did TEXT PRIMARY KEY,
    feeder_did TEXT NOT NULL,
    started_at TEXT NOT NULL,
    restored_at TEXT,
    customers_affected INTEGER NOT NULL,
    cause TEXT NOT NULL,
    class TEXT NOT NULL,
    require_regulatory_report INTEGER NOT NULL,
    description TEXT,
    reported_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outages_feeder_time ON outages(feeder_did, started_at DESC)`,
];

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  for (const s of SCHEMA) await db.exec(s.replace(/\s+/g, " "));
  schemaReady = true;
}

function nanoid(len = 12): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.getRandomValues(new Uint8Array(len));
  let o = ""; for (let i = 0; i < len; i++) o += a[b[i] % a.length]; return o;
}
const now = () => new Date().toISOString();

type XrpcError = "InvalidRequest" | "NodeNotFound" | "FeederNotFound" | "Conflict" | "Unauthorized" | "InternalError";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const err = (e: XrpcError, m: string, s = 400) => json({ error: e, message: m }, s);

function classifyOutage(input: { customersAffected: number; durationMin: number })
  : { class: "isolated" | "local" | "regional" | "systemic"; requireRegulatoryReport: boolean } {
  if (input.customersAffected >= 50000) return { class: "systemic", requireRegulatoryReport: true };
  if (input.customersAffected >= 5000)  return { class: "regional", requireRegulatoryReport: true };
  if (input.durationMin >= 240)         return { class: "regional", requireRegulatoryReport: true };
  if (input.customersAffected >= 100)   return { class: "local", requireRegulatoryReport: false };
  return { class: "isolated", requireRegulatoryReport: false };
}

async function defineSubstation(env: Env, input: any): Promise<Response> {
  const { nodeCode, name, voltageClassKv, operatorDid } = input ?? {};
  if (typeof nodeCode !== "string" || !/^[A-Z0-9-]{2,32}$/.test(nodeCode))
    return err("InvalidRequest", "nodeCode required (A-Z0-9-, 2-32)");
  if (typeof name !== "string" || !name.length) return err("InvalidRequest", "name required");
  if (!Number.isFinite(voltageClassKv) || voltageClassKv <= 0)
    return err("InvalidRequest", "voltageClassKv > 0 required");
  if (typeof operatorDid !== "string" || !operatorDid.startsWith("did:"))
    return err("InvalidRequest", "operatorDid must be a DID");
  const id = nanoid(10);
  const nodeDid = `did:web:${env.APP_HANDLE}:node:${id}`;
  const definedAt = now();
  await env.POWER_DB.prepare(
    `INSERT INTO nodes (node_did, node_type, node_code, name, voltage_class_kv, operator_did, parent_feeder_did, defined_at)
     VALUES (?, 'substation', ?, ?, ?, ?, NULL, ?)`
  ).bind(nodeDid, nodeCode, name, voltageClassKv, operatorDid, definedAt).run();
  return json({ nodeDid, nodeType: "substation", nodeCode, name, voltageClassKv, operatorDid, definedAt });
}

async function defineFeeder(env: Env, input: any): Promise<Response> {
  const { substationDid, feederCode, voltageClassKv, ratedAmps, servicePoints } = input ?? {};
  if (typeof substationDid !== "string") return err("InvalidRequest", "substationDid required");
  if (typeof feederCode !== "string" || !/^[A-Z0-9-]{2,16}$/.test(feederCode))
    return err("InvalidRequest", "feederCode required");
  if (!Number.isFinite(voltageClassKv) || voltageClassKv <= 0)
    return err("InvalidRequest", "voltageClassKv > 0 required");
  if (!Number.isFinite(ratedAmps) || ratedAmps <= 0)
    return err("InvalidRequest", "ratedAmps > 0 required");
  if (!Array.isArray(servicePoints) || servicePoints.length < 1)
    return err("InvalidRequest", "servicePoints[] requires ≥ 1 entry");
  const sub = await env.POWER_DB.prepare(`SELECT * FROM nodes WHERE node_did = ?`).bind(substationDid).first<any>();
  if (!sub) return err("NodeNotFound", "substation not found", 404);
  if (sub.node_type !== "substation") return err("InvalidRequest", "origin must be substation");
  if (voltageClassKv > sub.voltage_class_kv)
    return err("InvalidRequest", "feeder voltage > substation voltage (no step-up downstream)");
  for (const sp of servicePoints) {
    if (typeof sp?.code !== "string" || typeof sp?.name !== "string" || !Number.isFinite(sp?.voltageClassKv))
      return err("InvalidRequest", "service point requires {code,name,voltageClassKv}");
    if (sp.voltageClassKv > voltageClassKv)
      return err("InvalidRequest", `service point ${sp.code} voltage > feeder voltage`);
  }

  const fid = nanoid(10);
  const feederDid = `did:web:${env.APP_HANDLE}:feeder:${fid}`;
  const definedAt = now();
  const stmts: D1PreparedStatement[] = [
    env.POWER_DB.prepare(
      `INSERT INTO feeders (feeder_did, feeder_code, substation_did, voltage_class_kv, rated_amps, status, defined_at)
       VALUES (?, ?, ?, ?, ?, 'in-service', ?)`
    ).bind(feederDid, feederCode, substationDid, voltageClassKv, ratedAmps, definedAt),
  ];
  const servicePointDids: string[] = [];
  for (const sp of servicePoints) {
    const sid = nanoid(10);
    const spDid = `did:web:${env.APP_HANDLE}:node:${sid}`;
    servicePointDids.push(spDid);
    stmts.push(env.POWER_DB.prepare(
      `INSERT INTO nodes (node_did, node_type, node_code, name, voltage_class_kv, operator_did, parent_feeder_did, defined_at)
       VALUES (?, 'service_point', ?, ?, ?, ?, ?, ?)`
    ).bind(spDid, sp.code, sp.name, sp.voltageClassKv, sub.operator_did, feederDid, definedAt));
  }
  await env.POWER_DB.batch(stmts);
  return json({ feederDid, feederCode, substationDid, voltageClassKv, ratedAmps, servicePointDids, definedAt });
}

async function getNode(env: Env, params: URLSearchParams): Promise<Response> {
  const nodeDid = params.get("nodeDid");
  if (!nodeDid) return err("InvalidRequest", "nodeDid required");
  const n = await env.POWER_DB.prepare(`SELECT * FROM nodes WHERE node_did = ?`).bind(nodeDid).first<any>();
  if (!n) return err("NodeNotFound", "no such node", 404);
  let downstream: any[] = [];
  if (n.node_type === "substation") {
    const f = await env.POWER_DB.prepare(`SELECT * FROM feeders WHERE substation_did = ?`).bind(nodeDid).all<any>();
    downstream = (f.results ?? []).map((r) => ({
      feederDid: r.feeder_did, feederCode: r.feeder_code, voltageClassKv: r.voltage_class_kv,
      ratedAmps: r.rated_amps, status: r.status,
    }));
  }
  return json({
    nodeDid: n.node_did, nodeType: n.node_type, nodeCode: n.node_code, name: n.name,
    voltageClassKv: n.voltage_class_kv, operatorDid: n.operator_did,
    parentFeederDid: n.parent_feeder_did ?? undefined, definedAt: n.defined_at,
    downstreamFeeders: downstream,
  });
}

async function listFeeders(env: Env, params: URLSearchParams): Promise<Response> {
  const sub = params.get("substationDid");
  const status = params.get("status");
  const limit = Math.min(500, Math.max(1, Number(params.get("limit") ?? 100)));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));
  const clauses: string[] = []; const binds: any[] = [];
  if (sub) { clauses.push(`substation_did = ?`); binds.push(sub); }
  if (status) { clauses.push(`status = ?`); binds.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = await env.POWER_DB.prepare(`SELECT COUNT(*) AS c FROM feeders ${where}`)
    .bind(...binds).first<{ c: number }>();
  const rows = await env.POWER_DB.prepare(
    `SELECT * FROM feeders ${where} ORDER BY defined_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all<any>();
  return json({
    feeders: (rows.results ?? []).map((r) => ({
      feederDid: r.feeder_did, feederCode: r.feeder_code, substationDid: r.substation_did,
      voltageClassKv: r.voltage_class_kv, ratedAmps: r.rated_amps, status: r.status, definedAt: r.defined_at,
    })),
    total: Number(total?.c ?? 0), offset, limit,
  });
}

async function recordReading(env: Env, input: any): Promise<Response> {
  const { servicePointDid, readAt, kwhImport, kwhExport, quality } = input ?? {};
  if (typeof servicePointDid !== "string") return err("InvalidRequest", "servicePointDid required");
  if (typeof readAt !== "string") return err("InvalidRequest", "readAt required (ISO 8601)");
  if (!Number.isFinite(kwhImport) || kwhImport < 0)
    return err("InvalidRequest", "kwhImport ≥ 0 required");
  const exp = Number.isFinite(kwhExport) ? kwhExport : 0;
  if (exp < 0) return err("InvalidRequest", "kwhExport ≥ 0");
  const sp = await env.POWER_DB.prepare(`SELECT * FROM nodes WHERE node_did = ? AND node_type = 'service_point'`)
    .bind(servicePointDid).first<any>();
  if (!sp) return err("NodeNotFound", "service point not found", 404);
  if (!sp.parent_feeder_did) return err("Conflict", "service point not connected to a feeder", 409);

  const last = await env.POWER_DB.prepare(
    `SELECT kwh_import, kwh_export FROM meter_readings WHERE service_point_did = ? ORDER BY read_at DESC LIMIT 1`
  ).bind(servicePointDid).first<{ kwh_import: number; kwh_export: number }>();
  if (last && (kwhImport < last.kwh_import || exp < last.kwh_export))
    return err("Conflict", "reading not monotonic (import or export decreased)", 409);

  const id = `r_${nanoid(14)}`;
  await env.POWER_DB.prepare(
    `INSERT INTO meter_readings (reading_id, service_point_did, feeder_did, read_at, kwh_import, kwh_export, quality)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, servicePointDid, sp.parent_feeder_did, readAt, kwhImport, exp, quality ?? "actual").run();
  return json({ readingId: id, servicePointDid, feederDid: sp.parent_feeder_did, readAt, kwhImport, kwhExport: exp, quality: quality ?? "actual" });
}

async function reportOutage(env: Env, input: any): Promise<Response> {
  const { feederDid, startedAt, restoredAt, customersAffected, cause, description } = input ?? {};
  if (typeof feederDid !== "string") return err("InvalidRequest", "feederDid required");
  if (typeof startedAt !== "string") return err("InvalidRequest", "startedAt required");
  if (!Number.isFinite(customersAffected) || customersAffected < 0)
    return err("InvalidRequest", "customersAffected ≥ 0");
  if (typeof cause !== "string") return err("InvalidRequest", "cause required");
  const f = await env.POWER_DB.prepare(`SELECT feeder_did FROM feeders WHERE feeder_did = ?`).bind(feederDid).first<any>();
  if (!f) return err("FeederNotFound", "no such feeder", 404);
  const durationMin = restoredAt
    ? Math.max(0, Math.round((Date.parse(restoredAt) - Date.parse(startedAt)) / 60000))
    : 0;
  const { class: klass, requireRegulatoryReport } = classifyOutage({
    customersAffected: Number(customersAffected), durationMin,
  });
  const id = nanoid(12);
  const outageDid = `did:web:${env.APP_HANDLE}:outage:${id}`;
  const reportedAt = now();
  await env.POWER_DB.prepare(
    `INSERT INTO outages (outage_did, feeder_did, started_at, restored_at, customers_affected, cause, class, require_regulatory_report, description, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(outageDid, feederDid, startedAt, restoredAt ?? null, customersAffected, cause,
         klass, requireRegulatoryReport ? 1 : 0, description ?? null, reportedAt).run();
  if (requireRegulatoryReport && env.PDS) {
    try {
      await env.PDS.fetch(`https://atproto.etzhayyim.com/xrpc/com.atproto.repo.createRecord`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: env.PRIMARY_DID,
          collection: "app.bsky.feed.post",
          record: {
            $type: "app.bsky.feed.post",
            text: `[${klass.toUpperCase()}] outage on ${feederDid} (${cause}, ${customersAffected} customers, ${durationMin}min)`,
            createdAt: reportedAt,
          },
        }),
      });
    } catch {}
  }
  return json({ outageDid, feederDid, class: klass, requireRegulatoryReport, durationMin, reportedAt });
}

async function listOutages(env: Env, params: URLSearchParams): Promise<Response> {
  const feederDid = params.get("feederDid");
  const since = params.get("since");
  const minClass = params.get("minClass");
  const limit = Math.min(500, Math.max(1, Number(params.get("limit") ?? 100)));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));
  const rank = (k: string) => ({ isolated: 0, local: 1, regional: 2, systemic: 3 } as any)[k] ?? -1;
  const clauses: string[] = []; const binds: any[] = [];
  if (feederDid) { clauses.push(`feeder_did = ?`); binds.push(feederDid); }
  if (since) { clauses.push(`started_at >= ?`); binds.push(since); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = await env.POWER_DB.prepare(`SELECT COUNT(*) AS c FROM outages ${where}`)
    .bind(...binds).first<{ c: number }>();
  const rows = await env.POWER_DB.prepare(
    `SELECT * FROM outages ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all<any>();
  let outages = (rows.results ?? []).map((r) => ({
    outageDid: r.outage_did, feederDid: r.feeder_did, startedAt: r.started_at,
    restoredAt: r.restored_at ?? undefined, customersAffected: r.customers_affected,
    cause: r.cause, class: r.class, requireRegulatoryReport: !!r.require_regulatory_report,
    description: r.description ?? undefined, reportedAt: r.reported_at,
  }));
  if (minClass) outages = outages.filter((o) => rank(o.class) >= rank(minClass));
  return json({ outages, total: Number(total?.c ?? 0), offset, limit });
}

async function getLoadProfile(env: Env, params: URLSearchParams): Promise<Response> {
  const feederDid = params.get("feederDid");
  if (!feederDid) return err("InvalidRequest", "feederDid required");
  const since = params.get("since");
  const until = params.get("until") ?? now();
  if (!since) return err("InvalidRequest", "since (ISO 8601) required");
  // Hourly bucketed sum of (import - export) deltas. Computed by ordering
  // readings within the window and summing deltas per service-point per hour.
  // For MVP simplicity: per service-point delta = max - min in the bucket.
  const rows = await env.POWER_DB.prepare(
    `SELECT service_point_did, read_at, kwh_import, kwh_export
     FROM meter_readings
     WHERE feeder_did = ? AND read_at >= ? AND read_at <= ?
     ORDER BY service_point_did, read_at ASC`
  ).bind(feederDid, since, until).all<any>();
  const buckets = new Map<string, number>();
  const bySp = new Map<string, any[]>();
  for (const r of rows.results ?? []) {
    if (!bySp.has(r.service_point_did)) bySp.set(r.service_point_did, []);
    bySp.get(r.service_point_did)!.push(r);
  }
  for (const list of bySp.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      const hour = cur.read_at.slice(0, 13) + ":00:00Z"; // YYYY-MM-DDTHH:00:00Z
      const dImp = Math.max(0, cur.kwh_import - prev.kwh_import);
      const dExp = Math.max(0, cur.kwh_export - prev.kwh_export);
      buckets.set(hour, (buckets.get(hour) ?? 0) + (dImp - dExp));
    }
  }
  const profile = [...buckets.entries()].sort().map(([hour, kwh]) => ({ hour, netKwh: kwh }));
  return json({ feederDid, since, until, profile });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      await ensureSchema(env.POWER_DB);
      const url = new URL(req.url);
      if (url.pathname === "/health" || url.pathname === "/_worker/health")
        return json({ ok: true, did: env.PRIMARY_DID, ts: now() });
      if (url.pathname === "/_app/meta") {
        if (env.PDS) { try { await bootstrapDodaf(env as any); } catch {} }
        return json({
          did: env.PRIMARY_DID, handle: env.APP_HANDLE,
          xrpc: [
            "com.etzhayyim.apps.openPower.defineSubstation",
            "com.etzhayyim.apps.openPower.defineFeeder",
            "com.etzhayyim.apps.openPower.getNode",
            "com.etzhayyim.apps.openPower.listFeeders",
            "com.etzhayyim.apps.openPower.recordReading",
            "com.etzhayyim.apps.openPower.reportOutage",
            "com.etzhayyim.apps.openPower.listOutages",
            "com.etzhayyim.apps.openPower.getLoadProfile",
          ],
          dodaf: Object.keys(DODAF_VIEWS), forms: Object.keys(FORMS),
          bpmn: ["defineFeeder", "reportOutage"], dmn: ["openPower.outageClass"],
        });
      }
      if (url.pathname === "/dodaf")
        return json({ views: Object.entries(DODAF_VIEWS).map(([id, v]: any) => ({
          viewId: id, viewType: v.viewType, title: v.title, version: v.version })) });
      if (url.pathname.startsWith("/dodaf/")) {
        const id = decodeURIComponent(url.pathname.slice("/dodaf/".length));
        const v = DODAF_VIEWS[id];
        return v ? json(v) : err("InvalidRequest", `no such view: ${id}`, 404);
      }
      if (url.pathname === "/forms")
        return json({ forms: Object.values(FORMS).map((f: any) => ({ formKey: f.formKey, name: f.name, version: f.version })) });
      if (url.pathname.startsWith("/forms/")) {
        const k = decodeURIComponent(url.pathname.slice("/forms/".length));
        const f = FORMS[k];
        return f ? json(f) : err("InvalidRequest", `no such form: ${k}`, 404);
      }
      if (!url.pathname.startsWith("/xrpc/"))
        return err("InvalidRequest", "only /xrpc/* is served", 404);
      const nsid = url.pathname.slice("/xrpc/".length);
      if (req.method === "GET") {
        switch (nsid) {
          case "com.etzhayyim.apps.openPower.getNode":         return await getNode(env, url.searchParams);
          case "com.etzhayyim.apps.openPower.listFeeders":     return await listFeeders(env, url.searchParams);
          case "com.etzhayyim.apps.openPower.listOutages":     return await listOutages(env, url.searchParams);
          case "com.etzhayyim.apps.openPower.getLoadProfile":  return await getLoadProfile(env, url.searchParams);
          default: return err("InvalidRequest", `unknown query NSID: ${nsid}`, 404);
        }
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        switch (nsid) {
          case "com.etzhayyim.apps.openPower.defineSubstation": return await defineSubstation(env, body);
          case "com.etzhayyim.apps.openPower.defineFeeder":     return await defineFeeder(env, body);
          case "com.etzhayyim.apps.openPower.recordReading":    return await recordReading(env, body);
          case "com.etzhayyim.apps.openPower.reportOutage":     return await reportOutage(env, body);
          default: return err("InvalidRequest", `unknown procedure NSID: ${nsid}`, 404);
        }
      }
      return err("InvalidRequest", "method not allowed", 405);
    } catch (e: any) {
      return err("InternalError", e?.message ?? String(e), 500);
    }
  },
};
