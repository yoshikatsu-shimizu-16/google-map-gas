/**
 * [エントリーポイント/調査用]
 * OpenStreetMap が「飲食店0件」と見ているセルを、Pro段のフィールド指定で1コールずつ実地確認する。
 *
 * ねらい: 2026-09-20 時点の OSM では 374マス中 180マス(48%)に飲食系POIが1件も無い。
 * ここを恒久的に探索対象から外せれば、その分のコールがまるごと不要になる。ただし OSM の
 * 網羅性は Google に劣るため、OSM が0件でも Google では店が返る可能性がある。捨てる前に
 * 必ずここで裏を取る。
 *
 * コスト: Pro段(PLACE_SURVEY_FIELD_MASK)なので **Enterprise枠(営業用の1,000/月)を消費しない**。
 * Pro枠は 5,000/月 あり、180マスを1コールずつ見ても3.6%しか使わない。
 *
 * 安全性:
 *   - 「全飲食店データ」にも「グリッド一覧」にも書き込まない。結果は「調査ログ」シートのみ
 *   - 何度実行しても、まだ調査していないセルだけを続きから処理する(冪等・再開可能)
 *   - 1セル1コール。タイプ分割も四分木分割もしない(空かどうかを見るだけなので不要)
 *
 * 読み方: 「空でない」が多く出るようなら OSM は当てにならないということなので、
 * 0件マスの除外は断念する。「空(確認済み)」がほぼ全てなら、除外してよい。
 *
 * @returns {void}
 */
function surveyEmptyCells() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // GASの実行時間上限(6分)に対する安全マージン

  const scriptProps = PropertiesService.getScriptProperties();
  const apiKey = scriptProps.getProperty('GOOGLE_MAPS_API_KEY');
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。先に generateGridList を実行してください。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  const gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    Logger.log('グリッド一覧シートがありません。先に generateGridList を実行してください。');
    return;
  }
  const gridLastRow = gridSheet.getLastRow();
  if (gridLastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }

  Logger.log('===== 0件予測セルの実地確認(Pro段・営業用の枠は使いません) =====');

  // --- 1. OSM から飲食系POIを取得(Googleのクォータは消費しない) ---
  const osm = fetchOsmFoodPois(TARGET_AREA_BOUNDS);
  if (!osm.ok) {
    Logger.log('OpenStreetMap の取得に失敗しました: ' + osm.errorText);
    return;
  }
  Logger.log('OSM 飲食系POI: ' + osm.pois.length + '件');

  // --- 2. 調査ログシートを用意し、調査済みのグリッドIDを読む ---
  const logSheet = ensureSurveyLogSheet(spreadsheet);
  const surveyedGridIds = readSurveyedGridIds(logSheet);

  // --- 3. 対象セルを選ぶ: 円の中に OSM のPOIが1件も無いセル ---
  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();
  const targets = [];
  gridValues.forEach(function(row) {
    const gridId = row[0];
    if (surveyedGridIds.has(gridId)) return; // 調査済み
    const lat = row[1], lng = row[2], radius = row[3];
    // 実際の検索は矩形を覆う円で行い、円は隣のセルにはみ出す。矩形ではなく円で数える。
    const osmCount = countPoisWithinRadius(osm.pois, lat, lng, radius);
    if (osmCount > 0) return; // OSM が店を知っている = 空ではないので確認するまでもない
    targets.push({ gridId: gridId, lat: lat, lng: lng, radius: radius });
  });

  if (targets.length === 0) {
    Logger.log('確認が必要な0件予測セルはありません(すべて調査済み、またはOSMが店を知っています)。');
    return;
  }
  Logger.log('確認対象: ' + targets.length + 'セル。1セル1コールで確認します。');

  // --- 4. 1セル1コールで確認する ---
  const rows = [];
  let emptyConfirmed = 0;
  let notEmpty = 0;
  let stoppedReason = '';

  for (let i = 0; i < targets.length; i++) {
    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      stoppedReason = '実行時間の上限に近づいたため中断しました。再実行すると続きから確認します。';
      break;
    }
    const cell = targets[i];
    const result = callSearchNearby(
      apiKey, PLACE_SURVEY_FIELD_MASK, PLACE_TYPE_PROBE_SET, cell.lat, cell.lng, cell.radius);

    if (!result.ok) {
      if (result.quotaExceeded) {
        stoppedReason = '利用上限に達したため中断しました: ' + result.errorText;
        break;
      }
      rows.push(toSurveyRow(cell, -1, 'エラー', result.errorText.slice(0, 200)));
      continue;
    }

    const found = result.places.length;
    if (found === 0) {
      emptyConfirmed++;
      rows.push(toSurveyRow(cell, 0, '空(確認済み)', ''));
    } else {
      notEmpty++;
      rows.push(toSurveyRow(cell, found, '空でない', summarizePlaces(result.places)));
    }
  }

  // --- 5. 書き出しと集計 ---
  if (rows.length > 0) {
    logSheet.getRange(logSheet.getLastRow() + 1, 1, rows.length, SURVEY_LOG_HEADERS.length).setValues(rows);
  }

  const judged = emptyConfirmed + notEmpty;
  Logger.log(
    '今回の確認: ' + rows.length + 'セル / 空(確認済み): ' + emptyConfirmed +
    ' / 空でない: ' + notEmpty +
    (judged > 0 ? ' / OSMの予測が当たった率: ' + (emptyConfirmed / judged * 100).toFixed(1) + '%' : '')
  );
  Logger.log('未確認の残り: ' + Math.max(targets.length - rows.length, 0) + 'セル');
  if (stoppedReason) Logger.log('→ ' + stoppedReason);
  if (notEmpty > 0) {
    Logger.log('「空でない」が出ています。OSMの0件だけを根拠にセルを除外するのは危険です。');
  }
}

/** 調査ログシートの列。判定の根拠を後から追えるよう、件数と中身の要約も残す。 */
const SURVEY_LOG_HEADERS = [
  'グリッドID', '中心緯度', '中心経度', '半径m', 'Google件数', '判定', '備考', '確認日時'
];

/**
 * 調査ログシートを取得する(無ければヘッダー付きで作る)。
 * @param {Spreadsheet} spreadsheet
 * @returns {Sheet}
 */
function ensureSurveyLogSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName('調査ログ');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('調査ログ');
    sheet.appendRow(SURVEY_LOG_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 調査済みのグリッドIDを読む。再実行時に同じセルへ二度コールしないため。
 * @param {Sheet} logSheet
 * @returns {Set<number>}
 */
function readSurveyedGridIds(logSheet) {
  const ids = new Set();
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return ids;
  logSheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row) {
    if (row[0] !== '' && row[0] !== null) ids.add(row[0]);
  });
  return ids;
}

/**
 * 調査ログの1行を組み立てる。
 * @param {{gridId: number, lat: number, lng: number, radius: number}} cell
 * @param {number} foundCount - 取得件数(エラー時は -1)
 * @param {string} judgement
 * @param {string} note
 * @returns {Array}
 */
function toSurveyRow(cell, foundCount, judgement, note) {
  return [
    cell.gridId, cell.lat, cell.lng, cell.radius,
    foundCount < 0 ? '' : foundCount, judgement, note, new Date()
  ];
}

/**
 * 「空でない」と判定されたセルの中身を、あとで目視できる程度に要約する。
 * @param {Object[]} places
 * @returns {string}
 */
function summarizePlaces(places) {
  return places.slice(0, 5).map(function(p) {
    return (p.displayName ? p.displayName.text : p.id) + '(' + (p.primaryType || '') + ')';
  }).join(' / ');
}
