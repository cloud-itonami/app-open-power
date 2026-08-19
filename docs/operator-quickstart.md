# operator-quickstart — app-open-power

**ここに書いてあるコマンドは、2026-08-19 に実際に走らせたものだけである。**
出力は実際の出力を貼っている。走らせていないものは「走らせていない」と書く。

前提: このリポジトリのルートで実行する。`npx` が nbb / shadow-cljs / wrangler を
取ってくる（このワークスペースの script host は nbb。`bb` は使わない）。

## 0. この端末固有の罠 —— `npm install` が `EALLOWSCRIPTS` で落ちる

`kotoba/` の依存を入れるときだけ関係する。`~/.npmrc` の `allow-scripts[]=` が
git 依存の準備 install に漏れ、npm がそれを拒否する。**空の userconfig で隔離すると
通る**ので、これは repo ではなくこの端末の設定である。**この理由で repo 側を
「直さない」こと。**

```bash
: > /tmp/empty-npmrc
cd kotoba && npm_config_userconfig=/tmp/empty-npmrc npm install --no-audit --no-fund
# → added 135 packages in 2m
```

⚠ **`npm_config_userconfig=/dev/null` にすると npm は exit 0 のまま何もしない**
（`node_modules` が作られず、ログも空）。それに気づかず `tsc` を走らせると
`Cannot find module '@etzhayyim/sdk'` から 7 件のエラーが出て、**依存が無いだけ
なのにコードが壊れているように見える**。実測でこれを踏んだ。空の**ファイル**を使う。

⚠ **`npm run x | tail` の直後の `$?` は `tail` の終了コードである。** これも実測で
踏んだ —— エラーが 7 行流れているのに `RC=0` と表示された。終了コードを見るときは
パイプを挟まない（`> log 2>&1; echo $?`）。

## 1. 依存を取る

```bash
clojure -P -M:cljs
```

## 2. テスト（ビルド不要、ブラウザ不要）

```bash
K=/Users/junkawasaki/github/com-junkawasaki/orgs/kotoba-lang
CP="src:test:$K/jp-go-digital-design-system/src:$K/html/src:$K/css/src"
cat > /tmp/run-tests.cljs <<'RUNNER'
(require '[cljs.test :refer [run-tests]] 'openpower.route-test)
(run-tests 'openpower.route-test)
RUNNER
npx --yes nbb --classpath "$CP" /tmp/run-tests.cljs
```

実際の出力:

```
Testing openpower.route-test

Ran 7 tests containing 37 assertions.
0 failures, 0 errors.
```

## 3. ページを描いて品質を測る

```bash
K=/Users/junkawasaki/github/com-junkawasaki/orgs/kotoba-lang
cd $K/design-quality && npx --yes nbb -m design-quality.cli score /tmp/page.html --min 95
```

実際の出力:

```
  100.00  /tmp/page.html

aggregate: 100.00

axes scored: 10 (viewport, safe-area, dynamic-viewport, tap-targets, focus-visible,
                 reduced-motion, overflow-guard, color-scheme, responsive, semantics)
NOT scored: input-zoom, contrast — pass --extra-axes to include the optional ones
A pass says nothing about an axis that was not applied.
gate: aggregate 100.00 >= min 95.00 -> PASS
```

`--extra-axes` を付けて 12 軸すべてを適用しても **100.00 / PASS**。

**この 100.00 が保証する範囲は狭い。** CLI 自身が「適用しなかった軸について
pass は何も言わない」と出力している。デザインシステムを 1 つも使わないページでも
96.63 が出て `--min 95` を通ることが別途測られている。だから
`scripts/smoke-worker.cljs` の側で「component を呼んだ」と「stylesheet が実際に
bundle へ入った」を**別々に**検査している（§5）。

## 4. ビルド（必ず resource guard を通す）

ワークスペース全体で高負荷 build は同時 1 本に制限されている。**exit 2 は
「順番待ち」であって失敗ではない**ので、リトライで回す。

```bash
rm -rf .shadow-cljs dist   # :esm の出力が byte 再現するのは cold cache のときだけ
for i in $(seq 1 60); do
  node /Users/junkawasaki/github/com-junkawasaki/scripts/resource-guard.mjs \
    run build -- npx --yes shadow-cljs release worker > /tmp/b.log 2>&1
  rc=$?
  [ $rc -eq 0 ] && { echo "BUILD OK"; tail -1 /tmp/b.log; break; }
  [ $rc -ne 2 ] && { echo "BUILD FAILED rc=$rc"; tail -20 /tmp/b.log; break; }
  sleep 45
done
```

実際の出力:

```
[:worker] Build completed. (55 files, 12 compiled, 0 warnings, 6.10s)
```

**commit `fa84dff` を cold cache でビルドすると** `dist/worker.js` は
**253,758 B**、sha256
`643011e5fea6fec9f2d3ab0161273e1eeea46635a703e9b068f38d72e1e5d4b4`。

**この 2 つの数は commit に紐づく。** `src/` が 1 バイト変われば別の値になる ——
移行時の `246,118 B` / `4458a5a7…` は `agent/relay-headers`（`fa84dff`、
中継ヘッダの転送）が worker.cljs と route.cljc を変えた時点で古くなった。
**HEAD が `fa84dff` でないなら、上の値と比べずに derive し直すこと**
（`shasum -a 256 dist/worker.js`）。ここに書いてあるのは「いま出るはずの値」では
なく「その commit で出た値」である。

そして cold cache でのみ再現する（**incremental だと同じソースでも違うバイト列が
安定して出る**ので、ハッシュを比べるときは必ず `.shadow-cljs` を消してから）。

**「ビルドが通った」は検査ではない。** shadow は未宣言 var を *warning* として扱い
exit 0 のまま壊れた bundle を書き出す。`shadow-cljs.edn` の
`:compiler-options {:warnings-as-errors true}` がそれを exit 1 に変える。
⚠ この key を `:build-options` の下に置くと**黙って無視される** —— shadow が読むのは
`[:compiler-options :warnings-as-errors]` だけである。`scripts/verify-docs-claims.cljs`
は EDN として読んで場所を確かめる（grep では見ない。自分のコメントで緑になるため）。

## 5. ビルド済み bundle を実際に叩く

```bash
npx --yes nbb scripts/smoke-worker.cljs dist/worker.js
```

18 項目すべて PASS。exit は **0 成功 / 1 期待と違う / 2 判定できなかった**
（bundle が無ければ 2 —— 「無かったので合格」にしない）。

## 6. README の数を tree から derive し直す

```bash
npx --yes nbb scripts/verify-docs-claims.cljs .
```

22 claim すべて PASS、exit 0。`<dir>` は**引数の先頭**に置く。

## 7. workerd で動かす（実際のランタイム）

```bash
cd worker && npx --yes wrangler@latest dev --local --port 8799 --ip 127.0.0.1
```

別シェルから実測した結果:

```
GET  /                    -> 200 text/html; charset=utf-8   82,119 B
GET  /health              -> 200 {"ok":true,"app":"open-power","runtime":"cljs",
                                  "routes":["/","/health","/xrpc/:nsid"]}
POST /xrpc/               -> 400 {"error":"Missing XRPC method"}
OPTIONS /xrpc/x           -> 204
GET  /nope                -> 404
POST /health              -> 405
GET  /dodaf               -> 404
POST /xrpc/com.etzhayyim.apps.openPower.listFeeders
                          -> 502 {"error":"MCP router unreachable","url":"https://mcp.etzhayyim.com/…"}
POST /xrpc/a/b            -> 502   （400 ではない）
```

ページ本文の実測: `class="dads-table"` 1 / `--color-primitive-blue` **45** /
`/xrpc/:nsid` 1。

これは **`compatibility_flags` を空にした設定**で走らせた結果である。
`nodejs_compat` は SvelteKit の adapter-cloudflare が要求していたもので、
cljs の `:esm` bundle には要らない —— 憶測で消さず、これを見てから撤去した。

## 8. deploy —— していない

`wrangler deploy` は**実行していない**。`open-power.etzhayyim.com` も
`mcp.etzhayyim.com` も `dig +short` が空を返すので、deploy しても route は
張れないし中継先も無い。deploy するか retire するかは別の決定である。

移行前の `CLAUDE.md` に書かれていた 3 行は、いま 1 行も実行できない:
`cd 60-apps/etzhayyim-project-open-power/worker`（そのパスは無い。この repo 自身が
その directory）/ `wrangler d1 create etzhayyim-open-power`（作れても binding が
無い）/ `e7m actor deploy .`（`e7m` は PATH に無い）。実行できる手順に置き換えた。

## 9. `kotoba/` を検査する（appview ではない。移行の対象外）

```bash
cd kotoba
npm_config_userconfig=/tmp/empty-npmrc npm run typecheck   # → exit 0、エラー 0 件
npm_config_userconfig=/tmp/empty-npmrc npm test            # → Tests 5 passed (5)、exit 0
```
