(ns openpower.view
  "この appview の説明ページ。純 hiccup。

  基盤は `jp-go-dds`（デジタル庁デザインシステム）——superproject の skill
  `kotoba-uiux` が定める新規 UI の base。色・寸法は `--hig-*` トークン契約で
  書き、raw hex も px フォントサイズも置かない。

  **表示する事実は引数で受け取る。ページの中に焼かない。**
  これは装飾の都合ではなく、docs/adr/0001 が記録した欠陥そのものへの答えで
  ある——移行前の `+page.svelte` は `\"routeCount\": 0` / `\"routes\": []` /
  `\"vars\": []` を literal で持っていて、隣の wrangler.jsonc が route 1・var 4 を
  宣言していることに気づけなかった。さらに `relativePath` は切り出し前の
  `60-apps/…` を指したままで、ページの `<title>` は `worker` だった。
  ここでは route 表と設定を渡す側が持ち、ページは描くだけなので、両者がずれる
  余地が無い。"
  (:require [jp-go-dds.core :as dds]
            [jp-go-dds.page :as page]
            [jp-go-dds.tokens :as tokens]
            [clojure.string :as str]))

(def app-css
  "app 固有の最小 CSS。`--hig-*` 契約だけを使う（bridge が DADS の上に再定義する）。
  DADS を base にした app の下には `shitsuke.hig` が居ないので、bridge が運んで
  いないトークンは何にも解決しない——使うのは運ばれている中だけ。"
  (str/join
   "\n"
   [".op-lede { color: var(--hig-color-secondary-label); max-width: 42rem; }"
    ".op-note { color: var(--hig-color-secondary-label); font-size: var(--hig-text-footnote-font-size); }"
    ".op-mono { font-family: var(--hig-font-mono); }"]))

(defn- route-rows [routes]
  (mapv (fn [r]
          [(str/upper-case (name (:route/method r)))
           [:span {:class "op-mono"} (:route/path r)]
           (:route/doc r)])
        routes))

(defn body
  "opts:
   :routes    openpower.route/routes（この Worker が実際に答えるもの）
   :vars      wrangler が渡した env のキー（**キー名だけ**。値は出さない）
   :mcp-url   XRPC の中継先（route/mcp-router-url の戻り値。**これは値そのもの**）
   :built-at  bundle のビルド時刻（不明なら nil）"
  [{:keys [routes vars mcp-url built-at]}]
  (dds/container
   (dds/section
    {}
    (dds/heading 1 "Open Power — 配電網の設計と運用")
    [:p {:class "op-lede"}
     "変電所・フィーダの設計と、検針・停電の運用を扱う appview の公開面。"
     "配電の判断そのものはここには無い——この Worker は XRPC を MCP router へ"
     "中継するだけである。"])

   (dds/section
    {:title "この面が答えるもの"}
    (dds/table {:caption "公開ルート"
                :headers ["METHOD" "PATH" "何をするか"]
                :rows (route-rows routes)})
    [:p {:class "op-note"}
     "この表は Worker の route 表そのものから描いている。ページに焼いた値では"
     "ないので、実際に答えるものと表示がずれない。"])

   (dds/section
    {:title "実行時の設定"}
    (if (seq vars)
      [:div (into [:p] (interpose " "
                                  (map (fn [k] (dds/chip-label (name k))) vars)))
       [:p {:class "op-note"}
        "キー名のみ。**ただし下の中継先だけは値そのもの**（"
        [:span {:class "op-mono"} "AGENTGATEWAY_MCP_ROUTER_URL"]
        "）——どこへ中継するかは運用者が見る必要があるので意図的に出している。"
        "それ以外の値は出さない。"]]
      [:p {:class "op-note"} "env が渡されていない（ローカル描画）。"])
    [:p {:class "op-note"} "XRPC の中継先: "
     [:span {:class "op-mono"} mcp-url]])

   (dds/section
    {:title "現在地"}
    [:p {:class "op-lede"}
     "この appview は TypeScript/Svelte から ClojureScript へ移行済み。deploy される "
     "bundle は、いま読んでいるソースからコンパイルされたものである（docs/adr/0001）。"]
    [:p {:class "op-note"}
     "この面は 8 つの XRPC（defineSubstation / defineFeeder / getNode / listFeeders / "
     "recordReading / reportOutage / listOutages / getLoadProfile）を **実装していない**。"
     "それらを実装していた worker/src/app.ts は deploy されず、D1 の binding も"
     "宣言されていなかったので、移行では持ち越していない。設計は CLAUDE.md と "
     "dodaf/ に、停電分類の決定表は dmn/outage-class.dmn に残っている。"]
    (when built-at
      [:p {:class "op-note"} "bundle build: " built-at]))))

(defn render
  "完全な HTML 文書。`css` は呼び出し側が渡す（ライブラリは I/O を持たない）。"
  [{:keys [css] :as opts}]
  (page/->page
   {:title "Open Power — 配電網の設計と運用"
    :description "変電所・フィーダの設計と、検針・停電の運用を扱う appview の公開面。"
    :lang "ja"
    :css css
    :app-css (str tokens/bridge-css "\n" app-css)}
   (body opts)))
