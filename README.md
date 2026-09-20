# google-map-gas

指定した座標付近の、指定したカテゴリの店舗情報を Google Places API (New) で収集し、
Google スプレッドシートに書き出す Google Apps Script (GAS) プロジェクトです。

これまで GAS のスクリプトエディタ上で直接編集されていたコードを、このリポジトリで
ソース管理します。

## ファイル構成

本体スクリプトはリポジトリ直下ではなく、3つのディレクトリに分けています。GAS は同一
プロジェクト内の全ファイルが単一のグローバルスコープに結合されるため、この分割はモジュール
としての依存分離ではなく、あくまで人間が読むための整理です。パス中の `/` はそのまま GAS
側のファイル名になり、Apps Script エディタのサイドバーがフォルダのように階層表示します。

- **`entrypoints/`** — GASの「実行」メニューやトリガーから直接実行するエントリーポイント。
  まずここを見れば「実行できるもの」が分かります。
- **`lib/`** — エントリーポイントが使う内部ヘルパー・定数(責務ごとのサブディレクトリ)。
- **`docs/`** — プロジェクト全体の設計意図(コードではなく説明コメントのみ)。

| パス | 種別 | 内容 |
|---|---|---|
| `entrypoints/generateGridList.js` | エントリーポイント | 対象エリアをグリッド分割し「グリッド一覧」シートを作成 |
| `entrypoints/crawlAllGrids.js` | エントリーポイント | グリッド巡回・店舗検索・「全飲食店データ」への書き込み |
| `entrypoints/triggers.js` | エントリーポイント | `crawlAllGrids` の日次トリガーの作成・確認 |
| `entrypoints/checkMonthlyApiUsage.js` | エントリーポイント | 今月のAPIコール数の確認(動作確認用) |
| `entrypoints/resetRestaurantData.js` | エントリーポイント | 「全飲食店データ」シートのデータ行を全削除(運用ユーティリティ) |
| `lib/grid/TargetArea.js` | 内部ヘルパー | 対象エリアの範囲定数と、セルが探索対象に含まれるかの判定 |
| `lib/grid/GridGeometry.js` | 内部ヘルパー | 度⇄メートル変換とセルの外接円半径の導出(純関数のみ) |
| `lib/grid/GridSubdivision.js` | 内部ヘルパー | 密集セルを4象限に等分する四分木分割 |
| `lib/grid/GridSchemaMigration.js` | 内部ヘルパー | 「グリッド一覧」シートの列構成と、進捗を保持したままのスキーマ移行 |
| `lib/api/PlacesApiClient.js` | 内部ヘルパー | Places API (New) 呼び出しと月間APIコール上限の自前管理 |
| `lib/api/PlaceSearchFieldMask.js` | 内部ヘルパー | searchNearby で取得するフィールドの指定(課金SKUの段を左右する) |
| `lib/crawler/WebsiteCategory.js` | 内部ヘルパー | websiteUri を HP種別(なし/SNSのみ/グルメポータル/簡易ページ/自社HP)とドメインに分類 |
| `lib/crawler/PlaceRowWriter.js` | 内部ヘルパー | 「全飲食店データ」への一括書き込みと Place ID による重複除去 |
| `lib/crawler/PlaceDataSheetFilter.js` | 内部ヘルパー | 「全飲食店データ」シートのフィルタ範囲の方針(運用者の絞り込み条件を消さない張り方) |
| `lib/crawler/PlaceDataSchemaMigration.js` | 内部ヘルパー | 「全飲食店データ」シートの列構成を保持したまま最新スキーマへ移行 |
| `lib/catalog/PlaceTypeCatalog.js` | データ | 検索対象 Place Type のカタログ定義(頻度別4グループ、および両者から導出した166種のカタログ `ALL_SEARCHABLE_PLACE_TYPES`)と密集時のタイプ分割 |
| `lib/catalog/PlaceTypeProbeSet.js` | データ | includedTypes 1コールで166種の大半を被覆するためのプローブ集合と被覆判定 `isCoveredByProbeSet` |
| `lib/catalog/PlaceTypeCoverageAnalysis.js` | 内部ヘルパー | プローブ集合の被覆率集計・貪欲法による最小被覆集合の算出(Sheet/Logger/APIに依存しない純関数) |
| `lib/crawler/SearchStrategyMode.js` | 内部ヘルパー | 検索戦略(`type_groups`/`probe`)をスクリプトプロパティで切り替える単一の真実源 |
| `lib/crawler/TypeGroupCellSearch.js` | 内部ヘルパー | 1セルを頻度別グループ(A/B/C/D)で探索する手順(`type_groups`方式の実体、`probe`方式のフォールバック先) |
| `lib/crawler/ProbeFirstCellSearch.js` | 内部ヘルパー | 1セルをプローブ集合優先で探索する手順(`probe`方式の実体) |
| `entrypoints/auditProbeSetCoverage.js` | エントリーポイント | 「全飲食店データ」の実測値からプローブ集合の被覆率を判定(APIコール0) |
| `entrypoints/compareProbeSetWithTypeGroups.js` | エントリーポイント | 指定グリッドでプローブ集合とタイプグループの Place ID 差分を確認(5〜25コール) |
| `tools/fetchOsmFoodPois.js` | ローカル用 | OpenStreetMap から対象エリアの飲食系POIを取得(APIキー不要・Googleのコールを使わない) |
| `tools/buildDensityMap.js` | ローカル用 | セル別の飲食店密度を見積もり、コール数を試算(`npm run density`) |
| `docs/Overview.js` | ドキュメント | プロジェクト全体の設計意図(ワークフロー全体像・密集エリア対策・月間APIコール上限の理由) |
| `appsscript.json` | 設定 | GASプロジェクトのマニフェスト(タイムゾーン・実行環境など) |
| `.clasp.json.example` | 設定 | `clasp` 用設定のひな形(実際の `.clasp.json` は各自で作成し、Gitには含めません) |
| `.claspignore` | 設定 | `clasp push` 時にアップロードするファイルを上記24個の `.js` と `appsscript.json` のみに限定する設定 |

## Google Drive 上の Apps Script プロジェクトとの接続方法

GAS プロジェクトの実体は Google Drive 上に保存されており、ローカルの Git リポジトリと
同期するには Google 製 CLI である [`clasp`](https://github.com/google/clasp) を使います。
`clasp login` はブラウザでの Google アカウント認証が必要です。**手元のPCなど、
ブラウザを開ける環境で実行してください**(サーバーやCIなど、ブラウザを起動できない環境では実行できません)。

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. Google アカウントでログイン(初回のみ)

```bash
npm run login
# = clasp login
```

ブラウザが開くので、このプロジェクトを所有する Google アカウントでログインしてください。

### 3. 既存の Apps Script プロジェクトと接続する

すでに店舗情報の取得に使っている GAS プロジェクトがある場合は、そのスクリプトID
(スクリプトエディタの「プロジェクトの設定」→「スクリプトID」で確認できます)を使って
このリポジトリに接続します。

```bash
cp .clasp.json.example .clasp.json
```

作成した `.clasp.json` の `scriptId` を実際のスクリプトIDに書き換えてください。
`.clasp.json` は環境固有の情報のためGit管理対象外(`.gitignore`済み)です。

接続後、Drive側の最新コードを取得したい場合は以下を実行します(既存のローカルファイルを
Drive側の内容で上書きするため、事前に `git status` で差分がないか確認してください)。

```bash
npm run pull
# = clasp pull
```

### 4. 新規に Apps Script プロジェクトを作成する場合

まだ GAS プロジェクトが存在しない場合は、以下で新規作成できます(実行すると
`.clasp.json` が自動生成されます)。

```bash
npx clasp create --type standalone --title "店舗情報取得" --rootDir .
```

### 5. ローカルの変更を Drive(Apps Script)に反映する

このリポジトリで `entrypoints/` / `lib/` 配下 / `appsscript.json` を編集したら、
コミット後に以下で Apps Script プロジェクト側へ反映します。

```bash
npm run push
# = clasp push
```

## スクリプトプロパティ(要設定)

`clasp push` ではスクリプトプロパティは同期されません。Apps Script エディタの
「プロジェクトの設定」→「スクリプト プロパティ」で以下を設定してください。

- `GOOGLE_MAPS_API_KEY` — Google Maps Platform の APIキー
- `TARGET_SPREADSHEET_ID` — 書き込み先スプレッドシートID(未設定の場合、`generateGridList`
  実行時に新規スプレッドシートが自動作成されます)
- `SEARCH_STRATEGY`(任意) — `crawlAllGrids` の探索方式。`type_groups`(既定、未設定時と同じ)
  なら頻度別4グループ(A/B/C/D)で毎セル無条件に検索する旧方式、`probe` ならプローブ集合
  (`PLACE_TYPE_PROBE_SET`)優先の新方式(疎セルは1コールで確定、20件飽和セルだけ旧方式に
  完全フォールバック)。不正な値を入れると警告ログ付きで `type_groups` にフォールバックする。
  `probe` に切り替える前に必ず `auditProbeSetCoverage` で被覆率を確認すること
  (詳細は `docs/Overview.js` のリスク表を参照)

  > **`auditProbeSetCoverage` の前提**: この監査は「全飲食店データ」の**「全タイプ」列だけ**を
  > 母集団として読みます。`places.types` はフィールドマスクに後から追加した項目なので、
  > **それ以前に取得した行では「全タイプ」が空**で、判定対象になりません。シートが旧スキーマの
  > ままの場合や、全行の「全タイプ」が空の場合は、被覆率を出さずに理由を添えて中断します
  > (住所列を誤って読んで「被覆率0%」を出さないため)。判定には、フィールドマスク更新後に
  > 新しく取得した行が必要です。
- `PROBE_COMPARISON_GRID_ID`(任意) — `compareProbeSetWithTypeGroups` の対象グリッドID。
  未設定なら0コールで案内ログのみを出して終了する(実行メニューからの誤爆防止)

## エントリーポイント一覧

GASの「実行」メニューやトリガー設定画面に並ぶ関数のうち、直接実行を想定しているのは
以下8個です。それ以外の関数は内部ヘルパーであり、他の関数からのみ呼び出されます。
各関数のJSDoc先頭にも `[エントリーポイント/...]` の目印を付けているので、コードを読む際も
この表と同じ分類がその場で分かります。

| 関数名 | ファイル | 種別 | 用途 | 備考 |
|---|---|---|---|---|
| `generateGridList` | `entrypoints/generateGridList.js` | 手動実行 | 対象エリアをグリッド分割し「グリッド一覧」シートを作成 | 再実行すると処理状況(進捗)がリセットされる |
| `crawlAllGrids` | `entrypoints/crawlAllGrids.js` | トリガー対象(手動再実行も可) | グリッド巡回・店舗検索・「全飲食店データ」への書き込み | 日次3時台の自動トリガー対象。関数名は変更禁止(トリガーが文字列で参照)。`SEARCH_STRATEGY` で探索方式を切替 |
| `createDailyTrigger` | `entrypoints/triggers.js` | 手動実行(初回のみ) | `crawlAllGrids` の日次トリガーを設定 | 何度実行しても重複作成されない |
| `listTriggers` | `entrypoints/triggers.js` | 確認用 | 現在設定されているトリガー一覧をログ出力 | 副作用なし |
| `checkMonthlyApiUsage` | `entrypoints/checkMonthlyApiUsage.js` | 確認用 | 今月のAPIコール数と現在の検索方式をログ出力 | 副作用なし |
| `resetRestaurantData` | `entrypoints/resetRestaurantData.js` | 手動実行(初回・データ再取得時のみ) | 「全飲食店データ」シートのデータ行を全削除 | データ消去を伴うため実行前に要確認 |
| `auditProbeSetCoverage` | `entrypoints/auditProbeSetCoverage.js` | 確認用 | 実測データからプローブ集合の被覆率・最小被覆集合をログ出力 | 副作用なし。**APIコール0**。`SEARCH_STRATEGY=probe` へ切り替える前に実行すること。**「全タイプ」列が埋まった行が必要**(下記の前提を参照) |
| `compareProbeSetWithTypeGroups` | `entrypoints/compareProbeSetWithTypeGroups.js` | 確認用 | 指定グリッドでプローブ集合とタイプグループの Place ID 差分をログ出力 | `PROBE_COMPARISON_GRID_ID` 未設定なら0コールで案内のみ。設定時は5〜25コール |

## 実行順序(初回セットアップ)

1. `generateGridList` — 対象エリア全体をグリッド分割し、「グリッド一覧」シートに座標を保存
2. `crawlAllGrids` — グリッド一覧を巡回して Nearby Search を呼び出し、「全飲食店データ」
   シートに書き込み(GASの実行時間上限があるため、未処理分が残る場合は再実行してください)
3. `createDailyTrigger` — `crawlAllGrids` を毎日自動実行するトリガーを設定(初回のみ)

上記以外に、動作確認・運用時に個別実行する関数は上の「エントリーポイント一覧」を参照して
ください。詳細な設計意図(密集エリア対策・月間APIコール上限など)は `docs/Overview.js` を
参照してください。

## ローカル検証

GAS には型チェックもコンパイルもなく、識別子の取り違えはデプロイして実行するまで
分かりません。`tools/` に3つの検証スクリプトを置いており、**APIコールもスプレッドシートも
使わずに**手元で実行できます。`tools/` は `.claspignore` の対象外なので `clasp push`
では送信されません。まとめて実行するには:

```bash
npm test
# = node tools/verifyGridGeometry.js && node tools/verifyProbeSetCoverage.js && node tools/verifyCrawlerOnStubs.js
```

```bash
node tools/verifyGridGeometry.js
```

検索半径の導出、旧スキーマからの逆算、四分木分割がセル矩形を漏れなく覆うことを
モンテカルロ法(30万点)で確認します。旧実装が親円の約4.5%を覆えていなかったことも
対照として出力するため、分割ロジックを変更した際のリグレッション検知に使えます。

```bash
node tools/verifyProbeSetCoverage.js
```

`PLACE_TYPE_PROBE_SET` / `isCoveredByProbeSet` / `parsePlaceTypesCell` /
`summarizeProbeCoverage` / `findMinimalProbeCover`(Sheet/Logger/APIに依存しない純関数)を
検証します。貪欲法の最小被覆集合は決定的である(再実行しても選択順が揺れない)ことも
確認します。`auditProbeSetCoverage` 自体もフェイクシート上で1回通し、「全タイプ」が空の行が
未被覆ではなく判定対象外として扱われることを確認します。

```bash
node tools/verifyCrawlerOnStubs.js
```

`.claspignore` のホワイトリスト全ファイルを GAS と同じ単一グローバルスコープに結合し、
スタブ上で `generateGridList` → `crawlAllGrids` を通します。処理状況の遷移、子グリッドの
生成、Place ID の重複除去、コール数の計測、旧スキーマからの移行(進捗の保持と冪等性)に加え、
`SEARCH_STRATEGY=probe`(プローブ優先方式)についても、疎セルが1コールで確定すること、
密集セルでの子グリッド生成数が旧方式と一致すること、疎セルの取得 Place ID 集合が新旧で
完全一致すること、プローブ集合で被覆されない店が見つかったときに警告ログが出ることを
確認します。**デプロイ前にこちらを通しておくと、関数名の取り違えを実機で踏まずに済みます。**

## スキーマ移行とロールバック

`crawlAllGrids` は起動時に `ensureGridSchemaMigrated` を呼び、「グリッド一覧」シートを
最新のスキーマ(8列)へ自動で移行します。既存の値は基本的に書き換えないため、**処理状況
(進捗)は保持されます**。移行は冪等で、何度実行しても結果は変わりません。

例外として、旧ロジック(親円を0.6倍4つの円で覆う方式)が生成した階層1以上の行だけは、
「階層」列を MAX_TIER に書き換えます。これらの行が持つ半径は円形の探索範囲を表しており、
新ロジックの矩形四分木分割の前提(セル矩形)とは形状が異なるため、そのまま自動細分化する
と旧検索円の一部(密集セルの場合で約19%)が被覆漏れになります。階層を MAX_TIER に
固定することで、これらの行が再び飽和判定されても自動分割せず「要確認(上限到達)」に倒し、
人間の確認に委ねます。

| 列 | 内容 | 追加時期 |
|---|---|---|
| A〜E | グリッドID / 中心緯度 / 中心経度 / 半径(m) / 処理状況 | 初期 |
| F〜G | 階層 / 親グリッドID | 密集エリアの自動細分化に対応した際 |
| H | セルサイズ(度) | 半径を導出値にし、四分木分割の基準を持たせた際 |

「半径(m)」はグリッド生成時に確定した実際の検索半径、「セルサイズ(度)」はそのセルが
担当する領域の広さです。四分木分割は後者を基準にするため、半径だけを手で書き換えても
分割の粒度には反映されません。

古いコードに戻す場合は `clasp push` 前のコミットに戻して再 push します。ただし
**シートに追加されたH列と新しいステータスは残る**ため、旧コードで動かすときは
H列を削除し、`処理済み(A=0のため省略)` を `未処理` に一括置換してください。

### 検索方式(SEARCH_STRATEGY)のロールバックと再掃討

`SEARCH_STRATEGY=probe` を試して問題があった場合、スクリプトプロパティを
`type_groups` に戻せば **push なしで即座に**旧方式へ戻ります。「処理状況」列に
`処理済み(プローブ)` が付いた行は、旧コード(`SEARCH_STRATEGY` を知らない版)から見ると
未知のステータスのため `DONE_STATUSES` に含まれず、旧コードに完全に戻す場合は
`未処理` に一括置換してください(この状態から `crawlAllGrids` を実行すると、
そのセルは旧方式で4コールかけて再クロールされます)。

`処理済み(A=0のため省略)` は「グループAが0件だったためB/C/Dの3コールを省略した」
セルであり、稀タイプだけが存在するセルを取りこぼしている既知の穴です。プローブ集合は
傘型で稀タイプも覆うため、**この行を `未処理` に一括置換して `SEARCH_STRATEGY=probe` で
再走査すれば、1セルあたり1コールでこの穴を塞げます**(自動化はしていないので、
必要になったタイミングで手動置換してください)。

### 「全飲食店データ」シート

`crawlAllGrids` は起動時に `ensurePlaceDataSchemaMigrated` も呼び、「全飲食店データ」シートを
最新のスキーマ(17列)へ自動で移行します。**取得済みの店舗行は再クロールせずに保持されます**
(再クロールには Enterprise SKU の無料枠を約1.5ヶ月ぶん消費するため)。移行は冪等です。

グリッド一覧側が列数を暗黙のバージョンとして使っているのに対し、こちらは**ヘッダー名の一致**で
判定します。列の削除と並べ替えを伴うため列数では区別できないうえ、名前で突き合わせれば
「旧スキーマに同名列があれば値を引き継ぐ」という規則1つで移行が書けるためです。

| 列 | 内容 | 課金SKUの段 |
|---|---|---|
| A〜C | 店名 / 主タイプ / 全タイプ | Pro |
| D〜F | 住所 / 緯度 / 経度 | Pro |
| G | 電話番号(国内) | Enterprise |
| H〜I | HP種別 / HPドメイン | 導出列(APIコストなし) |
| J | HP URL | Enterprise |
| K | Google Maps URL | Pro |
| L〜M | 評価 / 評価件数 | Enterprise |
| N | 営業状況 | Pro |
| O〜P | 通常営業時間 / 価格帯 | Enterprise |
| Q | Place ID | Pro |

#### フィルタ(絞り込み条件)の扱い

シート1行目のフィルタは、**範囲がずれたときだけ**張り直します(`ensurePlaceDataFilter`)。
範囲は「データ行数」ではなく**シートの全行数 × スキーマの列数**で張るため、クロールで
行が増えても範囲は変わらず、運用者が設定した絞り込み条件
(`HP種別`=なし / `評価`>=3.8 など)はそのまま残ります。

以前は実行のたびに削除・再作成していたため、日次トリガーが走るたびに条件が消えていました。
張り直しが起きるのは次の場合だけです。張り直したときはログに
「フィルタ範囲が変わったため張り直しました」と出ます。

- フィルタが存在しない(初回、または手動で外した)
- スキーマ移行で列数が変わった(旧列の条件は原理的に移せないため復元しません)
- 行容量を使い切って行を追加した(1,000行ごと。`PLACE_DATA_ROW_CAPACITY_CHUNK`)

旧スキーマ(20列)からの移行では:

- `HP有無` は `HP種別` の「なし」に統合され、列としては消えます(同じ概念を2列で持たない)
- `テイクアウト` / `デリバリー` / `店内飲食` / `予約可` / `子連れ向き` / `ペット可` /
  `説明文(Editorial)` の7列は削除されます。これらは Enterprise + Atmosphere 段でしか取れない
  一方、実データでの充足率がペット可 1% / 説明文 6% と低く、最上位 SKU に見合わないためです
- `HP種別` / `HPドメイン` は旧 `HP URL` 列から**再計算**されるため、既存行もすべて埋まります
- `全タイプ` / `緯度` / `経度` は旧スキーマに存在しないため**既存行では空**になり、以後に
  取得される新規行だけが埋まります

`HP種別` はターゲット選定の要です。旧 `HP有無` では「あり」に埋もれていた Instagram /
Facebook のみの店(実データでは HPあり の約3割)が `SNSのみ` として拾えるようになります。
チェーン店の判定はコードに持たせていません。チェーン名の列挙は際限なくメンテが必要になる
一方、`HPドメイン` 列をピボットすれば「同じドメインが複数店舗に出ている」ことで識別できます。

古いコードに戻す場合、シートは**旧コードでは自動復元されません**。`resetRestaurantData` で
作り直すか、移行前にスプレッドシートのコピーを取っておいてそちらへ戻してください。
