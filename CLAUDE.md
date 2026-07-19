# open-power.etzhayyim.com — Electric Grid Operations & Network Design (OSS)

**Status**: MVP scaffold (2026-04-20). Reference implementation for electric
distribution network design (substations / feeders) and operations
(meter readings, outages). Apache-2.0.

## Scope (MVP)

| NSID | Type | Description |
|---|---|---|
| `com.etzhayyim.apps.openPower.defineSubstation` | procedure | declare a substation node + voltage class |
| `com.etzhayyim.apps.openPower.defineFeeder` | procedure | declare a feeder edge (substation → service area) |
| `com.etzhayyim.apps.openPower.getNode` | query | substation/service-point detail + downstream feeders |
| `com.etzhayyim.apps.openPower.listFeeders` | query | feeders by substation / status |
| `com.etzhayyim.apps.openPower.recordReading` | procedure | meter reading (kWh import / export) |
| `com.etzhayyim.apps.openPower.reportOutage` | procedure | outage with affected feeder + cause |
| `com.etzhayyim.apps.openPower.listOutages` | query | outages by feeder / since |
| `com.etzhayyim.apps.openPower.getLoadProfile` | query | hourly aggregate kWh per feeder |

## Architecture

- **Runtime**: Single CF Worker (`src/app.ts`)
- **Storage**: D1. Tables: `nodes`, `feeders`, `meter_readings`, `outages`
- **Identity**: substation/service point/feeder = path-based DIDs
  `did:web:open-power.etzhayyim.com:{node|feeder|outage}:{id}`
- **Topology**: `nodes` (substation, service_point) + `feeders` (directed
  edges substation → service_point cluster). Voltage class on each node
- **Outage class** by DMN (`openPower.outageClass`): customers affected +
  duration → `{class, requireRegulatoryReport}`
- **Audit**: class ≥ "regional" emits `app.bsky.feed.post`

## Not in MVP

- Real-time SCADA / phasor data
- DR (demand-response), VPP aggregation
- Tariff billing engine, settlement
- N-1 contingency analysis, optimal power flow

## Local Dev / Deploy

```bash
cd 60-apps/etzhayyim-project-open-power/worker
wrangler d1 create etzhayyim-open-power
e7m actor deploy .
```
