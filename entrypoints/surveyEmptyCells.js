/**
 * [エントリーポイント/調査用]
 * OpenStreetMap が「飲食店0件」と見ているセルを、Pro段のフィールド指定で1コールずつ実地確認する。
 *
 * ねらい: OSM では 374マス中 154マスの検索円に飲食系POIが1件も無い。ここを恒久的に
 * 探索対象から外せれば、その分のコールがまるごと不要になる。ただし OSM の網羅性は
 * Google に劣るため、OSM が0件でも Google では店が返る可能性がある。捨てる前に
 * 必ずここで裏を取る。
 *
 * 対象セルの一覧は lib/survey/EmptyCellPrediction.js(自動生成)から読む。OSM の取得は
 * ローカルで済ませてある。Apps Script の UrlFetchApp からは overpass-api.de へ到達できず
 * ("Address unavailable")、この関数は実行時にネットワークへ出ない。
 *
 * コスト: Pro段(PLACE_SURVEY_FIELD_MASK)なので **Enterprise枠(営業用の1,000/月)を消費しない**。
 * 1セルにつき必ず1コールで、タイプ分割も四分木分割もしない(空かどうかを見るだけなので不要)。
 * したがって消費するコール数は「確認対象のセル数」と完全に一致する。
 *
 * 叩く前に件数を知りたい場合は、スクリプトプロパティ SURVEY_MAX_CALLS に 0 を設定して
 * 実行する(lib/survey/SurveyCallBudget.js)。対象セル数を数えて報告するだけで、
 * Google へのリクエストは1件も発生しない。
 *
 * 安全性:
 *   - 「全飲食店データ」にも「グリッド一覧」にも書き込まない。結果は「調査ログ」シートのみ
 *   - 何度実行しても、まだ調査していないセルだけを続きから処理する(冪等・再開可能)
 *   - 1セル1コール。タイプ分割も四分木分割もしない(空かどうかを見るだけなので不要)
 *
 * 読み方: 「空でない」が多く出るようなら OSM は当てにならないということなので、
 * 0件マスの除外は断念する。「空(確認済み)」がほぼ全てなら、除外してよい。
 *
 * あわせて、既にクロール済みのセルを使った答え合わせも出す(APIコール0)。予測が0件と
 * 言ったセルのうち既に探索が済んでいるものは、Googleでの結果がシートに残っている。
 * ステータスが GRID_STATUS_EMPTY_BY_GROUP_A なら「Googleでも見つからなかった」で予測が
 * 当たり、それ以外なら店が見つかっていたので外れ。コールを1回も使わずに OSM の
 * 信頼度が分かるため、76コールを使う前にこの数字を見て判断できる。
 *
 * @returns {void}
 */
function surveyEmptyCells() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // GASの実行時間上限(6分)に対する安全マージン

  const scriptProps = PropertiesService.getScriptProperties();
  const maxCalls = readSurveyMaxCalls(scriptProps);
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

  // --- 1. 予測一覧が現在のグリッド定義と整合するか確かめる ---
  // グリッドIDは対象範囲とセルサイズから採番される。どちらかを変えたあとに
  // 予測を再生成していないと、まったく別のセルを飛ばすことになる。
  if (!isEmptyCellPredictionCurrent()) {
    Logger.log(
      '予測一覧(lib/survey/EmptyCellPrediction.js)が現在のグリッド定義と一致しません。' +
      'node tools/generateEmptyCellPrediction.js で再生成し、clasp push してください。'
    );
    Logger.log('  予測の生成時: ' + JSON.stringify(EMPTY_CELL_PREDICTION_BOUNDS) + ' / ' + EMPTY_CELL_PREDICTION_STEP + '度');
    Logger.log('  現在の設定  : ' + JSON.stringify(TARGET_AREA_BOUNDS) + ' / ' + GRID_STEP + '度');
    return;
  }
  Logger.log('OSMが0件と見たセル: ' + OSM_EMPTY_GRID_IDS.length + '件(予測一覧より)');

  // --- 2. 調査ログシートを用意し、調査済みのグリッドIDを読む ---
  const logSheet = ensureSurveyLogSheet(spreadsheet);
  const surveyedGridIds = readSurveyedGridIds(logSheet);

  // --- 3. 対象セルを選ぶ: 予測一覧にあり、まだ探索も調査もしていないセル ---
  const predictedEmpty = {};
  OSM_EMPTY_GRID_IDS.forEach(function(id) { predictedEmpty[id] = true; });

  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();
  const targets = [];
  const doneStatusCounts = {};
  let skippedDone = 0;
  gridValues.forEach(function(row) {
    const gridId = row[0];
    if (!predictedEmpty[gridId]) return;      // OSM が店を知っている = 確認するまでもない
    if (surveyedGridIds.has(gridId)) return;  // 調査済み
    // 探索が終わったセルは結果が分かっているので調べる必要がない。
    // この調査の目的は「これから探索するセルを飛ばしてよいか」の判断材料を作ること。
    // ただし「結果が分かっている」ことは、予測の答え合わせに使えるということでもある。
    const status = row[GRID_COL_STATUS - 1];
    if (GRID_DONE_STATUSES.indexOf(status) !== -1) {
      doneStatusCounts[status] = (doneStatusCounts[status] || 0) + 1;
      skippedDone++;
      return;
    }
    targets.push({ gridId: gridId, lat: row[1], lng: row[2], radius: row[3] });
  });

  Logger.log('探索済みのため対象外: ' + skippedDone + 'セル(結果が分かっているので調べる必要がない)');
  reportPredictionAccuracyFromExploredCells(doneStatusCounts, skippedDone);
  if (targets.length === 0) {
    Logger.log('確認が必要な0件予測セルはありません(すべて調査済み、またはOSMが店を知っています)。');
    return;
  }

  const plannedCalls = maxCalls === null ? targets.length : Math.min(targets.length, maxCalls);
  if (plannedCalls === 0) {
    // 試算モード。知りたいのは「0コール」ではなく「実行したら何コール要るか」。
    Logger.log('確認対象: ' + targets.length + 'セル / 実行すれば ' + targets.length +
      ' コール消費します(1セル1コール、すべてPro段)');
    Logger.log('SURVEY_MAX_CALLS が 0 のため、ここで終了します。Googleへのリクエストは発生していません。');
    Logger.log('実行するには SURVEY_MAX_CALLS を消すか、使ってよいコール数を設定してください。');
    return;
  }
  Logger.log('確認対象: ' + targets.length + 'セル / 今回消費するコール数: ' + plannedCalls +
    '(1セル1コール、すべてPro段)');

  // --- 4. 1セル1コールで確認する ---
  const rows = [];
  let emptyConfirmed = 0;
  let notEmpty = 0;
  let stoppedReason = '';

  for (let i = 0; i < targets.length; i++) {
    if (maxCalls !== null && rows.length >= maxCalls) {
      stoppedReason = 'SURVEY_MAX_CALLS(' + maxCalls + '件)に達したため中断しました。再実行すると続きから確認します。';
      break;
    }
    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      stoppedReason = '実行時間の上限に近づいたため中断しました。再実行すると続きから確認します。';
      break;
    }
    const cell = targets[i];
    const result = callSearchNearby(
      apiKey, PLACE_SURVEY_FIELD_MASK, PLACE_TYPE_SEARCH_SET, cell.lat, cell.lng, cell.radius);

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

/**
 * 既にクロール済みのセルを使って、OSMの予測がどれだけ当たっていたかを報告する(APIコール0)。
 *
 * 予測が0件と言ったセルのうち探索済みのものは、Googleでの結果がシートに残っている。
 * ステータスが GRID_STATUS_EMPTY_BY_GROUP_A なら「Googleでも見つからなかった」で予測が当たり、
 * それ以外のステータスなら店が見つかっていたので外れ。
 *
 * 注意: GRID_STATUS_EMPTY_BY_GROUP_A は「グループA(頻出39種)が0件」という意味で、
 * B/C/Dは省略されている。稀なタイプだけの店がある可能性は残るため、的中率は
 * やや甘めに出る。それでも「OSMがまったく当てにならない」かどうかの判断には使える。
 *
 * @param {Object<string, number>} doneStatusCounts - 探索済みセルのステータス別件数
 * @param {number} skippedDone - 探索済みセルの総数
 * @returns {void}
 */
function reportPredictionAccuracyFromExploredCells(doneStatusCounts, skippedDone) {
  if (skippedDone === 0) return;

  const agreed = doneStatusCounts[GRID_STATUS_EMPTY_BY_GROUP_A] || 0;
  const disagreed = skippedDone - agreed;
  Logger.log('  [答え合わせ(APIコール0)] 探索済みの' + skippedDone + 'セルでOSMの予測を検証:');
  Logger.log('    Googleでも見つからなかった: ' + agreed + 'セル(予測が当たり)');
  Logger.log('    Googleでは店が見つかった  : ' + disagreed + 'セル(予測が外れ)');
  Logger.log('    → 的中率: ' + (agreed / skippedDone * 100).toFixed(1) + '%');
  if (disagreed > 0) {
    Logger.log('    外れたセルのステータス内訳: ' + JSON.stringify(doneStatusCounts));
  }
  Logger.log('    ※「見つからなかった」はグループA(頻出39種)が0件という意味で、B/C/Dは省略されている。');
  Logger.log('      稀なタイプだけの店が残っている可能性はあるため、的中率はやや甘めに出る。');
}

/**
 * 予測一覧が、現在の対象範囲・セルサイズから採番されたグリッドIDと対応しているかを確かめる。
 * 食い違ったまま使うと、意図とまったく違うセルを飛ばすことになる。
 *
 * @returns {boolean}
 */
function isEmptyCellPredictionCurrent() {
  return EMPTY_CELL_PREDICTION_STEP === GRID_STEP &&
    EMPTY_CELL_PREDICTION_BOUNDS.latMin === TARGET_AREA_BOUNDS.latMin &&
    EMPTY_CELL_PREDICTION_BOUNDS.latMax === TARGET_AREA_BOUNDS.latMax &&
    EMPTY_CELL_PREDICTION_BOUNDS.lngMin === TARGET_AREA_BOUNDS.lngMin &&
    EMPTY_CELL_PREDICTION_BOUNDS.lngMax === TARGET_AREA_BOUNDS.lngMax;
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
