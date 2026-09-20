/**
 * [エントリーポイント/調査用]
 * 飽和したマス(20件以上)を4分割した子マスに、プローブを1コールずつ投げて深さを測る。
 *
 * ねらい: surveyAllCells で 638マス中 220マス(34.5%)が飽和と分かった。飽和マスの
 * 扱い方でコストが大きく変わるが、どちらが安いかは「4分割で足りるか」で決まる。
 *
 *   タイプ分割(現行) … 4(A/B/C/D) + 7(グループAの細分化) = 11コール
 *   4分割           … 1(親のプローブ) + 4(子のプローブ) = 5コール
 *                      ただし子がまだ飽和するなら孫16個で +16コール
 *
 * 20件以上としか分からない状態では選べないので、ここで1段掘って確かめる。
 *
 * コスト: Pro段なので **Enterprise枠(営業用)を消費しない**。飽和マス1つにつき4コール。
 *
 * 安全性: 「グリッド一覧」に子グリッドを追加しない。本番の進捗を変えずに測るのが目的で、
 * 追加すると crawlAllGrids が営業用の枠でそれを処理してしまう。座標は計算するだけで、
 * 結果は「調査(子マス)」シートにのみ書く。
 *
 * 再実行すると未調査の親マスから続きから進む。親マス単位で4件まとめて記録するので、
 * 途中で止まっても中途半端な親は残らない(次回やり直される)。
 *
 * @returns {void}
 */
function surveySaturatedCells() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000;
  const FLUSH_EVERY_PARENTS = 25;

  const scriptProps = PropertiesService.getScriptProperties();
  const maxCalls = readSurveyMaxCalls(scriptProps);
  const apiKey = scriptProps.getProperty('GOOGLE_MAPS_API_KEY');
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。先に generateGridList を実行してください。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  const cellSheet = spreadsheet.getSheetByName('調査(マス)');
  if (!cellSheet || cellSheet.getLastRow() < 2) {
    Logger.log('「調査(マス)」がありません。先に surveyAllCells を実行してください。');
    return;
  }

  Logger.log('===== 飽和マスの深さ調査(Pro段・営業用の枠は使いません) =====');

  const childSheet = ensureSheetWithHeaders(spreadsheet, '調査(子マス)', SATURATED_CHILD_HEADERS);
  const doneParentIds = readSurveyedParentIds(childSheet);
  const parents = readSaturatedParents(cellSheet).filter(function(p) { return !doneParentIds.has(p.gridId); });

  Logger.log('飽和マス: ' + (parents.length + doneParentIds.size) + ' / 調査済み: ' + doneParentIds.size);
  if (parents.length === 0) {
    Logger.log('未調査の飽和マスはありません。');
    reportSaturatedChildDepth(childSheet);
    return;
  }

  const callsPerParent = CHILD_CELLS_PER_PARENT;
  const affordableParents = maxCalls === null
    ? parents.length
    : Math.floor(maxCalls / callsPerParent);
  if (affordableParents === 0) {
    Logger.log('未調査: ' + parents.length + '親マス / 実行すれば ' +
      (parents.length * callsPerParent) + ' コール消費します(親1つにつき子4コール、すべてPro段)');
    Logger.log(SURVEY_MAX_CALLS_PROP + ' が ' + maxCalls +
      ' のため、ここで終了します(親1つに4コール必要なので刻むなら4の倍数で指定してください)。');
    return;
  }
  const plannedParents = Math.min(parents.length, affordableParents);
  Logger.log('未調査: ' + parents.length + '親マス / 今回消費するコール数: ' +
    (plannedParents * callsPerParent) + '(親' + plannedParents + '個 × 子4コール、すべてPro段)');

  const rows = [];
  let nextRow = childSheet.getLastRow() + 1;
  let surveyedParents = 0, resolvedParents = 0, stillSaturatedChildren = 0;
  let stoppedReason = '';

  const flush = function() {
    if (rows.length === 0) return;
    childSheet.getRange(nextRow, 1, rows.length, SATURATED_CHILD_HEADERS.length).setValues(rows);
    nextRow += rows.length;
    rows.length = 0;
  };

  for (let i = 0; i < plannedParents; i++) {
    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      stoppedReason = '実行時間の上限に近づいたため中断しました。再実行すると続きから調査します。';
      break;
    }
    const parent = parents[i];
    // 親のセルサイズは記録していないので、保存済みの半径から逆算する
    // (cellCoverRadiusMeters の逆関数。誤差0.5%以内であることは検証済み)。
    const parentCellSizeDeg = cellSizeDegFromCoverRadius(parent.radius, parent.lat);
    const children = childCellsOf(parent.lat, parent.lng, parentCellSizeDeg);

    const parentRows = [];
    let quotaHit = false;
    let saturatedChildren = 0;
    for (let c = 0; c < children.length; c++) {
      const child = children[c];
      const result = callSearchNearby(
        apiKey, PLACE_SURVEY_FIELD_MASK, PLACE_TYPE_PROBE_SET, child.lat, child.lng, child.radius);
      if (!result.ok) {
        if (result.quotaExceeded) {
          quotaHit = true;
          stoppedReason = '利用上限に達したため中断しました: ' + result.errorText;
          break;
        }
        parentRows.push(toSaturatedChildRow(parent, child, -1, 'エラー'));
        continue;
      }
      const found = result.places.length;
      if (found >= 20) saturatedChildren++;
      parentRows.push(toSaturatedChildRow(parent, child, found, found >= 20 ? '飽和(20件以上)' : ''));
    }
    if (quotaHit) break; // この親は記録しない(次回まるごとやり直す)

    rows.push.apply(rows, parentRows);
    surveyedParents++;
    stillSaturatedChildren += saturatedChildren;
    if (saturatedChildren === 0) resolvedParents++;

    if (surveyedParents % FLUSH_EVERY_PARENTS === 0) flush();
  }
  flush();

  Logger.log('--- 今回の調査 ---');
  Logger.log('調査した親マス: ' + surveyedParents +
    ' / 4分割で解決: ' + resolvedParents +
    ' / まだ飽和している子マス: ' + stillSaturatedChildren);
  if (stoppedReason) Logger.log('→ ' + stoppedReason);

  reportSaturatedChildDepth(childSheet);
}

/** 子マス単位の記録。親ごとに4行が並ぶ。 */
const SATURATED_CHILD_HEADERS = [
  '親グリッドID', '象限', '中心緯度', '中心経度', '半径m', '取得件数', '備考', '確認日時'
];

/**
 * 「調査(マス)」から飽和した(20件以上の)マスを読む。
 * @param {Sheet} cellSheet
 * @returns {Array<{gridId: number, lat: number, lng: number, radius: number}>}
 */
function readSaturatedParents(cellSheet) {
  const lastRow = cellSheet.getLastRow();
  const values = cellSheet.getRange(2, 1, lastRow - 1, AREA_SURVEY_CELL_HEADERS.length).getValues();
  const idIdx = AREA_SURVEY_CELL_HEADERS.indexOf('グリッドID');
  const latIdx = AREA_SURVEY_CELL_HEADERS.indexOf('中心緯度');
  const lngIdx = AREA_SURVEY_CELL_HEADERS.indexOf('中心経度');
  const radiusIdx = AREA_SURVEY_CELL_HEADERS.indexOf('半径m');
  const countIdx = AREA_SURVEY_CELL_HEADERS.indexOf('取得件数');

  return values
    .filter(function(row) { return row[countIdx] !== '' && row[countIdx] >= 20; })
    .map(function(row) {
      return { gridId: row[idIdx], lat: row[latIdx], lng: row[lngIdx], radius: row[radiusIdx] };
    });
}

/**
 * 調査済みの親グリッドIDを読む。再実行時に同じ親を二度叩かないため。
 * @param {Sheet} childSheet
 * @returns {Set<number>}
 */
function readSurveyedParentIds(childSheet) {
  const ids = new Set();
  const lastRow = childSheet.getLastRow();
  if (lastRow < 2) return ids;
  childSheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row) {
    if (row[0] !== '' && row[0] !== null) ids.add(row[0]);
  });
  return ids;
}

/**
 * 子マス1件の記録行を組み立てる。
 * @param {{gridId: number}} parent
 * @param {{label: string, lat: number, lng: number, radius: number}} child
 * @param {number} foundCount - 取得件数(エラー時は -1)
 * @param {string} note
 * @returns {Array}
 */
function toSaturatedChildRow(parent, child, foundCount, note) {
  return [
    parent.gridId, child.label, child.lat, child.lng, child.radius,
    foundCount < 0 ? '' : foundCount, note, new Date()
  ];
}

/**
 * 集まった子マスの密度から、4分割で足りるのかを報告する。
 * これが分かると、飽和マスをタイプ分割(11コール)と空間分割(5コール)のどちらで
 * 処理すべきかが決まる。
 *
 * @param {Sheet} childSheet
 * @returns {void}
 */
function reportSaturatedChildDepth(childSheet) {
  const lastRow = childSheet.getLastRow();
  if (lastRow < 2) return;

  const values = childSheet.getRange(2, 1, lastRow - 1, SATURATED_CHILD_HEADERS.length).getValues();
  const parentIdx = SATURATED_CHILD_HEADERS.indexOf('親グリッドID');
  const countIdx = SATURATED_CHILD_HEADERS.indexOf('取得件数');

  const counts = values.map(function(r) { return r[countIdx]; }).filter(function(v) { return v !== '' && v !== null; });
  if (counts.length === 0) return;

  const buckets = [
    { label: '0件            ', test: function(n) { return n === 0; } },
    { label: '1〜19件(解決)   ', test: function(n) { return n >= 1 && n <= 19; } },
    { label: '20件以上(まだ飽和)', test: function(n) { return n >= 20; } }
  ];
  Logger.log('--- 累計: 飽和マスを4分割した子マスの分布(' + counts.length + 'マス) ---');
  buckets.forEach(function(b) {
    const n = counts.filter(b.test).length;
    Logger.log('  ' + b.label + ': ' + n + 'マス (' + (n / counts.length * 100).toFixed(1) + '%)');
  });

  // 親単位で「4分割で解決したか」を数える。1つでも飽和した子が残れば未解決。
  const saturatedByParent = {};
  values.forEach(function(r) {
    const parentId = r[parentIdx];
    if (saturatedByParent[parentId] === undefined) saturatedByParent[parentId] = 0;
    if (r[countIdx] !== '' && r[countIdx] >= 20) saturatedByParent[parentId]++;
  });
  const parentIds = Object.keys(saturatedByParent);
  const resolved = parentIds.filter(function(id) { return saturatedByParent[id] === 0; }).length;

  Logger.log('  4分割で解決した親マス: ' + resolved + '/' + parentIds.length +
    ' (' + (resolved / parentIds.length * 100).toFixed(1) + '%)');
  Logger.log('  → 解決した親は 1+4=5コール。残りはさらに分割が要る(孫16個で +16コール)。');
  Logger.log('  参考: 現行のタイプ分割は飽和マス1つにつき 4+7=11コール。');
}
