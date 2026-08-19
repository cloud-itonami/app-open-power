(ns openpower.worker
  "Cloudflare Worker の入口。**この repo で唯一 Request/Response に触る層。**

  ここには判断を置かない——どの handler が答えるかは `openpower.route/dispatch`
  が決め、ページの中身は `openpower.view` が組む。どちらも `.cljc` なので、
  ブラウザもビルドも無しにテストできる。

  worker/wrangler.jsonc の `main` は `../dist/worker.js` を指し、それはこの
  名前空間をコンパイルしたものである。移行前は SvelteKit のビルド出力
  （`svelte/.svelte-kit/cloudflare/_worker.js`——tree にも disk にも無い）を
  指していて、読み手が開く TypeScript はどの bundle にも入っていなかった
  （docs/adr/0001）。

  `aget` を使うのは `:advanced-optimization` 下で env のキーが潰れないため
  （先例 `listingops.edge.worker` と同じ約束）。"
  (:require [openpower.route :as route]
            [openpower.view :as view]
            [shadow.resource :as rc]
            [clojure.string :as str]))

(def ^:private dds-css
  "DADS の CSS はビルド時に bundle へ焼く。外部リクエストゼロが design system の
  方針で、Worker から resource を読む経路も無い。"
  (rc/inline "jp_go_dds/dds.css"))

(defn- ->response [body {:keys [status content-type cache extra]}]
  (js/Response.
   body
   #js {:status status
        :headers (clj->js (merge {"content-type" content-type
                                  "cache-control" (or cache "no-store")}
                                 extra))}))

(defn- json [body status]
  (->response (js/JSON.stringify (clj->js body))
              {:status status :content-type "application/json; charset=utf-8"}))

(defn- env->map
  "env の **キーだけ** を keyword で拾う。値はページにも応答にも出さない
  （中継先だけは例外で、view がそれを明示している）。"
  [env]
  (if env
    (into {} (map (fn [k] [(keyword k) (aget env k)])) (js/Object.keys env))
    {}))

(defn- cors-headers []
  {"access-control-allow-origin" "*"
   "access-control-allow-methods" "POST,OPTIONS"
   "access-control-allow-headers" "content-type,authorization"
   "access-control-max-age" "86400"})

(defn- proxy-xrpc
  "XRPC を MCP router へ中継する。移行前に deploy されていた SvelteKit の route と
  同じ形（jsonrpc の封筒に包み、result/structuredContent を剥がす）。"
  [req env nsid]
  (let [url (route/mcp-router-url (env->map env))]
    (-> (.json req)
        (.catch (fn [_] #js {}))
        (.then
         (fn [input]
           (js/fetch url
                     #js {:method "POST"
                          ;; 受け取った header を渡す。新規に 3 つ作る形だと
                          ;; authorization が黙って消える（route/drop-headers）。
                          :headers (clj->js (route/relay-headers
                                             (map (fn [pair] [(aget pair 0) (aget pair 1)])
                                                  (es6-iterator-seq (.entries (.-headers req))))
                                             nsid))
                          :body (js/JSON.stringify
                                 #js {:jsonrpc "2.0"
                                      :id (.randomUUID js/crypto)
                                      :method "tools/call"
                                      :params #js {:name nsid :arguments input}})})))
        (.then (fn [resp]
                 (-> (.text resp)
                     (.then (fn [text]
                              (let [payload (try (when (seq text) (js/JSON.parse text))
                                                 (catch :default _ text))
                                    clj-payload (js->clj payload :keywordize-keys true)]
                                (if-not (.-ok resp)
                                  (json {:error "MCP router request failed"
                                         :upstream clj-payload}
                                        (.-status resp))
                                  (let [{:keys [ok? value error upstream]} (route/unwrap-mcp clj-payload)]
                                    (if ok?
                                      (json (or value {}) 200)
                                      (json {:error error :upstream upstream} 502))))))))))
        (.catch (fn [e]
                  ;; 到達できなかったことを 200 で隠さない。移行時点で
                  ;; mcp.etzhayyim.com は A レコードを返さないので、これは
                  ;; 想像上の経路ではなく今日の既定の結末である。
                  ;;
                  ;; 移行前の SvelteKit 版はここで **500** を返していた——名前解決の
                  ;; 失敗は fetch が throw するので、502 を返す分岐に入る前に落ちて
                  ;; SvelteKit の汎用 500 になっていた（README §3-B の実測）。
                  ;; catch を置いたので、意図どおり 502 が URL 付きで返る。
                  (json {:error "MCP router unreachable"
                         :detail (str (.-message e))
                         :url url}
                        502))))))

(defn- page-response [env]
  (->response
   (view/render {:css dds-css
                 :routes route/routes
                 :vars (sort (keys (env->map env)))
                 :mcp-url (route/mcp-router-url (env->map env))
                 :built-at nil})
   {:status 200
    :content-type "text/html; charset=utf-8"
    :cache "public, max-age=60"}))

(defn fetch-handler [req env _ctx]
  (let [url (js/URL. (.-url req))
        path (.-pathname url)
        {:keys [action nsid allow reason]} (route/dispatch (.-method req) path)]
    (case action
      :page   (page-response env)
      :health (json {:ok true :app "open-power" :runtime "cljs"
                     :routes (mapv :route/path route/routes)}
                    200)
      :xrpc   (proxy-xrpc req env nsid)
      :cors-preflight (->response nil {:status 204 :content-type "text/plain"
                                       :extra (cors-headers)})
      :bad-request (json {:error reason} 400)
      :method-not-allowed (->response (js/JSON.stringify #js {:error "Method Not Allowed"})
                                      {:status 405
                                       :content-type "application/json; charset=utf-8"
                                       :extra {"allow" allow}})
      (json {:error "Not Found"
             :routes (mapv (fn [r] (str (str/upper-case (name (:route/method r)))
                                        " " (:route/path r)))
                           route/routes)}
            404))))

(def handler #js {:fetch fetch-handler})
