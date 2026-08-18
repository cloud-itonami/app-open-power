# open-power.etzhayyim.com — Electric Grid Operations & Network Design (OSS)

**Status**: MVP scaffold (2026-04-20)、appview は 2026-08-19 に ClojureScript へ
移行（`docs/adr/0001`）。配電網の設計（変電所・フィーダ）と運用（検針・停電）の
リファレンス実装。Apache-2.0。

**この表は設計である。実装状況は §Architecture を読むこと** —— 下の 8 つの XRPC を
実装した面は、この repo に今は無い。

## Scope (MVP) — 設計

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

## Architecture — 実装

- **Runtime**: 単一の CF Worker。**ClojureScript**（`src/openpower/worker.cljs`）を
  shadow-cljs `:target :esm` で `dist/worker.js` にビルドし、`worker/wrangler.jsonc`
  の `main` がそれを指す。移行前は `main` が SvelteKit のビルド出力を指し、読み手が
  開く `worker/src/app.ts` はどの bundle にも入っていなかった（`docs/adr/0001`）。
- **判断は `.cljc`**: route 表は `src/openpower/route.cljc`、ページは
  `src/openpower/view.cljc`。`worker.cljs` だけが Request/Response に触る。
- **deploy される面が答えるもの**: `GET /`（説明ページ）/ `GET /health` /
  `POST /xrpc/:nsid`（MCP router へ中継）。**上の 8 XRPC は実装していない。**
- **UI**: `jp-go-digital-design-system`（デジタル庁デザインシステム）。`--hig-*`
  トークン契約のみ、CSS は `shadow.resource/inline` で bundle に焼く。
- **Storage**: 設計は D1（`nodes` / `feeders` / `meter_readings` / `outages`）。
  **binding は wrangler.jsonc に宣言されたことが無い。**
- **Identity**: `did:web:open-power.etzhayyim.com:{node|feeder|outage}:{id}`
- **Outage class**: 決定表の正本は `dmn/outage-class.dmn`。**これを実行するコードは
  この repo に無い。**
- **`kotoba/`（TypeScript）**: AT PDS 上のレジストリ 9 関数。この bundle には
  **入らない**別の面で、appview 移行の対象外。typecheck exit 0 / vitest 5 passed
  （実測 2026-08-19）。

## Not in MVP

- Real-time SCADA / phasor data
- DR (demand-response), VPP aggregation
- Tariff billing engine, settlement
- N-1 contingency analysis, optimal power flow

## Local Dev

```bash
clojure -P -M:cljs                                  # 依存を取る
npx shadow-cljs release worker                      # dist/worker.js を作る
npx nbb scripts/smoke-worker.cljs dist/worker.js    # bundle を実際に叩く
cd worker && npx wrangler dev --local               # workerd で動かす
```

手順の全文と実測した出力は `docs/operator-quickstart.md`。
**deploy は別の決定である** —— `open-power.etzhayyim.com` も
`mcp.etzhayyim.com` も現在 DNS を解決しない（`docs/adr/0001`）。
