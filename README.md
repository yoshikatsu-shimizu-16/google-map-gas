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
| `lib/grid/GridOverlapAnalysis.js` | 内部ヘルパー | 検索円どうしの重複率・階層0セルの半径不一致を判定する純関数(`auditGridOverlap`が使う) |
| `lib/api/PlacesApiClient.js` | 内部ヘルパー | Places API (New) 呼び出しと月間APIコール上限の自前管理 |
| `lib/api/PlaceSearchFieldMask.js` | 内部ヘルパー | searchNearby で取得するフィールドの指定(課金SKUの段を左右する) |
| `lib/crawler/WebsiteCategory.js` | 内部ヘルパー | websiteUri を HP種別(なし/SNSのみ/グルメポータル/簡易ページ/自社HP)とドメインに分類 |
| `lib/crawler/PlaceRowWriter.js` | 内部ヘルパー | 「全飲食店データ」への一括書き込みと Place ID による重複除去 |
| `lib/crawler/PlaceDataSheetFilter.js` | 内部ヘルパー | 「全飲食店データ」シートのフィルタ範囲の方針(運用者の絞り込み条件を消さない張り方) |
| `lib/crawler/PlaceDataSchemaMigration.js` | 内部ヘルパー | 「全飲食店データ」シートの列構成を保持したまま最新スキーマへ移行 |
| `lib/catalog/PlaceTypeCatalog.js` | データ | 検索対象 Place Type のカタログ定義(頻度別4グループ、および両者から導出した166種のカタログ `ALL_SEARCHABLE_PLACE_TYPES`)と密集時のタイプ分割 |
| `lib/catalog/PlaceTypeSearchSet.js` | データ | includedTypes 1コールで166種の大半を被覆するためのプレイスタイプ集合と被覆判定 `isCoveredByPlaceTypeSet` |
| `lib/catalog/PlaceTypeCoverageAnalysis.js` | 内部ヘルパー | プローブ集合の被覆率集計・貪欲法による最小被覆集合の算出(Sheet/Logger/APIに依存しない純関数) |
| `lib/crawler/PlaceTypeSetCellSearch.js` | 内部ヘルパー | 1セルをプレイスタイプ集合(傘型36種)1コールで探索する手順。`crawlAllGrids` の唯一の探索経路 |
| `lib/crawler/TypeGroupCellSearch.js` | 内部ヘルパー | 1セルを頻度別グループ(A/B/C/D)で探索する手順。通常経路からは呼ばれないが、空間分割でも解決しない飽和マス向けに残している |
| `entrypoints/auditPlaceTypeSetCoverage.js` | エントリーポイント | 「全飲食店データ」の実測値からプレイスタイプ集合の被覆率を判定(APIコール0) |
| `entrypoints/comparePlaceTypeSetWithTypeGroups.js` | エントリーポイント | 複数セルでプレイスタイプ集合1コールと4グループの Place ID 差分を検証(**Pro段。営業用の枠を使わない**) |
| `lib/survey/SurveyCallBudget.js` | 内部ヘルパー | 調査系が1回の実行で使ってよいコール数(`SURVEY_MAX_CALLS`)の読み取り |
| `entrypoints/surveySaturatedCells.js` | エントリーポイント | 飽和マスを4分割して密度を測る。実行のたびに1段ずつ深く掘り、全域が20件未満に割れるまで繰り返す |
| `entrypoints/surveyAllCells.js` | エントリーポイント | 全マスに1コールずつ投げ、密度とタイプの実態を Pro枠で洗い出す |
| `lib/survey/EmptyCellPrediction.js` | データ(自動生成) | OSMが飲食店0件と見たグリッドIDの一覧。`npm run predict-empty` で再生成 |
| `lib/survey/OsmFoodPoiSource.js` | ローカル用 | Overpass のクエリ組み立てとレスポンス変換(純関数。GASへはデプロイしない) |
| `lib/survey/CellDensityIndex.js` | ローカル用 | POIをセル矩形・検索円に対応付けて件数を引く(純関数。GASへはデプロイしない) |
| `entrypoints/surveyEmptyCells.js` | エントリーポイント | OSMが0件と見たセルをPro段1コールずつで実地確認(**営業用の枠を消費しない**) |
| `tools/fetchOsmFoodPois.js` | ローカル用 | 上記の共有クエリをローカルから curl で叩き、結果をキャッシュする |
| `tools/buildDensityMap.js` | ローカル用 | セル別の飲食店密度を見積もり、コール数を試算(`npm run density`) |
| `tools/generateEmptyCellPrediction.js` | ローカル用 | 0件予測セルの一覧を GAS 用のソースとして生成(`npm run predict-empty`) |
| `entrypoints/auditGridOverlap.js` | エントリーポイント | 「グリッド一覧」の半径不一致・検索円の重複をAPIコール0で点検し、未処理セルの半径不一致を修正する(`fixUnprocessedRootRadius`) |
| `docs/survey-findings-2026-09.md` | ドキュメント | **全域調査の結果と次の一手**。実測値・確定した設計・踏んではいけない地雷 |
| `docs/Overview.js` | ドキュメント | プロジェクト全体の設計意図(ワークフロー全体像・密集エリア対策・月間APIコール上限の理由) |
| `appsscript.json` | 設定 | GASプロジェクトのマニフェスト(タイムゾーン・実行環境など) |
| `.clasp.json.example` | 設定 | `clasp` 用設定のひな形(実際の `.clasp.json` は各自で作成し、Gitには含めません) |
| `.claspignore` | 設定 | `clasp push` 時にアップロードするファイルを上記30個の `.js` と `appsscript.json` のみに限定する設定 |

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
「プレイスタイプ」は Google Places API (New) の公式用語で、場所の種類を表す分類のこと
(例: `restaurant`, `cafe`。一覧は
[Table A](https://developers.google.com/maps/documentation/places/web-service/place-types?hl=ja#table-a))。

`crawlAllGrids` の探索方式はプレイスタイプ集合(`PLACE_TYPE_SEARCH_SET`、傘型36種)1コールに
一本化しており、切り替え用のスクリプトプロパティはありません(詳細は `docs/Overview.js` を参照)。

  > **`auditPlaceTypeSetCoverage` の前提**: この監査は「全飲食店データ」の**「全タイプ」列だけ**を
  > 母集団として読みます。`places.types` はフィールドマスクに後から追加した項目なので、
  > **それ以前に取得した行では「全タイプ」が空**で、判定対象になりません。シートが旧スキーマの
  > ままの場合や、全行の「全タイプ」が空の場合は、被覆率を出さずに理由を添えて中断します
  > (住所列を誤って読んで「被覆率0%」を出さないため)。判定には、旧方式(4グループ)で
  > 取得した行が必要です(通常経路をプローブ集合に統一した現在、新規取得行では自己循環に
  > なるため使えません)。
### 無料枠は課金SKUごとに別勘定

`X-Goog-FieldMask` の中身で課金SKUが決まり、**無料枠も段ごとに分かれています**。

| SKU | 無料枠/月 | このプロジェクトでの用途 | fieldMask |
|---|---|---|---|
| Pro | **5,000** | 調査(どう割れば20件に収まるかを調べる) | `PLACE_SURVEY_FIELD_MASK` |
| Enterprise | 1,000 | 営業データの収穫(評価・HP・電話) | `PLACE_SEARCH_FIELD_MASK` |

自前のコール数管理も SKU 単位で分けています(`MONTHLY_QUOTA_BY_SKU`)。分けないと調査の
試行錯誤が営業用の枠を食い潰してしまうためです。SKUは呼び出し側が指定するのではなく
**fieldMask から導出**します(`apiSkuOfFieldMask`)。未知のマスクは安全側の Enterprise 扱いです。

消費数のスクリプトプロパティは Pro が `MONTHLY_PRO_API_CALL_COUNT`、
Enterprise が `MONTHLY_API_CALL_COUNT`(運用中のカウントを引き継ぐため改名していません)。

- `SURVEY_MAX_CALLS`(任意) — **調査系エントリーポイント共通**で、1回の実行で使ってよいコール数の上限。
  **`0` にすると「実行したら何コール必要か」を報告するだけで、Googleへのリクエストは
  1件も発生しません**(請求先を紐付けたキーに切り替えた直後など、消費量を確定させて
  から実行したいときに使う)。未設定なら上限なし
- `PROBE_SURVEY_SAMPLE_SIZE`(任意、キー名は変更していません) — `comparePlaceTypeSetWithTypeGroups` が1回の実行で検証する
  セル数。未設定なら20。消費は1セルあたり、飽和なら1コール・判定できれば5コール(すべてPro段)

## エントリーポイント一覧

GASの「実行」メニューやトリガー設定画面に並ぶ関数のうち、直接実行を想定しているのは
以下8個です。それ以外の関数は内部ヘルパーであり、他の関数からのみ呼び出されます。
各関数のJSDoc先頭にも `[エントリーポイント/...]` の目印を付けているので、コードを読む際も
この表と同じ分類がその場で分かります。

| 関数名 | ファイル | 種別 | 用途 | 備考 |
|---|---|---|---|---|
| `generateGridList` | `entrypoints/generateGridList.js` | 手動実行 | 対象エリアをグリッド分割し「グリッド一覧」シートを作成 | 再実行すると処理状況(進捗)がリセットされる |
| `crawlAllGrids` | `entrypoints/crawlAllGrids.js` | トリガー対象(手動再実行も可) | グリッド巡回・店舗検索・「全飲食店データ」への書き込み | 日次3時台の自動トリガー対象。関数名は変更禁止(トリガーが文字列で参照)。1セル1コール(プローブ集合)、飽和したら4分割。**LockServiceで排他制御**しており、他の実行が進行中なら待たずに即終了する(無駄な重複コールの防止) |
| `createDailyTrigger` | `entrypoints/triggers.js` | 手動実行(初回のみ) | `crawlAllGrids` の日次トリガーを設定 | 何度実行しても重複作成されない |
| `listTriggers` | `entrypoints/triggers.js` | 確認用 | 現在設定されているトリガー一覧をログ出力 | 副作用なし |
| `checkMonthlyApiUsage` | `entrypoints/checkMonthlyApiUsage.js` | 確認用 | **SKUごとの**月間APIコール数をログ出力 | 副作用なし。**APIコール0**。カウンタはスクリプト単位で、APIキーを別プロジェクトに替えても引き継がれる |
| `resetRestaurantData` | `entrypoints/resetRestaurantData.js` | 手動実行(初回・データ再取得時のみ) | 「全飲食店データ」シートのデータ行を全削除 | データ消去を伴うため実行前に要確認 |
| `surveySaturatedCells` | `entrypoints/surveySaturatedCells.js` | 調査用 | 飽和マス(20件以上)を4分割し「調査(分割マス)」に記録。**実行のたびに1段ずつ深く掘る** | **Pro段のため営業用の枠を消費しない**。親1つにつき4コール。**「グリッド一覧」に子グリッドを追加しない**。先に `surveyAllCells` が必要 |
| `surveyAllCells` | `entrypoints/surveyAllCells.js` | 調査用 | 全マスに1コールずつ投げ、密度とタイプの実態を「調査(マス)」「調査(店)」に記録 | **Pro段のため営業用の枠を消費しない**。1マス1コール固定。本番シートに書き込まない。`SURVEY_MAX_CALLS=0` で試算のみ |
| `surveyEmptyCells` | `entrypoints/surveyEmptyCells.js` | 調査用 | OSMが0件と見た**未処理**セルを1コールずつ実地確認し「調査ログ」に記録 | **Pro段のため営業用の枠(1,000/月)を消費しない**。消費コール数=対象セル数。`SURVEY_MAX_CALLS=0` で試算のみ。本番シートに書き込まない |
| `auditPlaceTypeSetCoverage` | `entrypoints/auditPlaceTypeSetCoverage.js` | 確認用 | 実測データからプレイスタイプ集合の被覆率・最小被覆集合をログ出力 | 副作用なし。**APIコール0**。旧方式(4グループ)で取得した行が必要(下記の前提を参照)。通常経路を一本化した現在は新規取得行に対して使えない(自己循環) |
| `comparePlaceTypeSetWithTypeGroups` | `entrypoints/comparePlaceTypeSetWithTypeGroups.js` | 調査用 | 複数セルでプレイスタイプ集合1コールと4グループ(A/B/C/D)の差分を検証し「調査ログ(傘型)」に記録 | **Pro段のため営業用の枠を消費しない**。1セル5コール(飽和なら1)。**「全飲食店データ」に書き込まない**(Pro段は評価もHPも無いため) |
| `auditGridOverlap` | `entrypoints/auditGridOverlap.js` | 確認用 | 「グリッド一覧」の階層0セルの半径不一致・検索円の重複をログ出力 | 副作用なし。**APIコール0**。旧 `generateGridList` が半径700mを決め打ちしていた行(現行は約717m)や、旧ロジックの兄弟円どうしの重複を検出する |
| `fixUnprocessedRootRadius` | `entrypoints/auditGridOverlap.js` | 手動実行 | 階層0セルのうち「未処理」の行だけ、半径を現行コードの計算値に修正 | **APIコール0**。処理済みの行には触らない(過去のコールをやり直すと無駄になるため) |

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
# = node tools/verifyGridGeometry.js && node tools/verifyGridOverlapAnalysis.js &&
#   node tools/verifyPlaceTypeSetCoverage.js && node tools/verifyCrawlerOnStubs.js
```

```bash
node tools/verifyGridGeometry.js
```

検索半径の導出、旧スキーマからの逆算、四分木分割がセル矩形を漏れなく覆うことを
モンテカルロ法(30万点)で確認します。旧実装が親円の約4.5%を覆えていなかったことも
対照として出力するため、分割ロジックを変更した際のリグレッション検知に使えます。

```bash
node tools/verifyGridOverlapAnalysis.js
```

`circleIntersectionArea` / `overlapFraction` / `findOverlappingPairs` /
`findRootRadiusMismatches`(Sheet/Logger/APIに依存しない純関数)を検証します。
旧ロジック(親円0.6倍の4円)が生成する隣接兄弟円は幾何的に重なる設計だったことを
具体的な数値で確認し、半径700m決め打ちの行が現行コードの計算値(約717m)と
十数m規模でズレることも確認します(`auditGridOverlap` の判定根拠、Issue #24)。

```bash
node tools/verifyPlaceTypeSetCoverage.js
```

`PLACE_TYPE_SEARCH_SET` / `isCoveredByPlaceTypeSet` / `parsePlaceTypesCell` /
`summarizePlaceTypeSetCoverage` / `findMinimalPlaceTypeCover`(Sheet/Logger/APIに依存しない純関数)を
検証します。貪欲法の最小被覆集合は決定的である(再実行しても選択順が揺れない)ことも
確認します。`auditPlaceTypeSetCoverage` 自体もフェイクシート上で1回通し、「全タイプ」が空の行が
未被覆ではなく判定対象外として扱われることを確認します。

```bash
node tools/verifyCrawlerOnStubs.js
```

`.claspignore` のホワイトリスト全ファイルを GAS と同じ単一グローバルスコープに結合し、
スタブ上で `generateGridList` → `crawlAllGrids` を通します。処理状況の遷移、子グリッドの
生成、Place ID の重複除去、コール数の計測、旧スキーマからの移行(進捗の保持と冪等性)に加え、
プローブ集合(傘型36種)による探索についても、疎・空セルが1コールで確定すること、
密集セル(20件飽和)はA/B/C/Dへフォールバックせず1コールで空間分割に回ること、
プローブ集合で被覆されない店が見つかったときに警告ログが出ることに加え、
`LockService` による排他制御(他の実行が進行中なら待たずに終了し、正常終了時・
早期リターン時のどちらでも確実にロックが解放されること)、`auditGridOverlap` /
`fixUnprocessedRootRadius`(半径不一致・検索円の重複検出と、未処理セルだけの
修正)も確認します。
**デプロイ前にこちらを通しておくと、関数名の取り違えを実機で踏まずに済みます。**

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

#### 「処理状況」に入る値

| 値 | 意味 | 完了扱い |
|---|---|---|
| `未処理` | まだ検索していない | — |
| `処理済み(プローブ)` | 1〜19件取れて確定した | ✓ |
| `処理済み(0件)` | **Googleに聞いて店が1件も無かった** | ✓ |
| `密集(分割済み)` | 20件飽和したので4分割した(子グリッドを追加済み) | ✓ |
| `要確認(上限到達)` | MAX_TIER まで分割してもまだ20件出る | ✓ |
| `エラー` | 検索に失敗した(次回の実行で再試行される) | — |
| `処理済み` / `密集(タイプ分割済み)` / `処理済み(A=0のため省略)` | 旧方式(A/B/C/D)時代の値。新たに書かれることはない | ✓ |

`処理済み(0件)` を `処理済み(プローブ)` と分けているのは、**1コール払って得た「ここには
店が無い」という一番確実な情報を残す**ためです。実測では638マス中64マス(10.0%)、
分割マスまで含めると331マスが0件でした(`docs/survey-findings-2026-09.md` 2-3)。
探索計画から恒久的に外してよいセルを選ぶ根拠になります。どちらも探索は完了しているので、
再探索されない点は同じです。

古いコードに戻す場合は `clasp push` 前のコミットに戻して再 push します。ただし
**シートに追加されたH列と新しいステータスは残る**ため、旧コードで動かすときは
H列を削除し、`処理済み(A=0のため省略)` を `未処理` に一括置換してください。

### 検索方式のロールバックと再掃討

探索方式(プローブ集合1コール)を旧方式(頻度別4グループ)に戻したい場合は、
`crawlAllGrids` をこの変更の前のコミットに戻して再 push してください
(スクリプトプロパティによる即時切り替えはできません)。

`処理済み(A=0のため省略)` は旧方式時代に「グループAが0件だったためB/C/Dの3コールを
省略した」セルであり、稀タイプだけが存在するセルを取りこぼしている既知の穴です。
プローブ集合は傘型で稀タイプも覆うため、**この行を `未処理` に一括置換して
`crawlAllGrids` を再実行すれば、1セルあたり1コールでこの穴を塞げます**
(自動化はしていないので、必要になったタイミングで手動置換してください)。

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
