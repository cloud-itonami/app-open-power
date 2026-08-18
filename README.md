# app-open-power

配電網（変電所・フィーダ）の設計と運用（停電・検針）を扱う repo。

**2026-08-19、appview を TypeScript/Svelte から ClojureScript へ移した**
（[`docs/adr/0001`](docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn)）。
移行前この repo は「**deploy されるもの・テストが在るもの・機能が書いてあるものが
全部別のファイル**」という状態で、`wrangler.jsonc` の `main` は tree にも disk にも
無い SvelteKit のビルド出力を指し、読み手が application として開く
`worker/src/app.ts`（431 行）は**どの bundle にも入っていなかった**。

いまはこうなっている:

| サブツリー | 何か | deploy されるか |
|---|---|---|
| **`src/openpower/`** | ClojureScript。`route.cljc`(判断) / `view.cljc`(ページ) / `worker.cljs`(Request/Response) | **これが deploy される**（`worker/wrangler.jsonc` の `main` → `../dist/worker.js`）|
| **`kotoba/`** | TypeScript。`@etzhayyim/sdk` の AT PDS レコードの上の**レジストリ 9 関数** | されない（HTTP 入口が無いライブラリ）。**移行の対象外** |
| `bpmn/` `dmn/` `dodaf/` `forms/` | 宣言（BPMN 2 / DMN 1 / DoDAF 6 / Form 2） | データ。実行されない |

この README が書くのは設計ではなく、**実際に測った現状**である。手順は
[`docs/operator-quickstart.md`](docs/operator-quickstart.md)。

## 1. deploy される面が答えるもの

route 表は `src/openpower/route.cljc` の `routes` という 1 つの値で、
**ランディングページはその値を描く**。だから「在る route」と「ページが宣伝する
route」が食い違えない。

| METHOD | PATH | 何をするか |
|---|---|---|
| GET | `/` | この appview の説明ページ（jp-go-dds） |
| GET | `/health` | 生存確認。自分の route を名乗る |
| POST | `/xrpc/:nsid` | XRPC を MCP router へ中継する（この Worker は解釈しない）|

`wrangler dev --local`（workerd）での実測:

```
GET  /                    -> 200 text/html   82,119 B
GET  /health              -> 200 {"ok":true,"app":"open-power","runtime":"cljs",
                                  "routes":["/","/health","/xrpc/:nsid"]}
POST /xrpc/               -> 400 {"error":"Missing XRPC method"}
OPTIONS /xrpc/x           -> 204
GET  /nope                -> 404
POST /health              -> 405
GET  /dodaf               -> 404   （app.ts の route は移植していない）
POST /xrpc/<nsid>         -> 502 {"error":"MCP router unreachable", "url":"https://mcp.etzhayyim.com/…"}
POST /xrpc/a/b            -> 502   （400 ではない。移行前と同じく転送する）
```

**中継先は今日も解決しない。** `mcp.etzhayyim.com` も、route が張られる
`open-power.etzhayyim.com` も `dig +short` が空を返す（対照: apex の
`etzhayyim.com` は解決する）。移行はそれを直さない —— deploy するか retire するかは
別の決定である。**この移行では deploy していない。**

移行前この経路は **500** を返していた。`+server.ts` は upstream が非 2xx のとき
502 を返すよう書かれていたが `fetch` に `catch` が無く、名前解決の失敗は
`fetch` が投げるのでその分岐に入る前に落ちて SvelteKit の汎用 500 になっていた。
cljs 版は `catch` を持ち、意図どおり 502 を試みた URL 付きで返す。

## 2. 移行しなかったもの（黙って消していない）

**`worker/src/app.ts`・`dodaf-bootstrap.ts`・`defence-handlers.ts` は移していない。**
判定は「deploy されたことが無く、かつ binding が宣言されていない」ことで、3 本とも
両方に当たる:

- `app.ts` — `main` から指されておらず、`POWER_DB`(D1) を 19 箇所で使うのに
  `wrangler.jsonc` に `d1_databases` が無い。`package.json` も `tsconfig.json` も
  無いので型検査もビルドもされていなかった。
- `dodaf-bootstrap.ts` — `app.ts` からのみ import されていた。
- `defence-handlers.ts` — どこからも import されておらず、依存の
  `@etzhayyim/kotodama-host-sdk` はこの repo のどの `package.json` にも宣言が無い。

**設計は失われていない。** 8 XRPC の表は [`CLAUDE.md`](CLAUDE.md) と
`dodaf/SV-1.json` に、停電分類の決定表は `dmn/outage-class.dmn` に在る（`app.ts` の
`classifyOutage()` が DMN の 5 ルールと 1 つずつ一致することは確認済みで、乖離は
無かった）。動かない経路を移植して「移行済み」と言わないためにこうしている。

## 3. `kotoba/` は消していない —— appview ではないから

**この repo の TypeScript は全部が appview だったわけではない。**
`kotoba/` は AT PDS 上のレジストリで、

- **どの bundle にも入らない**（`worker/` からも `svelte/` からも import されて
  いなかったし、逆も無い。実測で双方向に確認）
- **依存が実際に解決する** —— 実測 2026-08-19、135 packages が入り、
  `tsc --noEmit` **exit 0（エラー 0 件）**、`vitest run` **5 passed / exit 0**

bundle に入らず、移行が置き換えるものが 1 つも参照せず、依存が解決するものは
**dead ではない**。「TypeScript を全部消す」式の指示でこれを消すのは移行ではなく
破壊である。検証器は `kotoba/` の**ファイル数(7)と `.ts` 数(5)を pin** しており、
黙って育てば落ちる。cljs へ移すかどうかは別の決定で、`@etzhayyim/sdk` の cljs face が要る。

| ファイル | 中身 |
|---|---|
| `src/types.ts` | レコード型 3 種、`VoltageClass` 4 値 / `FeederStatus` 4 値 / `OutageCause` 6 値、DID・rkey 生成 |
| `src/registry.ts` | 本体 9 関数（substation / feeder / outage / coverage）|
| `src/index.ts` | barrel |
| `test/open-power.test.ts` | `MockEtzhayyim` に対する 5 ケース |

## 4. 表面が 3 つとも違っていた（移行後もそのまま）

| メソッド（`com.etzhayyim.apps.openPower.*`） | CLAUDE.md | 旧 `app.ts`（撤去） | `kotoba/` | **deploy される面** |
|---|---|---|---|---|
| `defineSubstation` | ✅ | ✅ | ✅ | 中継のみ |
| `defineFeeder` | ✅ | ✅ | ✅ | 中継のみ |
| `getNode` | ✅ | ✅ | — (`getSubstation`/`getFeeder` に分かれた) | 中継のみ |
| `listFeeders` | ✅ | ✅ | ✅ | 中継のみ |
| `recordReading` | ✅ | ✅ | **無い** | 中継のみ |
| `reportOutage` | ✅ | ✅ | ✅ | 中継のみ |
| `listOutages` | ✅ | ✅ | ✅ | 中継のみ |
| `getLoadProfile` | ✅ | ✅ | **無い** | 中継のみ |
| `listSubstations` / `coverage` | — | — | ✅ | 中継のみ |

**deploy される面は nsid を検査しない** —— `POST /xrpc/<何でも>` をそのまま MCP
router の `tools/call` に詰めて投げる（移行前の `[...path]` と同じ）。したがって
「この Worker が何を受け付けるか」は、この repo の中には書かれていない。

## 5. DoDAF の 2 view が、撤去したファイルを名指ししていた

`dodaf/SV-1.json` は `entrypoint` として、`dodaf/OV-6a.json` は 3 つの `enforcedBy`
として `worker/src/app.ts` を**パスで**指していた（import ではなく散文としての
参照なので、コードの参照検索には出てこない）。実測して書き直した ——
**実装が無い規則は「無い」と書く**:

| 規則 | 移行前 | 実測して書いた記述 |
|---|---|---|
| `rule.feederBelongsSubstation` | `app.ts:defineFeeder()` | `kotoba/src/registry.ts:defineFeeder()`（`substationNotFound` を返し、test が実際に掴んでいる）|
| `rule.voltageMonotonicDownstream` | `app.ts:defineFeeder()` | **not-implemented** —— `registry.ts` は voltageClass が語彙に在るかを見るだけで、上流と下流を比較しない |
| `rule.readingMonotonic` | `app.ts:recordReading()` | **not-implemented** —— `kotoba/` に `recordReading` は無く、`kwh` も `reading` も 1 語も現れない |

`SV-1` の `entrypoint` は `src/openpower/worker.cljs` にしたうえで、その entrypoint が
**8 interface を実装していない**ことを `designed-not-implemented` として明示した。

## 6. この repo に在るもの（35 ファイル）

`etzhayyim/root` の `60-apps/etzhayyim-project-open-power`（rev `7a08afb4`、
31 ファイル / 81,702 バイト）から切り出した standalone artifact
（[`migration.edn`](migration.edn)）。`migration.edn` の `:allowed-additions` は
`README.edn` と `migration.edn` の 2 件しか列挙していないが、実際には
`README.md` / `docs/operator-quickstart.md` / 移行で足した cljs 一式が在る ——
そこは切り出し契約の更新漏れである（fleet の他の repo と同じ扱い）。

手を触れていない 12 ファイル（`README.edn` / `migration.edn` /
`worker/kotodama.jsonld` / `bpmn/`×2 / `dmn/`×1 / `forms/`×2 / `dodaf/` のうち 4）は
**1 バイトも変わっていない**。sha256 を `scripts/verify-docs-claims.cljs` に固定して
ある。意図して変えた `worker/wrangler.jsonc` / `CLAUDE.md` / `dodaf/SV-1.json` /
`dodaf/OV-6a.json` はその集合に入れず、内容で検査する ——
意図した変更と勝手な変更を区別するためである。

## 7. 検査

```bash
nbb scripts/verify-docs-claims.cljs .            # この README の数を tree から derive し直す
nbb scripts/smoke-worker.cljs dist/worker.js     # ビルド済み bundle を実際に叩く
```

いずれも `<dir>` を**引数の先頭**に置く。gate ごとに「壊して赤くなること」を
実演した結果は ADR-0001 の表にある。**落ちない検査は劇場である** ——
実測: `dads-table` が在ることを 1 本で見る検査は、CSS が 1 バイトも入っていない
ページでも 6 回一致するので**落ちない**。`--color-primitive-blue` は 45 → 0 に
なるので落ちる。2 つは別の主張なので 2 つの検査にしてある。

## 8. 前の版の README が間違っていた 1 点（訂正）

2026-08-18 版の §5 は `etzhayyim/com-etzhayyim-app-open-power` を「同じ切り出し元
から出た兄弟で、どちらが正本かはこの repo の中からは決まらない」と書いていた。
**これは誤りである。** その名前は GitHub 上で **この repo 自身**に解決する
（repo id `1305891574` / `created_at 2026-07-19T17:13:18Z` が
`cloud-itonami/app-open-power` と一致。改名前の名前である）。兄弟は存在せず、
正本は 1 つしか無い。

`cloud-itonami/app-open-water` / `app-open-swift` が同じ足場（`kotoba/` +
SvelteKit BFF + BPMN/DMN/DoDAF）の別領域版であるという §5 の記述は、この周では
検証していない。

## 9. ライセンス

Apache-2.0（`kotoba/package.json` の宣言による）。**`LICENSE` ファイルはこの repo
に無い** —— 撤去した `worker/src/*.ts` の SPDX ヘッダは "see LICENSE at repo root" と
書いていたが、その repo root は切り出し元の `etzhayyim/root` だった。
