(ns openpower.route-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [openpower.route :as route]
            [openpower.view :as view]))

(deftest dispatch-page-and-health
  (is (= :page (:action (route/dispatch "GET" "/"))))
  (is (= :health (:action (route/dispatch "GET" "/health"))))
  (is (= :method-not-allowed (:action (route/dispatch "POST" "/health"))))
  (is (= :method-not-allowed (:action (route/dispatch "POST" "/"))))
  (is (= :not-found (:action (route/dispatch "GET" "/nope"))))
  (testing "移行前に deploy されていなかった経路は 404 のまま。移植していない"
    (is (= :not-found (:action (route/dispatch "GET" "/dodaf"))))
    (is (= :not-found (:action (route/dispatch "GET" "/forms"))))
    (is (= :not-found (:action (route/dispatch "GET" "/_app/meta"))))))

(deftest dispatch-xrpc
  (testing "nsid を 1 セグメントとして受ける"
    (is (= {:action :xrpc :nsid "com.etzhayyim.apps.openPower.listFeeders"}
           (route/dispatch "POST" "/xrpc/com.etzhayyim.apps.openPower.listFeeders"))))
  (testing "空だけが 400。多段は移行前（rest parameter [...path]）と同じく転送する"
    (is (= :bad-request (:action (route/dispatch "POST" "/xrpc/"))))
    (is (= {:action :xrpc :nsid "a/b"} (route/dispatch "POST" "/xrpc/a/b"))))
  (testing "preflight と method"
    (is (= :cors-preflight (:action (route/dispatch "OPTIONS" "/xrpc/x"))))
    (is (= :method-not-allowed (:action (route/dispatch "GET" "/xrpc/x"))))))

(deftest mcp-url-resolution
  (is (= "https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message"
         (route/mcp-router-url {})))
  (is (= "https://a.example/x"
         (route/mcp-router-url {:AGENTGATEWAY_MCP_ROUTER_URL "https://a.example/x/"})))
  (testing "空白だけの設定は未設定として扱う"
    (is (= "https://b.example"
           (route/mcp-router-url {:AGENTGATEWAY_MCP_ROUTER_URL "   "
                                  :MCP_ROUTER_URL "https://b.example"})))))

(deftest unwrap
  (is (= {:ok? true :value {:a 1}} (route/unwrap-mcp {:result {:structuredContent {:a 1}}})))
  (is (= {:ok? true :value {:a 1}} (route/unwrap-mcp {:result {:a 1}})))
  (is (false? (:ok? (route/unwrap-mcp {:error {:message "boom"}})))))

(deftest page-shows-the-real-routes
  (testing "ページは route 表から描く。0 を焼かない（docs/adr/0001 の欠陥）"
    (let [html (view/render {:css "/*x*/" :routes route/routes
                             :vars [:APP_HANDLE :PRIMARY_DID]
                             :mcp-url "https://mcp.example/x"})]
      (doseq [r route/routes]
        (is (str/includes? html (:route/path r))
            (str (:route/path r) " がページに出ていない")))
      (is (str/includes? html "APP_HANDLE"))
      (is (str/includes? html "https://mcp.example/x"))
      (testing "移行前の雛形の文言と定数は 1 つも残っていない"
        (is (not (str/includes? html "No public route is declared")))
        (is (not (str/includes? html "No public vars are declared")))
        (is (not (str/includes? html "60-apps/")))))))

(deftest page-renders-what-it-is-handed
  (testing "route 表を差し替えると、ページの表示もそれに従う（値を焼いていない証拠）"
    (let [html (view/render {:css "/*x*/"
                             :routes [{:route/path "/only-this"
                                       :route/method :get
                                       :route/kind :page
                                       :route/doc "差し替えた表"}]
                             :vars [] :mcp-url "https://mcp.example/x"})]
      (is (str/includes? html "/only-this"))
      (is (not (str/includes? html "/xrpc/:nsid"))))))

(deftest relay-headers-forwards-what-it-received
  (testing "移行前は host を削るだけで、authorization も上流へ届いていた"
    (let [h (route/relay-headers [["Host" "x.example"]
                                  ["Authorization" "Bearer t"]
                                  ["Content-Length" "9"]
                                  ["Content-Encoding" "gzip"]
                                  ["X-Trace" "abc"]]
                                 "com.a.b")]
      (is (= "Bearer t" (get h "authorization"))
          "authorization が落ちている —— preflight はこれを許可すると言っている")
      (is (= "abc" (get h "x-trace"))
          "呼び手が付けた header が落ちている")
      (is (nil? (get h "host")) "host は宛先が変わるので渡さない")
      (is (nil? (get h "content-length")) "body を詰め直すので元の長さは嘘になる")
      (is (nil? (get h "content-encoding")) "body を詰め直すので元の encoding も嘘になる")
      (is (= "application/json" (get h "content-type")))
      (is (= "com.a.b" (get h "x-etzhayyim-xrpc-method")))
      (is (= "cljs-worker" (get h "x-etzhayyim-bff"))))))
