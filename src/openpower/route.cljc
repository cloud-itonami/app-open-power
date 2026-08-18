(ns openpower.route
  "どの handler が要求に答えるか——データとして持ち、純関数で決める。

  `.cljs` ではなく `.cljc` なのは意図である。edge worker のうちテストする価値が
  あるのは経路の判断で、ここならブラウザもビルドもネットワークも無しに測れる。
  `openpower.worker` がこの repo で唯一 Request/Response に触る層で、そこは
  このファイルが既に決めたこと以外を何もしない。

  ingress capability が qualify した時（今日は :native-aot / :wasm-aot とも
  pending——ADR-2606290000）、最初に `.kotoba` へ移るのもこのファイルである。
  route 表はスカラと文字列の上の判断で、それはその移行を生き延びる形である。"
  (:require [clojure.string :as str]))

(def routes
  "公開されている面を、データとして持つ。ランディングページは **この値** を描く。
  だから『在る route』と『ページが宣伝する route』が食い違えない——docs/adr/0001
  が記録した欠陥は、route 2 本を宣言する wrangler.jsonc の隣でページが
  `Routes 0` と表示していたことだった。"
  [{:route/path "/"           :route/method :get  :route/kind :page
    :route/doc "この appview の説明ページ"}
   {:route/path "/health"     :route/method :get  :route/kind :json
    :route/doc "生存確認。deploy された面が答えることを外から確かめられる"}
   {:route/path "/xrpc/:nsid" :route/method :post :route/kind :proxy
    :route/doc "XRPC を MCP router へ中継する（この Worker は解釈しない）"}])

(defn- xrpc-nsid
  "`/xrpc/<nsid>` の nsid。**空文字だけが nil**。

  多段パス（`/xrpc/a/b`）もそのまま通す。移行前に deploy されていた SvelteKit の
  route は rest parameter `[...path]` で受けており、`a/b` をそのまま tool 名として
  転送していた。ここで 1 セグメントに絞ると挙動が変わる——NSID に `/` は現れない
  ので上流で失敗するだけだが、**それは移行ではなく方針変更**であり、移行の commit に
  紛れ込ませるべきものではない。絞るなら別の決定として記録する。"
  [path]
  (when (str/starts-with? path "/xrpc/")
    (let [rest' (subs path (count "/xrpc/"))]
      (when (seq rest') rest'))))

(defn dispatch
  "method + path → 何をするか。Request も Response も知らない。

  返すのは `{:action …}` で、`:action` は
  `:page` / `:health` / `:xrpc` / `:cors-preflight` / `:not-found` /
  `:method-not-allowed` / `:bad-request` のいずれか。"
  [method path]
  (let [m (keyword (str/lower-case (or method "get")))
        p (or path "")]
    (cond
      (and (= m :options) (str/starts-with? p "/xrpc/"))
      {:action :cors-preflight}

      (str/starts-with? p "/xrpc/")
      (if (= m :post)
        (if-let [nsid (xrpc-nsid p)]
          {:action :xrpc :nsid nsid}
          {:action :bad-request :reason "Missing XRPC method"})
        {:action :method-not-allowed :allow "POST, OPTIONS"})

      (= p "/health") (if (= m :get)
                        {:action :health}
                        {:action :method-not-allowed :allow "GET"})
      (= p "/")       (if (= m :get)
                        {:action :page}
                        {:action :method-not-allowed :allow "GET"})
      :else {:action :not-found})))

(defn mcp-router-url
  "env の設定 → MCP router の URL。末尾スラッシュは落とす。

  既定値をここに焼くのは、設定が無いときに黙ってどこかへ POST しないためでは
  なく、**どこへ行くのかを 1 箇所で読めるようにする**ため。移行前の
  `+server.ts` が持っていた既定値と同じ値である。"
  [{:keys [AGENTGATEWAY_MCP_ROUTER_URL MCP_ROUTER_URL]}]
  (let [pick (fn [s] (when (and (string? s) (seq (str/trim s))) (str/trim s)))]
    (-> (or (pick AGENTGATEWAY_MCP_ROUTER_URL)
            (pick MCP_ROUTER_URL)
            "https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message")
        (str/replace #"/+$" ""))))

(defn unwrap-mcp
  "MCP router の応答から、呼び手に返す値を取り出す。

  `{:result {:structuredContent X}}` → X、`{:result X}` → X、それ以外は素通し。
  `{:error …}` は呼び出し側が 502 にするので、ここでは判定だけ返す。移行前の
  `+server.ts` と同じ剥がし方である。"
  [payload]
  (cond
    (and (map? payload) (contains? payload :error))
    {:ok? false :error (get-in payload [:error :message] "MCP router returned an error")
     :upstream payload}

    (and (map? payload) (contains? payload :result))
    (let [r (:result payload)]
      {:ok? true :value (if (and (map? r) (contains? r :structuredContent))
                          (:structuredContent r)
                          r)})

    :else {:ok? true :value payload}))
