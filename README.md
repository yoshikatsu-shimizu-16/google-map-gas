# google-map-gas

指定した座標付近の、指定したカテゴリの店舗情報を Google Places API (New) で収集し、
Google スプレッドシートに書き出す Google Apps Script (GAS) プロジェクトです。

これまで GAS のスクリプトエディタ上で直接編集されていたコードを、このリポジトリで
ソース管理します。

## ファイル構成

本体スクリプトは責務ごとに `lib/` 配下のディレクトリへ分割しています。GAS は同一プロジェクト
内の全ファイルが単一のグローバルスコープに結合されるため、この分割はモジュールとしての依存
分離ではなく、あくまで人間が読むための整理です。パス中の `/` はそのまま GAS 側のファイル名
になり、Apps Script エディタのサイドバーがフォルダのように階層表示します。

| パス | 責務 |
|---|---|
| `docs/Overview.js` | プロジェクト全体の設計意図(ワークフロー全体像・密集エリア対策・月間APIコール上限の理由) |
| `lib/catalog/PlaceTypeCatalog.js` | 検索対象 Place Type のカタログ定義(頻度別4グループ) |
| `lib/grid/GridList.js` | 「グリッド一覧」シートの生成・スキーマ管理・座標ジオメトリ |
| `lib/api/PlacesApiClient.js` | Places API (New) 呼び出しと月間APIコール上限の自前管理 |
| `lib/crawler/Crawler.js` | クロール実行本体(メインワークフロー) |
| `lib/trigger/Triggers.js` | 時間主導トリガーの作成・確認 |
| `lib/maintenance/Maintenance.js` | データ初期化などの運用ユーティリティ |
| `appsscript.json` | GASプロジェクトのマニフェスト(タイムゾーン・実行環境など) |
| `.clasp.json.example` | `clasp` 用設定のひな形(実際の `.clasp.json` は各自で作成し、Gitには含めません) |
| `.claspignore` | `clasp push` 時にアップロードするファイルを上記7つの `.js` と `appsscript.json` のみに限定する設定 |

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

このリポジトリで `lib/` 配下や `appsscript.json` を編集したら、コミット後に以下で
Apps Script プロジェクト側へ反映します。

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

## エントリーポイント一覧

GASの「実行」メニューやトリガー設定画面に並ぶ関数のうち、直接実行を想定しているのは
以下6個です。それ以外の関数は内部ヘルパーであり、他の関数からのみ呼び出されます。
各関数のJSDoc先頭にも `[エントリーポイント/...]` の目印を付けているので、コードを読む際も
この表と同じ分類がその場で分かります。

| 関数名 | ファイル | 種別 | 用途 | 備考 |
|---|---|---|---|---|
| `generateGridList` | `lib/grid/GridList.js` | 手動実行 | 対象エリアをグリッド分割し「グリッド一覧」シートを作成 | 再実行すると処理状況(進捗)がリセットされる |
| `crawlAllGrids` | `lib/crawler/Crawler.js` | トリガー対象(手動再実行も可) | グリッド巡回・店舗検索・「全飲食店データ」への書き込み | 日次3時台の自動トリガー対象。関数名は変更禁止(トリガーが文字列で参照) |
| `createDailyTrigger` | `lib/trigger/Triggers.js` | 手動実行(初回のみ) | `crawlAllGrids` の日次トリガーを設定 | 何度実行しても重複作成されない |
| `listTriggers` | `lib/trigger/Triggers.js` | 確認用 | 現在設定されているトリガー一覧をログ出力 | 副作用なし |
| `checkMonthlyApiUsage` | `lib/api/PlacesApiClient.js` | 確認用 | 今月のAPIコール数をログ出力 | 副作用なし |
| `resetRestaurantData` | `lib/maintenance/Maintenance.js` | 手動実行(初回・データ再取得時のみ) | 「全飲食店データ」シートのデータ行を全削除 | データ消去を伴うため実行前に要確認 |

## 実行順序(初回セットアップ)

1. `generateGridList` — 対象エリア全体をグリッド分割し、「グリッド一覧」シートに座標を保存
2. `crawlAllGrids` — グリッド一覧を巡回して Nearby Search を呼び出し、「全飲食店データ」
   シートに書き込み(GASの実行時間上限があるため、未処理分が残る場合は再実行してください)
3. `createDailyTrigger` — `crawlAllGrids` を毎日自動実行するトリガーを設定(初回のみ)

上記以外に、動作確認・運用時に個別実行する関数は上の「エントリーポイント一覧」を参照して
ください。詳細な設計意図(密集エリア対策・月間APIコール上限など)は `docs/Overview.js` を
参照してください。
