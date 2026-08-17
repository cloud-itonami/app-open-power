# operator quickstart — app-open-power

**この文書に書いてある手順は、2026-08-18 に上から下まで実際に実行したものだけである。**
実行できなかったものは §5 に「実行できない」として分けてある（手順として書かない）。

前提の実測環境: macOS（Darwin 25.3.0） / node v26.3.0 / npm 11.16.0 /
wrangler 4.69.0（Homebrew、repo の依存ではない）。

---

## 0. 先に読む —— このマシンでは `npm install` が落ちる（repo の欠陥ではない）

```
$ cd kotoba && npm install
npm error git dep preparation failed
npm error   code EALLOWSCRIPTS
npm error   --allow-scripts is not allowed in project-scoped installs.
```

原因は `~/.npmrc` の

```
allow-scripts[]=@anthropic-ai/claude-code
```

で、これが git 依存（`@etzhayyim/sdk` は `git+https://…`）の準備 install に
継承され、npm 11.16.0 がそれを拒否する。**`--ignore-scripts` を足しても直らない**
（実測）。空の user config で隔離すると通る:

```bash
printf '' > /tmp/empty-npmrc
export npm_config_userconfig=/tmp/empty-npmrc      # 以降の npm 全部に効かせる
```

**この回避策は環境の問題への対処であって、repo を直す理由ではない。** 素の
`~/.npmrc` を持つ CI / 別マシンでは 0 節ごと飛ばしてよい。

なお隔離した install は git 依存の `prepare: tsc` を実行しない旨を警告するが、
**下の typecheck とテストはそれで通る**（実測）。

---

## 1. `kotoba/` を動かす（唯一テストが在る面）

```bash
export npm_config_userconfig=/tmp/empty-npmrc      # §0。素の環境では不要
cd kotoba
npm install
npm run typecheck
npm test
```

実測した出力:

| コマンド | exit | 出力 |
|---|---|---|
| `npm install` | 0 | `added 135 packages, and audited 136 packages in 2m` / `found 0 vulnerabilities`（+ allow-scripts の警告 8 件） |
| `npm run typecheck` | **0** | `tsc --noEmit` がエラーなし |
| `npm test` | **0** | `Test Files 1 passed (1)` / `Tests 5 passed (5)` / 約 300ms |

### 1.1 テストが本当に何かを掴んでいることを自分で確かめる

**緑を見るだけでは足りない。** 次のどれか 1 つを壊すと、対応する 1 ケースだけが
落ちる（3 件とも実測済み。確認したら `git checkout -- <file>` で戻す）:

| 壊す | 落ちるテスト | 出るメッセージ |
|---|---|---|
| `src/types.ts` の `OUTAGE_CAUSES` から `"vegetation",` の行を消す | `filters outages + coverage rolls up active` | `expected 1 to be 2` |
| `src/registry.ts` の `defineFeeder` から `substationNotFound` を返す 3 行を消す | `defines against existing substation; rejects missing` | `expected 'defined' to be 'substationNotFound'` |
| `src/registry.ts` の `listFeeders` から `if (input.status && …) return false;` を消す | `lists by substation + status` | `expected 2 to be 1` |

いずれも `1 failed | 4 passed (5)`。**復元後に `git diff --exit-code` が exit 0 に
なることまで確かめる**（戻し損ねた変更を「テストが緑だから無害」と読まないため）。

---

## 2. デプロイされる Worker をビルドする

**`worker/src/app.ts` はビルド対象ではない。** `wrangler.jsonc` の `main` は
`svelte/.svelte-kit/cloudflare/_worker.js` を指しており、それを作るのは
`worker/svelte/` の SvelteKit ビルドである。

```bash
export npm_config_userconfig=/tmp/empty-npmrc      # §0。素の環境では不要
cd worker/svelte
npm install
node <superproject>/scripts/resource-guard.mjs run build -- npm run build
npm run check
```

3 行目の `resource-guard` は superproject の規約（高負荷ビルドは同時 1 本）。
単体の repo として触るなら `npm run build` を直接でよい。

実測した出力:

| コマンド | exit | 出力 |
|---|---|---|
| `npm install` | 0 | `added 93 packages, and audited 94 packages in 8s`（+ esbuild / workerd の postinstall 警告 2 件） |
| `npm run build` | **0** | `✓ built in 4.37s` → `Using @sveltejs/adapter-cloudflare ✔ done`（clean-room 再走時。初回は 3.07s） |
| `npm run check` | **0** | `163 FILES 0 ERRORS 0 WARNINGS` |

生成物（`wrangler.jsonc` が指す先）:

```
worker/svelte/.svelte-kit/cloudflare/_worker.js      4,335 B
worker/svelte/.svelte-kit/cloudflare/client/
```

---

## 3. ローカルで起動して、実際に何が返るかを見る

```bash
cd worker
wrangler dev --port 8799 --local
```

`[wrangler:info] Ready on http://localhost:8799` が出たら、別の端末から:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8799/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8799/health
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  http://localhost:8799/xrpc/com.etzhayyim.apps.openPower.listFeeders
```

**実測した応答（これが期待値である —— 200 が返ると思ってはいけない）:**

| リクエスト | 実測 | なぜ |
|---|---|---|
| `GET /` | **200** | 雛形ページ（`<title>worker</title>`） |
| `GET /health` | **404** | `/health` は未デプロイの `src/app.ts` にしか無い（README §3-A） |
| `POST /xrpc/…listFeeders` | **500** `{"message":"Internal Error"}` | 転送先 `mcp.etzhayyim.com` が解決しない。`fetch` が投げるので、意図された 502 の分岐に入らない（README §3-B） |

起動時に `EMFILE: too many open files, watch` が大量に出ることがある。これは
このマシンで並行セッションが多いときのファイル監視の枯渇で、**Worker 自体は
起動する**（上の 3 応答はその状態で取った）。

`--local` を付けずに `wrangler dev` を実行すると Cloudflare の認証を求められ、
`wrangler.jsonc` の `account_id` / `routes`（`open-power.etzhayyim.com/*`）に
触りにいく。**ローカルで挙動を見るだけなら `--local` を付ける。**

終了は `Ctrl-C`（プロセスを残すと port 8799 を掴んだままになる）。

---

## 4. 参照先が生きているかを測る

```bash
for h in open-power.etzhayyim.com mcp.etzhayyim.com etzhayyim.com; do
  printf '%-28s dns=[%s]\n' "$h" "$(dig +short $h | tr '\n' ' ')"
done
```

実測（2026-08-18）:

| ホスト | DNS | `GET /` |
|---|---|---|
| `open-power.etzhayyim.com` | **解決しない** | — |
| `mcp.etzhayyim.com` | **解決しない** | — |
| `etzhayyim.com`（対照） | `104.21.51.111` / `172.67.179.128` | **200** |

対照の apex が 200 を返すので、**これは測定側（DNS / ネットワーク）の問題ではない**。

---

## 5. 実行できないもの（手順として書けないので、ここに分けてある）

| やりたいこと | 現状 | 根拠 |
|---|---|---|
| `worker/src/app.ts` を型検査・ビルドする | **できない** | `worker/` に `package.json` も `tsconfig.json` も無い |
| `app.ts` の 8 XRPC を叩く | **できない** | どこからもビルド・デプロイされない |
| D1 を用意して `app.ts` を動かす | **できない** | `wrangler.jsonc` に `d1_databases` binding が無い（`POWER_DB` は 19 箇所で使われる） |
| `CLAUDE.md` の `Local Dev / Deploy` | **できない** | パスが無い / `e7m` が PATH に無い（README §3-E） |
| `defence-handlers.ts` を動かす | **できない** | どこからも import されず、依存 `@etzhayyim/kotodama-host-sdk` がどの `package.json` にも無い |
| BPMN / DMN を実行する | **できない** | この repo に engine は無い。DMN の内容は `app.ts:118-122` に手で写されている（一致を確認済み、README §1） |

---

## 6. 本番へ deploy するとき

**この repo だけでは deploy しない。** 少なくとも次の 2 つが未解決である:

1. `open-power.etzhayyim.com` の DNS レコード（`routes` が張れない）
2. 転送先 `mcp.etzhayyim.com`（無ければ全 XRPC が 500）

superproject の規約として、deploy は `origin/main` を包含した checkout からのみ
行う（`git fetch origin && git merge --ff-only origin/main` を先に通す。
PreToolUse hook `wrangler-deploy-main-sync-guard` が強制する）。
