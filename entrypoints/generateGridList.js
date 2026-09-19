/**
 * [エントリーポイント/手動実行]
 * 対象エリア全体をだいたいカバーする緯度経度の範囲を、GRID_STEP 刻みのグリッド(格子)に
 * 分割し、各グリッドの中心座標・検索半径・処理状況を「グリッド一覧」シートに書き出す。
 *
 * このシートは crawlAllGrids が読み込み、1行(1グリッド)につき1回 searchNearby を
 * 呼び出すための「座標のリスト兼進捗管理台帳」として使われる。
 * 「処理状況」列は初期値として全行 '未処理' になり、crawlAllGrids 側で
 * '処理済み' / 'エラー' / '密集(タイプ分割済み)' / '密集(分割済み)' / '要確認(上限到達)' /
 * '処理済み(A=0のため省略)' に更新される。
 *
 * 検索半径はここでは決め打ちせず、セルサイズと中心緯度から cellCoverRadiusMeters で
 * 導出する。「半径(m)」列は生成時に確定した実際の検索半径であり、
 * 「セルサイズ(度)」列はそのセルが担当する領域の広さを表す。後者が四分木分割の
 * 基準になるため、半径だけを手で書き換えても分割の粒度には反映されない。
 *
 * 階層0(元グリッド)として生成するため、「階層」列は0、「親グリッドID」列は空にする。
 * 密集エリアの自動細分化で生まれる子グリッドは、この関数ではなく crawlAllGrids 内で
 * 同じシートに追記される。
 *
 * 注意: 既存の「グリッド一覧」がある場合、この関数を実行するとシートがクリアされ、
 * 処理状況(進捗)がリセットされる。進捗を保持したまま列だけ追加したい場合は
 * generateGridList を再実行せず、crawlAllGrids 内のスキーマ移行処理に任せること。
 *
 * @returns {void}
 */
function generateGridList() {
  const bounds = TARGET_AREA_BOUNDS;
  const gridStep = GRID_STEP;

  const scriptProps = PropertiesService.getScriptProperties();
  let spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  let spreadsheet;

  if (spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.create('飲食店リスト');
    scriptProps.setProperty('TARGET_SPREADSHEET_ID', spreadsheet.getId());
    Logger.log('新規スプレッドシートを作成しました: ' + spreadsheet.getUrl());
  }

  let gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    gridSheet = spreadsheet.insertSheet('グリッド一覧');
  }
  gridSheet.clear();
  gridSheet.appendRow(GRID_SHEET_HEADERS);

  let gridId = 1;
  const rows = [];

  // 浮動小数点の丸め誤差を避けるため、整数カウンタでループし、乗算で座標を算出する。
  // (旧: for(let lat=latMin; lat<latMax; lat+=step) では 0.01 の加算誤差により
  //  意図した範囲を超えた行・列が余分に生成されるバグがあった)
  const latSteps = Math.round((bounds.latMax - bounds.latMin) / gridStep);
  const lngSteps = Math.round((bounds.lngMax - bounds.lngMin) / gridStep);

  for (let i = 0; i < latSteps; i++) {
    const lat = bounds.latMin + i * gridStep;
    for (let j = 0; j < lngSteps; j++) {
      const lng = bounds.lngMin + j * gridStep;
      const centerLat = lat + gridStep / 2;
      const centerLng = lng + gridStep / 2;
      const radius = cellCoverRadiusMeters(gridStep, centerLat);
      rows.push([gridId, centerLat, centerLng, radius, '未処理', 0, '', gridStep]); // 階層0=元グリッド
      gridId++;
    }
  }

  gridSheet.getRange(2, 1, rows.length, GRID_SHEET_COLUMN_COUNT).setValues(rows);

  Logger.log('グリッド件数: ' + rows.length + ' / 検索半径: 約' + rows[0][3] + 'm');
}
