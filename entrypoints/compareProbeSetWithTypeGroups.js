/**
 * [エントリーポイント/確認用]
 * スクリプトプロパティ PROBE_COMPARISON_GRID_ID で指定した1グリッドに対して、
 *   P = プローブ集合(PLACE_TYPE_PROBE_SET)で1回検索した Place ID 集合
 *   U = 頻度別グループ(A/B/C/D、20件に達したグループはさらにタイプ分割)で
 *       検索した Place ID 集合の和集合
 * を求め、その差分 U \ P と P \ U をログ出力する。auditProbeSetCoverage(0コール)を
 * 補強する確認用で、実際に API を叩いて裏取りする(5〜25コール)。
 *
 * PROBE_COMPARISON_GRID_ID が未設定の場合は0コールで案内ログのみを出して終了する
 * (実行メニューからの誤爆でAPIを消費しないため)。
 *
 * 取得した place は通常どおり createPlaceRowWriter でシートに書き込む
 * (課金して取得したデータを捨てない)。
 *
 * @returns {void}
 */
function compareProbeSetWithTypeGroups() {
  const scriptProps = PropertiesService.getScriptProperties();
  const gridIdRaw = scriptProps.getProperty('PROBE_COMPARISON_GRID_ID');
  if (!gridIdRaw) {
    Logger.log(
      'スクリプトプロパティ PROBE_COMPARISON_GRID_ID が未設定です。' +
      '密集グリッドのグリッドIDを設定してから再実行してください(0コールで終了します)。'
    );
    return;
  }
  const targetGridId = Number(gridIdRaw);

  const apiKey = scriptProps.getProperty('GOOGLE_MAPS_API_KEY');
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  const gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    Logger.log('グリッド一覧シートがありません。');
    return;
  }
  const gridLastRow = gridSheet.getLastRow();
  if (gridLastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }
  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();
  const targetRow = gridValues.filter(function(r) { return r[0] === targetGridId; })[0];
  if (!targetRow) {
    Logger.log('グリッドID ' + targetGridId + ' が「グリッド一覧」に見つかりません。');
    return;
  }
  const lat = targetRow[1];
  const lng = targetRow[2];
  const radius = targetRow[3];

  let dataSheet = spreadsheet.getSheetByName('全飲食店データ');
  if (!dataSheet) {
    dataSheet = spreadsheet.insertSheet('全飲食店データ');
    dataSheet.appendRow(PLACE_DATA_HEADERS);
  }
  const lastDataRow = dataSheet.getLastRow();
  const existingIds = new Set();
  if (lastDataRow > 1) {
    dataSheet.getRange(2, PLACE_ID_COLUMN, lastDataRow - 1, 1).getValues().forEach(function(row) {
      if (row[0]) existingIds.add(row[0]);
    });
  }
  const writer = createPlaceRowWriter(dataSheet, existingIds);

  const placesById = {}; // 差分ログ用に place の詳細を保持する(P/Uどちらの経路でも1つに集約)
  let callCount = 0;

  /**
   * @param {string[]} includedTypes
   * @returns {{ids: string[], count: number}}
   */
  const runSearch = function(includedTypes) {
    const result = callSearchNearby(apiKey, PLACE_SEARCH_FIELD_MASK, includedTypes, lat, lng, radius);
    if (result.requestSent) callCount++;
    if (!result.ok) {
      Logger.log('検索でエラー: ' + result.errorText);
      return { ids: [], count: 0 };
    }
    result.places.forEach(function(place) {
      if (place.id) placesById[place.id] = place;
      writer.add(place); // 課金して取得したデータは差分に関わらずシートに書く
    });
    return {
      ids: result.places.map(function(p) { return p.id; }).filter(Boolean),
      count: result.places.length
    };
  };

  // --- P: プローブ集合で1回 ---
  const probe = runSearch(PLACE_TYPE_PROBE_SET);
  const probeIds = {};
  probe.ids.forEach(function(id) { probeIds[id] = true; });

  // --- U: 頻度別グループ(A/B/C/D)。20件に達したグループはタイプ分割まで ---
  const unionIds = {};
  for (let g = 0; g < BASE_TYPE_GROUPS.length; g++) {
    const groupTypes = BASE_TYPE_GROUPS[g];
    const groupResult = runSearch(groupTypes);
    groupResult.ids.forEach(function(id) { unionIds[id] = true; });

    if (groupResult.count >= 20) {
      const subGroups = splitTypeGroupForDenseArea(groupTypes);
      for (let s = 0; s < subGroups.length; s++) {
        const subResult = runSearch(subGroups[s]);
        subResult.ids.forEach(function(id) { unionIds[id] = true; });
      }
    }
  }

  writer.flush();

  const uMinusP = Object.keys(unionIds).filter(function(id) { return !probeIds[id]; });
  const pMinusU = Object.keys(probeIds).filter(function(id) { return !unionIds[id]; });

  const logPlace = function(id) {
    const p = placesById[id];
    Logger.log(
      '  id=' + id +
      ' / displayName=' + (p && p.displayName ? p.displayName.text : '') +
      ' / primaryType=' + (p ? (p.primaryType || '') : '') +
      ' / types=' + (p && p.types ? p.types.join(', ') : '')
    );
  };

  Logger.log('===== プローブ集合 vs タイプグループ 比較(グリッドID ' + targetGridId + ') =====');
  Logger.log(
    'APIコール回数: ' + callCount +
    ' / |P|(プローブ)=' + Object.keys(probeIds).length +
    ' / |U|(A/B/C/D)=' + Object.keys(unionIds).length
  );

  Logger.log('U \\ P (' + uMinusP.length + '件): プローブ集合が取りこぼした可能性がある店');
  uMinusP.forEach(logPlace);
  Logger.log('P \\ U (' + pMinusU.length + '件): プローブ集合だけが見つけた店(前提が正しければ通常は空)');
  pMinusU.forEach(logPlace);

  if (Object.keys(probeIds).length === 20) {
    Logger.log(
      '注意: プローブ集合の結果がちょうど20件(壁)です。この場合、差分が被覆漏れによるものか' +
      '20件の壁による切り捨てによるものか区別できません。別の密集していないグリッドで再実行してください。'
    );
  }
}
