#!/usr/bin/env nbb
;; verify-docs-claims — README.md と docs/operator-quickstart.md が述べる数を
;; tree から derive し直し、prose と tree が食い違ったら落ちる。
;;
;; 移行前、この repo の load-bearing な主張は GAP だった: deploy される Worker は
;; SvelteKit のビルド出力で、application に読める worker/src/app.ts はどの bundle
;; にも入っていなかった。その gap は閉じたので、claim は **閉じたこと** を主張する。
;; そして黙って戻らないように書く —— appview の TypeScript は「バイト合計から
;; 消えた」ではなく **名指しで不在** を主張する。
;;
;; ⚠ この repo は reference（cloud-itonami/app-ongakuka）と 1 点だけ形が違う。
;; `kotoba/` は appview ではない TypeScript（AT PDS 上のレジストリ、独立した
;; package.json、実際に通る 5 つの test）で、どの bundle にも入らず、移行が
;; 置き換えるものが 1 つも参照していない。だから **消していない**。
;; したがって `production-ts-files 0` は主張できない —— 代わりに
;;   (a) appview の TypeScript が 0 であること（kotoba/ の外に .ts が無い）
;;   (b) kotoba/ が黙って育っていないこと（ファイル数と .ts 数を pin）
;; の 2 つに分ける。1 つ目だけだと kotoba/ に appview を書き戻せてしまい、
;; 2 つ目だけだと appview の TypeScript の復活を見逃す。
;;
;; Usage:  nbb scripts/verify-docs-claims.cljs [<dir>]     (<dir> を **先頭** に)
;; Exit:   0 全 claim 成立 · 1 claim が偽 · 2 答えられなかった

(require '["node:fs" :as fs]
         '["node:child_process" :as cp]
         '["node:crypto" :as crypto]
         '[clojure.string :as str])

(def root (or (first (remove #(str/starts-with? % "--") *command-line-args*)) "."))

(def claims
  {:tracked-files 35
   :inherited-bytes 18535          ; 手を触れていない 12 ファイルの合計
   :svelte-artifacts 0             ; .svelte / svelte.config / svelte/ が 1 つも無い
   :sveltekit-compat-flags 0       ; nodejs_compat は adapter-cloudflare のものだった
   :appview-ts-files 0             ; kotoba/ の外に .ts は 1 本も無い
   :kotoba-files 7                 ; 移行の対象外。黙って育たないよう pin する
   :kotoba-ts-files 5
   :production-canonical-files 4   ; route.cljc / view.cljc / worker.cljs / route_test.cljc
   :declared-vars 4
   :declared-routes 1
   :wrangler-main "../dist/worker.js"
   :shadow-output-dir "dist"
   :shadow-export "openpower.worker/handler"})

;; 移行で 1 バイトも触っていないファイル。wrangler.jsonc / CLAUDE.md / README.md /
;; docs/operator-quickstart.md / dodaf/SV-1.json / dodaf/OV-6a.json は **意図して**
;; 変えたのでこの集合に無く、下で内容として検査する。意図した変更と勝手な変更を
;; 区別するためである。
(def preserved
  {"README.edn" "b61322bb06ad230eca30ba7f6d51b69bb847c5425276d1747cf9ba2dcdf6f3e0"
   "migration.edn" "5fc77ceb44fa9b36079b156a1bd556dc264020e8ad2b2de3891f1dc1dad62720"
   "worker/kotodama.jsonld" "79b8ae7eb1e7ef938d3ff66538be74c6132e53491d6fe07e0b93833ba27e1b5a"
   "bpmn/define-feeder.bpmn" "292b4e6b2edc5fca62a8d738c197c9cdb849c2f5a3b7ad28fe3e28ceef0cb212"
   "bpmn/report-outage.bpmn" "c658e896a174a622fb94dd6ae4fa336e7067e051482ffebf443f389cb0a47cc6"
   "dmn/outage-class.dmn" "1ee4acc3147f8110f24edccf4d514de99332e2dddb687cfb77d9290892687a00"
   "forms/defineFeeder.form.json" "53c58965ca2816a157606f0a7f3fc8f05e07a1f63a75e23fc6e97f55f0f00332"
   "forms/reportOutage.form.json" "9a59553103c7bb2bef3430cf458dcfb0c9819fd831bd81c88a3e4ca5d562fa18"
   "dodaf/AV-1.json" "8ede25013de6e7c9ecc34dc4bc3d5ef8fdd3ff5b9e5ce2599fb66e28dc8a053f"
   "dodaf/CV-2.json" "6034be02f0f5bf23a4e41af95714380bf99360cab09024f3eca2f2e24f0163b6"
   "dodaf/OV-1.json" "087bd381bb05993d8058c2da099dded9ceddaf2aaffa02ed2df6a4bd85a17fde"
   "dodaf/OV-5b.json" "03f153a19880a28b60309e53bda55d5250ec9da09d9f660ce4f59189d26b6a4d"})

;; 移行が **撤去した** もの、名指しで。バイト合計は「TypeScript が消えた」と
;; 言えないが、これは言える。戻ってきたら落ちる。
(def removed-by-migration
  ["worker/src/app.ts"
   "worker/src/defence-handlers.ts"
   "worker/src/dodaf-bootstrap.ts"
   "worker/svelte/package.json"
   "worker/svelte/src/app.html"
   "worker/svelte/src/routes/+page.svelte"
   "worker/svelte/src/routes/xrpc/[...path]/+server.ts"
   "worker/svelte/svelte.config.js"
   "worker/svelte/tsconfig.json"
   "worker/svelte/vite.config.ts"])

(def undetermined (atom []))
(def failures (atom []))
(defn undet! [m] (swap! undetermined conj m))

(defn tracked-files []
  (try (->> (.execSync cp "git ls-files" #js {:cwd root :encoding "utf8"})
            str/split-lines (remove str/blank?) vec)
       (catch :default e (undet! (str "git ls-files failed: " (.-message e))) nil)))
(defn slurp* [rel] (try (.readFileSync fs (str root "/" rel) "utf8") (catch :default _ nil)))
(defn bytes-of [rel] (try (.-size (.statSync fs (str root "/" rel))) (catch :default _ nil)))
(defn sha256 [rel]
  (try (-> (.createHash crypto "sha256") (.update (.readFileSync fs (str root "/" rel))) (.digest "hex"))
       (catch :default _ nil)))
(defn strip-jsonc [s] (str/replace s #"(?m)^\s*//.*$" ""))

(def claims-run (atom 0))

(defn check! [label expected actual]
  (swap! claims-run inc)
  (let [ok (= expected actual)]
    (println (str (if ok "PASS" "FAIL") "\t" (name label)
                  "\texpected=" (pr-str expected) "\tactual=" (pr-str actual)))
    (when-not ok (swap! failures conj label))
    ok))

(let [files (tracked-files)]
  (when (nil? files) (println "UNDETERMINED\tcould not list tracked files") (js/process.exit 2))
  ;; evidence floor: 0 件を clean と読ませない
  (println (str "SCANNED\t" (count files)))
  (when (zero? (count files)) (println "UNDETERMINED\tscanned 0 files") (js/process.exit 2))

  (let [sizes (into {} (map (juxt identity bytes-of)) files)]
    (when-let [bad (seq (keep (fn [[f s]] (when (nil? s) f)) sizes))]
      (undet! (str "tracked but unreadable: " (str/join ", " bad))))

    (check! :tracked-files (:tracked-files claims) (count files))
    (check! :inherited-bytes (:inherited-bytes claims)
            (reduce + 0 (keep #(get sizes %) (keys preserved))))
    (check! :preserved-files-unchanged []
            (vec (keep (fn [[f want]] (let [got (sha256 f)]
                                        (when-not (= want got) (str f " " (or got "MISSING")))))
                       preserved)))

    ;; appview の TypeScript は名指しで不在
    (check! :removed-by-migration-absent []
            (vec (filter #(some? (bytes-of %)) removed-by-migration)))

    ;; Svelte は消えて、戻ってこない。撤去リストは 10 の名前を指すが、こちらは
    ;; **どんな名前でも** 戻りを捕まえる —— 新しい .svelte、svelte.config、
    ;; svelte/ ディレクトリ、そして adapter-cloudflare だけが要求していた compat flag。
    (check! :svelte-artifacts (:svelte-artifacts claims)
            (count (filter #(or (str/ends-with? % ".svelte")
                                (str/includes? % "svelte.config")
                                (str/includes? % "/svelte/"))
                           files)))

    ;; CLAUDE.md はもう TypeScript ランタイムを名乗らない
    (let [c (slurp* "CLAUDE.md")]
      (if (nil? c)
        (undet! "CLAUDE.md unreadable")
        (check! :claude-md-describes-cljs true
                (and (not (str/includes? c "Single CF Worker (`src/app.ts`)"))
                     (str/includes? c "shadow-cljs")
                     (str/includes? c "src/openpower/worker.cljs")))))

    ;; production の言語。kotoba/ は移行の対象外なので別々に数える（冒頭の注記）。
    (let [prod (remove #(str/starts-with? % "scripts/") files)
          kotoba (filter #(str/starts-with? % "kotoba/") files)]
      (check! :appview-ts-files (:appview-ts-files claims)
              (count (filter #(and (str/ends-with? % ".ts")
                                   (not (str/starts-with? % "kotoba/")))
                             files)))
      (check! :kotoba-files (:kotoba-files claims) (count kotoba))
      (check! :kotoba-ts-files (:kotoba-ts-files claims)
              (count (filter #(str/ends-with? % ".ts") kotoba)))
      (check! :production-canonical-files (:production-canonical-files claims)
              (count (filter #(re-find #"\.(cljs|cljc|clj|kotoba)$" %) prod))))

    ;; deploy される bundle は、この tree のソースからビルドされる
    (let [w (some-> (slurp* "worker/wrangler.jsonc") strip-jsonc)
          sh (slurp* "shadow-cljs.edn")]
      (if (or (nil? w) (nil? sh))
        (undet! "worker/wrangler.jsonc or shadow-cljs.edn unreadable")
        (let [j (js->clj (.parse js/JSON w) :keywordize-keys false)]
          (check! :wrangler-main (:wrangler-main claims) (get j "main"))
          (check! :declared-vars (:declared-vars claims) (count (get j "vars")))
          (check! :declared-routes (:declared-routes claims) (count (get j "routes")))
          ;; 旧設定は もう存在しない SvelteKit の client dir を assets として配っていた
          (check! :no-stale-assets-binding true (nil? (get j "assets")))
          (check! :sveltekit-compat-flags (:sveltekit-compat-flags claims)
                  (count (filter #{"nodejs_compat" "nodejs_als"}
                                 (or (get j "compatibility_flags") []))))
          (check! :shadow-builds-that-main true
                  (and (str/includes? sh (str ":output-dir \"" (:shadow-output-dir claims) "\""))
                       (str/includes? sh (:shadow-export claims))
                       (str/includes? (get j "main") (str (:shadow-output-dir claims) "/worker.js")))))))

    ;; :warnings-as-errors が **:compiler-options の下に** 在ること。grep では
    ;; 見ない —— このファイル自身のコメントがその文字列を含むので、grep する検査は
    ;; 自分のコメントで緑になる。EDN として読んで場所を確かめる。
    (let [sh (slurp* "shadow-cljs.edn")]
      (if (nil? sh)
        (undet! "shadow-cljs.edn unreadable")
        (let [cfg (try (cljs.reader/read-string sh) (catch :default e (undet! (str "shadow-cljs.edn unreadable as EDN: " (.-message e))) nil))]
          (when cfg
            (check! :warnings-as-errors-in-compiler-options true
                    (true? (get-in cfg [:builds :worker :compiler-options :warnings-as-errors])))
            (check! :warnings-as-errors-not-misplaced true
                    (nil? (get-in cfg [:builds :worker :build-options :warnings-as-errors])))))))

    ;; ページは route の **表** を描く。焼いた数ではない —— docs/adr/0001 が記録した
    ;; 欠陥は wrangler が route を宣言する隣で literal の `"routeCount": 0` だった。
    ;; 構造で主張し、部分文字列の禁止ではやらない: 最初の版は "routeCount" をどこにも
    ;; 許さない検査で、旧欠陥を説明する docstring に引っかかった。コメントで落とせる
    ;; 検査は、コードではなく散文についての検査である。
    (let [v (slurp* "src/openpower/view.cljc")
          w (slurp* "src/openpower/worker.cljs")]
      (if (or (nil? v) (nil? w))
        (undet! "view.cljc or worker.cljs unreadable")
        (check! :page-renders-route-table true
                (and (str/includes? v "[{:keys [routes vars mcp-url built-at]}]")
                     (str/includes? v "(route-rows routes)")
                     (str/includes? w ":routes route/routes")))))

    ;; ADR は EDN tx-data として読める
    (let [adr "docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn"
          s (slurp* adr)]
      (if (nil? s)
        (undet! (str adr " unreadable"))
        (check! :adr-reads-as-edn true
                (try (let [d (cljs.reader/read-string s)]
                       (and (vector? d) (map? (first d))
                            (= "accepted" (:adr/status (first d)))))
                     (catch :default _ false)))))

    ;; ── ここから下は「散文の中の数」を tree から derive する ────────────────
    ;;
    ;; テストの本数は quickstart と ADR が引用しているが、**それを derive する
    ;; ものが無かった**ので黙って古くなった。実測 2026-08-19: `agent/relay-headers`
    ;; （`fa84dff`、中継ヘッダの転送）が test を 1 本足し、両文書は `6 tests` と
    ;; 書いたまま、suite は 7 本走っていた。deftest の数は tree から数えられるので
    ;; pin する。
    ;;
    ;; **assertion の数は claim にしない。** ここからは derive できない ——
    ;; `testing` に入れ子になった `is` や複数行の form があるので grep と runner が
    ;; 食い違う（実測 2026-08-19、この repo では grep 35 に対し runner 37）。
    ;; 自信を持って間違える検査は、無い検査より悪い。あの数を検査するのは suite 自身。
    (let [t (slurp* "test/openpower/route_test.cljc")
          docs ["README.md"
                "docs/operator-quickstart.md"
                "docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn"]
          unreadable (vec (remove #(some? (slurp* %)) (cons "test/openpower/route_test.cljc" docs)))]
      (if (seq unreadable)
        (undet! (str "unreadable: " (str/join ", " unreadable)))
        (let [n (count (re-seq #"(?m)^\(deftest\s" t))]
          (check! :declared-tests []
                  (vec (for [d docs
                             m (re-seq #"(\d+)\s*tests" (slurp* d))
                             :let [q (js/parseInt (second m))]
                             :when (not= q n)]
                         (str d " says " q " tests, the file declares " n)))))))

    ;; この script が検査する claim の数もまた、文書が引用している数である。
    ;; 誰も derive していなかったので、同型のずれが起こりうる（sibling の
    ;; app-open-airplane では実際に ADR が 21、script が 23 でずれていた）。
    ;; だから claim 数は自分自身を数える。合計は **この検査自身を含む**ので
    ;; (inc @claims-run) —— claim を足して文書を直さなければ、ここが赤くなる。
    (let [docs ["README.md"
                "docs/operator-quickstart.md"
                "docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn"]
          total (inc @claims-run)
          unreadable (vec (remove #(some? (slurp* %)) docs))]
      (if (seq unreadable)
        (undet! (str "doc unreadable: " (str/join ", " unreadable)))
        (check! :documented-claim-count []
                (vec (for [d docs
                           m (re-seq #"\*{0,2}(\d+)\*{0,2}\s*claim" (slurp* d))
                           :let [n (js/parseInt (second m))]
                           :when (not= n total)]
                       (str d " says " n ", script runs " total))))))))

(let [u @undetermined f @failures]
  (when (seq u)
    (doseq [m u] (println (str "UNDETERMINED\t" m)))
    (println "Refusing to report a pass: the tree could not be read completely.")
    (js/process.exit 2))
  (if (seq f)
    (do (println (str "FAILED\t" (count f) " claim(s): " (str/join ", " (map name f)))) (js/process.exit 1))
    (do (println "OK\tevery claim in README.md and docs/operator-quickstart.md holds") (js/process.exit 0))))
