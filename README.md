# app-open-power

配電網（変電所・フィーダ）の設計と運用（停電・検針）を扱う repo。**ただし、この
repo には同じ主題の実装が 3 つ入っていて、そのうち「デプロイされるもの」と
「テストが在るもの」と「機能が書いてあるもの」が**全部別のファイルである**。

| サブツリー | 何か | 動くか | デプロイされるか |
|---|---|---|---|
| **`kotoba/`** | TypeScript。`@etzhayyim/sdk` の AT PDS レコードの上の**レジストリ 9 関数**（substation / feeder / outage / coverage） | **動く**（typecheck exit 0、vitest **5 passed**） | **されない**（HTTP 入口が無いライブラリ） |
| **`worker/svelte/`** | SvelteKit + `adapter-cloudflare`。**route は 2 本だけ** —— `/`（雛形ページ）と `POST /xrpc/[...path]`（`mcp.etzhayyim.com` への転送） | **ビルドは通る**（`vite build` exit 0、`svelte-check` 0 errors） | **これがデプロイされる**（`wrangler.jsonc` の `main`） |
| **`worker/src/app.ts`** | D1 を張った本体。**8 つの XRPC + `/health` + DMN 停電分類 + BPMN/DoDAF/Form の配布** | **ビルドされない**（`package.json` も `tsconfig` も無い） | **されない** |

**つまり、この repo の機能は `worker/src/app.ts`（22,332 B、431 行）に書いてあるが、
それは何からも読まれていない。** デプロイされるのは 2 route の薄い proxy で、
その転送先 `mcp.etzhayyim.com` は**現在 DNS を解決しない**（§3-B）。

[`CLAUDE.md`](CLAUDE.md) は 8 つの XRPC を表で列挙していて、**設計文書としては
正しい**（`app.ts` の実装と一致する）。**この repo の現状の説明として読むと必ず
間違える** —— そこに書かれた `Local Dev / Deploy` の 3 行は、いま 1 行も実行できない
（§3-E）。

この README が書くのは設計ではなく、**2026-08-18 に実際に測った現状**である。
手順は [`docs/operator-quickstart.md`](docs/operator-quickstart.md)。

## 1. この repo に在るもの（33 ファイル / 82,167 バイト）

`etzhayyim/root` の `60-apps/etzhayyim-project-open-power`（rev `7a08afb4`、
31 ファイル / 81,702 バイト）から切り出した standalone artifact
（[`migration.edn`](migration.edn)）。追加の 2 件が `README.edn` と `migration.edn`。
**この `README.md` と `docs/operator-quickstart.md` はさらに後から足している** ——
`migration.edn` の `:allowed-additions` はまだこの 2 件を列挙していないので、
そこは切り出し契約の更新漏れである（fleet の他の repo と同じ扱い。実測: 同じ
`:allowed-additions ["README.edn" "migration.edn"]` を持つ `app-legal-entity` /
`app-itonami` も既に `README.md` + `docs/operator-quickstart.md` を持っている）。

### `kotoba/` — AT PDS 上のレジストリ（TypeScript、唯一テストが在る面）

| ファイル | 中身 |
|---|---|
| `src/types.ts`（6,110 B） | レコード型 3 種、`VoltageClass` 4 値 / `FeederStatus` 4 値 / `OutageCause` 6 値 / `OutageStatus` 2 値、DID・rkey 生成 |
| `src/registry.ts`（10,338 B） | 本体 9 関数。コレクションは `…openPower.substation` / `.feeder` / `.outage` の 3 本 |
| `src/index.ts`（598 B） | barrel |
| `test/open-power.test.ts`（3,254 B） | `MockEtzhayyim` に対する 5 ケース |

外部キーは実際に検査される: `defineFeeder` は substation の存在を、`reportOutage` は
feeder の存在を確認し、無ければ `substationNotFound` / `feederNotFound` を返す
（**この 2 つを外すとテストが赤くなることを実測した** —— §4）。ID は
`substationRkey` 等で小文字に正規化され、`listFeeders({substationId})` の照合も
小文字化してから比較する。

`coverage()` は 3 コレクションを最大 10,000 件まで走査して
`{substationCount, feederCount, feedersByStatus, outageCount, activeOutages, truncated}`
を返す。**打ち切りを黙って起こさない** —— `truncated` を必ず返す。

### `worker/` — デプロイされる面（2 route）と、されない面（8 XRPC）

| ファイル | 中身 | 到達可能か |
|---|---|---|
| `svelte/src/routes/+page.svelte`（3,081 B） | 生成された雛形ページ | **到達する**（`GET /` → 200） |
| `svelte/src/routes/xrpc/[...path]/+server.ts`（2,803 B） | 任意の nsid を MCP router へ転送 | **到達する**（`POST /xrpc/…`） |
| `src/app.ts`（22,332 B） | 8 XRPC + `/health` + `/_worker/health` + `/_app/meta` + `/dodaf` + `/forms` | **到達しない** |
| `src/defence-handlers.ts`（3,423 B） | defence イベント 1 件を Hyperdrive へ書く handler | **到達しない**（§3-D） |
| `src/dodaf-bootstrap.ts`（1,727 B） | DoDAF ビューの bootstrap | `app.ts` からのみ |

`wrangler.jsonc` の `main` は `svelte/.svelte-kit/cloudflare/_worker.js` である。
**`src/` を指してはいない。**

### 宣言ファイル（BPMN / DMN / DoDAF / Form）

`bpmn/`（2）・`dmn/`（1）・`dodaf/`（6）・`forms/`（2）。**DoDAF と Form は
`app.ts` が `import` して配信する。BPMN と DMN は誰も parse しない** ——
`app.ts:386` が名前を文字列として列挙するだけである。

DMN の中身は 5 ルールの決定表（`customersAffected` と `durationMin` から
`{class, requireRegulatoryReport}` を出す）で、**`app.ts:118-122` の
`classifyOutage()` と 1 ルールずつ突き合わせて一致することを確認した**
（`>=50000 systemic` / `>=5000 regional` / `durationMin>=240 regional` /
`>=100 local` / それ以外 `isolated`、report フラグも一致）。乖離は無い。

**ただしこの分類は、動く面のどこにも無い。** `kotoba/` には
`classify` も `duration` も `kWh` も 1 語も無く、デプロイされる 2 route も
分類しない。**この領域で唯一の「判断」が、実行される経路から届かない場所にある。**

## 2. 表面が 3 つとも違う

| メソッド（`com.etzhayyim.apps.openPower.*`） | CLAUDE.md | `app.ts`（未デプロイ） | `kotoba/`（テスト有） |
|---|---|---|---|
| `defineSubstation` | ✅ | ✅ | ✅ |
| `defineFeeder` | ✅ | ✅ | ✅ |
| `getNode` | ✅ | ✅ | — （`getSubstation` / `getFeeder` に分かれた） |
| `listFeeders` | ✅ | ✅ | ✅ |
| `recordReading` | ✅ | ✅ | **無い** |
| `reportOutage` | ✅ | ✅ | ✅ |
| `listOutages` | ✅ | ✅ | ✅ |
| `getLoadProfile` | ✅ | ✅ | **無い** |
| `listSubstations` | — | — | ✅ |
| `coverage` | — | — | ✅ |

デプロイされる `+server.ts` は **nsid を検査しない** —— `POST /xrpc/<何でも>` を
そのまま MCP router の `tools/call` に詰めて投げる。したがって「この Worker が
何を受け付けるか」は、この repo の中には書かれていない。

## 3. 測って見つけた欠陥（この周では 1 件も直していない）

**A. `/health` が 404 になる。** `app.ts` は `/health` を持つが、デプロイされるのは
SvelteKit 側で、そこに `/health` route は無い。`wrangler dev` を上げて実測:

```
GET /       -> 200   （雛形ページ）
GET /health -> 404   （SvelteKit の 404 HTML）
```

superproject の `scripts/verify-appview-facade.cljs` も独立に同じことを報告している
（`health-only-in-undeployed-facade:orgs/cloud-itonami/app-open-power`）。

**B. 転送先が解決しない。** `wrangler.jsonc` の `AGENTGATEWAY_MCP_ROUTER_URL` と
`+server.ts` の既定値が指す `mcp.etzhayyim.com`、および route が張られる
`open-power.etzhayyim.com` の**両方が DNS を解決しない**（`dig +short` が空）。
対照として apex の `etzhayyim.com` は解決して `GET /` が 200 を返すので、
測定側の問題ではない。

その結果、ローカルの proxy は **500** を返す:

```
POST /xrpc/com.etzhayyim.apps.openPower.listFeeders -> 500 {"message":"Internal Error"}
```

**500 は `+server.ts` が意図した応答ではない。** あのコードは upstream が
非 2xx を返したとき `502` + `{error:'MCP router request failed'}` を返すよう
書かれている。名前解決の失敗は `fetch` が**投げる**ので、その分岐に入る前に
落ちて SvelteKit の汎用 500 になる。`fetch` に `catch` が無い。

**C. `app.ts` は D1 の binding を持たない。** `POWER_DB` を 19 箇所で使うが、
`wrangler.jsonc` に `d1_databases` の項目は無い。`worker/` には `package.json` も
`tsconfig.json` も無いので、**このファイルは型検査もビルドもされていない**
（`worker/svelte/tsconfig.json` は `svelte/` 配下しか見ない）。

**D. `defence-handlers.ts` はどこからも import されていない。** ファイル冒頭の
コメント自身が「`app.ts` にこう配線せよ」と書いているが、`app.ts` に `defence` の
語は 1 つも無い。さらにこの handler は `@etzhayyim/kotodama-host-sdk` を import
するが、**その依存はこの repo のどの `package.json` にも宣言されていない**。

**E. `CLAUDE.md` の `Local Dev / Deploy` は 3 行とも実行できない。**

| 行 | 実測 |
|---|---|
| `cd 60-apps/etzhayyim-project-open-power/worker` | そのパスは無い。**この repo 自身がその directory** である（`migration.edn`） |
| `wrangler d1 create etzhayyim-open-power` | 作れても binding が無いので何にも繋がらない（§3-C） |
| `e7m actor deploy .` | `e7m` は PATH に無い |

**F. 雛形が残っている。** `+page.svelte` に埋め込まれた定数は
`"title":"Worker"` / `"name":"worker"` / `"routeCount":0` / `"routes":[]` で、
`relativePath` は切り出し前の `60-apps/…` を指したままである。ページの
`<title>` は `worker` になる。

**G. 環境側の罠（repo の欠陥ではない）。** このマシンでは `npm install` が
`EALLOWSCRIPTS` で落ちる —— `~/.npmrc` の `allow-scripts[]=` が git 依存の
準備 install（`npm install --force …`）に漏れ、npm 11.16.0 がそれを
「project-scoped install では使えない」と拒否する。**空の userconfig で隔離すると
成功する**ので、これは repo ではなくこの端末の設定である
（[`docs/operator-quickstart.md`](docs/operator-quickstart.md) §0 に回避策）。
**この理由で repo 側を「直さない」こと。**

## 4. テストが実際に何かを掴んでいることの確認

`kotoba/` の 5 ケースについて、**3 箇所を壊して、壊した不変条件と落ちたテストが
一致することを実測した**（3 件とも復元後に `git diff --exit-code` が exit 0、
再実行で 5 passed に復帰）:

| 壊した箇所 | 落ちたテスト | 報告 |
|---|---|---|
| `types.ts` の `OUTAGE_CAUSES` から `vegetation` を削除 | `filters outages + coverage rolls up active` **のみ** | `expected 1 to be 2`（`outageCount`） |
| `registry.ts` の `defineFeeder` から substation 存在ガードを削除 | `defines against existing substation; rejects missing` **のみ** | `expected 'defined' to be 'substationNotFound'` |
| `registry.ts` の `listFeeders` から status フィルタを削除 | `lists by substation + status` **のみ** | `expected 2 to be 1` |

**掴めていない箇所**（この周では足していない）: `listOutages` の `status` フィルタ、
`coverage` の `truncated`、`alreadyExists` 経路、`getSubstation` / `getFeeder` の
`notFound`、`limit` の上限 200。

## 5. 最近接の repo との境界

- **`etzhayyim/com-etzhayyim-app-open-power`** —— 同じ切り出し元から出た兄弟で、
  `verify-appview-facade` は**両方に同一の finding** を報告している。どちらが
  正本かはこの repo の中からは決まらない。
- **`cloud-itonami/app-open-water` / `app-open-swift`** —— 同じ足場（`kotoba/` +
  SvelteKit BFF + BPMN/DMN/DoDAF）の別領域版。構造が同型なので、ここに書いた
  欠陥 A〜F は**そちらでも当たる可能性が高い**（未確認）。

## 6. ライセンス

Apache-2.0（`worker/src/*.ts` の SPDX ヘッダによる）。**ただし `LICENSE` ファイルは
この repo に無い** —— ヘッダは "see LICENSE at repo root" と書いているが、その
repo root は切り出し元の `etzhayyim/root` である。
