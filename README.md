# google-map-gas

指定した座標付近の、指定したカテゴリの店舗情報を Google Places API (New) で収集し、
Google スプレッドシートに書き出す Google Apps Script (GAS) プロジェクトです。

これまで GAS のスクリプトエディタ上で直接編集されていたコードを、このリポジトリで
ソース管理します。

## ファイル構成

- `Code.gs` — 本体スクリプト(グリッド生成・巡回・書き込み処理一式)
- `appsscript.json` — GASプロジェクトのマニフェスト(タイムゾーン・実行環境など)
- `.clasp.json.example` — `clasp` 用設定のひな形(実際の `.clasp.json` は各自で作成し、Gitには含めません)
- `.claspignore` — `clasp push` 時にアップロードするファイルを `Code.gs` / `appsscript.json` のみに限定する設定

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

接続後、Drive側の最新コードを取得したい場合は以下を実行します(既存の `Code.gs` を
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

このリポジトリで `Code.gs` / `appsscript.json` を編集したら、コミット後に以下で
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

## 実行順序

1. `generateGridList` — 対象エリア全体をグリッド分割し、「グリッド一覧」シートに座標を保存
2. `crawlAllGrids` — グリッド一覧を巡回して Nearby Search を呼び出し、「全店舗データ」
   シートに書き込み(GASの実行時間上限があるため、未処理分が残る場合は再実行してください)
3. `createDailyTrigger` — `crawlAllGrids` を毎日自動実行するトリガーを設定(初回のみ)

詳細な設計意図(密集エリア対策・月間APIコール上限など)は `Code.gs` 冒頭のコメントを
参照してください。
