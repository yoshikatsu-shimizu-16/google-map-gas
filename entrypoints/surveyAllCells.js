/**
 * [エントリーポイント/調査用]
 * 全マスに傘型プローブを1コールずつ投げ、密度とタイプの実態を Pro枠で洗い出す。
 *
 * ねらい: 最適なアルゴリズムを机上で決めるのをやめ、実データから決める。
 * ここで集めるのは次の3つで、いずれも営業用の Enterprise枠を使わずに得られる。
 *
 *   1. マスごとの正確な店舗数 … 20件未満なら実数、20件なら「要分割」が確定する。
 *      OpenStreetMap による密度推定は的中率2.6%で使い物にならなかった(2026-09-20)。
 *      Google 自身に聞けば、その推定そのものが要らなくなる。
 *   2. 本当に空のマス … 探索対象から恒久的に外せるかを Google の答えで判断する。
 *   3. タイプの実測 … 1マス最大20件ぶんの types が集まる。全域で数千件になり、
 *      「166種のうちこの地域に実在するのは何種か」をカタログ刈り込みの根拠にできる。
 *
 * コスト: Pro段(PLACE_SURVEY_FIELD_MASK)なので **Enterprise枠(営業用の1,000/月)を
 * 1コールも消費しない**。1マス1コール固定で、飽和しても分割や再検索はしない
 * (ここで知りたいのは「20件を超えるか」までで、超えた先の内訳は分割方式を決めてから
 *  取りに行けばよい)。
 *
 * 安全性:
 *   - 「全飲食店データ」にも「グリッド一覧」にも書き込まない。Pro段には rating も
 *     websiteUri も無いため、本番シートに入れると評価とHPが空の行ができる。その行は
 *     Place ID で重複除去されるので、本番クロールが二度とその店の営業データを取りに
 *     行かなくなる。
 *   - 何度実行しても、まだ調査していないマスだけを続きから処理する(冪等・再開可能)。
 *   - SURVEY_MAX_CALLS に 0 を設定すると、消費予定のコール数を報告するだけで終わる。
 *
 * @returns {void}
 */
function surveyAllCells() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // GASの実行時間上限(6分)に対する安全マージン
  // シートへの書き出し間隔。1マスごとに書くとラウンドトリップが実行時間を食い、
  // 6分の制限内に回せるAPIコール数が減る。逆に大きくしすぎると、想定外の例外で
  // 落ちたときに失う成果が増える。100マスなら書き出しは実行あたり数回で済み、
  // 失っても再実行で取り直せる範囲に収まる。
  const FLUSH_EVERY = 100;

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

  Logger.log('===== 全マスの密度・タイプ調査(Pro段・営業用の枠は使いません) =====');

  const sheets = ensureAreaSurveySheets(spreadsheet);
  const surveyedCellIds = readSurveyedCellIds(sheets.cells);

  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();
  const targets = gridValues
    .filter(function(row) { return !surveyedCellIds.has(row[0]); })
    .map(function(row) {
      return { gridId: row[0], lat: row[1], lng: row[2], radius: row[3], tier: row[5] || 0 };
    });

  Logger.log('グリッド総数: ' + gridValues.length + ' / 調査済み: ' + surveyedCellIds.size);
  if (targets.length === 0) {
    Logger.log('未調査のマスはありません。全マスの調査が完了しています。');
    reportAreaSurveyFindings(sheets);
    return;
  }

  const plannedCalls = maxCalls === null ? targets.length : Math.min(targets.length, maxCalls);
  if (plannedCalls === 0) {
    Logger.log('未調査: ' + targets.length + 'マス / 実行すれば ' + targets.length +
      ' コール消費します(1マス1コール、すべてPro段)');
    Logger.log(SURVEY_MAX_CALLS_PROP + ' が 0 のため、ここで終了します。Googleへのリクエストは発生していません。');
    return;
  }
  Logger.log('未調査: ' + targets.length + 'マス / 今回消費するコール数: ' + plannedCalls +
    '(1マス1コール、すべてPro段)');

  const cellRows = [];
  const placeRows = [];
  let surveyed = 0, empty = 0, saturatedCells = 0, failed = 0, placesFound = 0;
  let stoppedReason = '';

  // 書き出し位置はメモリ上で進める。flush のたびに getLastRow() を呼ぶと、
  // 書き込みとは別にラウンドトリップが1往復増える(このスクリプト以外がシートに
  // 追記することはないので、位置は自分で数えていれば足りる)。
  let nextCellRow = sheets.cells.getLastRow() + 1;
  let nextPlaceRow = sheets.places.getLastRow() + 1;

  /** 溜まった行をシートへ書き出す。中断されても成果を残すため途中でも呼ぶ。 */
  const flush = function() {
    if (cellRows.length > 0) {
      sheets.cells.getRange(nextCellRow, 1, cellRows.length, AREA_SURVEY_CELL_HEADERS.length)
        .setValues(cellRows);
      nextCellRow += cellRows.length;
      cellRows.length = 0;
    }
    if (placeRows.length > 0) {
      sheets.places.getRange(nextPlaceRow, 1, placeRows.length, AREA_SURVEY_PLACE_HEADERS.length)
        .setValues(placeRows);
      nextPlaceRow += placeRows.length;
      placeRows.length = 0;
    }
  };

  for (let i = 0; i < plannedCalls; i++) {
    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      stoppedReason = '実行時間の上限に近づいたため中断しました。再実行すると続きから調査します。';
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
      failed++;
      cellRows.push(toAreaSurveyCellRow(cell, -1, 'エラー'));
      continue;
    }

    const found = result.places.length;
    const saturated = found >= 20;
    surveyed++;
    placesFound += found;
    if (found === 0) empty++;
    if (saturated) saturatedCells++;

    cellRows.push(toAreaSurveyCellRow(cell, found, saturated ? '飽和(20件以上)' : ''));
    result.places.forEach(function(place) {
      placeRows.push([
        cell.gridId,
        place.id || '',
        place.displayName ? place.displayName.text : '',
        place.primaryType || '',
        place.types ? place.types.join(', ') : ''
      ]);
    });

    if ((i + 1) % FLUSH_EVERY === 0) flush();
  }
  flush();

  Logger.log('--- 今回の調査 ---');
  Logger.log('調査したマス: ' + surveyed + ' / 0件: ' + empty +
    ' / 飽和(20件以上): ' + saturatedCells + ' / エラー: ' + failed);
  Logger.log('取得した店: ' + placesFound + '件');
  if (stoppedReason) Logger.log('→ ' + stoppedReason);

  reportAreaSurveyFindings(sheets);
}

/** マス単位の記録。密度マップの素になる。 */
const AREA_SURVEY_CELL_HEADERS = [
  'グリッドID', '中心緯度', '中心経度', '半径m', '階層', '取得件数', '備考', '確認日時'
];

/** 店単位の記録。タイプの実測データとしてカタログ刈り込みの根拠になる。 */
const AREA_SURVEY_PLACE_HEADERS = [
  'グリッドID', 'Place ID', '店名', '主タイプ', '全タイプ'
];

/**
 * 調査用シート2枚を用意する。マス単位と店単位で行の粒度が違うため分けている。
 * @param {Spreadsheet} spreadsheet
 * @returns {{cells: Sheet, places: Sheet}}
 */
function ensureAreaSurveySheets(spreadsheet) {
  return {
    cells: ensureSheetWithHeaders(spreadsheet, '調査(マス)', AREA_SURVEY_CELL_HEADERS),
    places: ensureSheetWithHeaders(spreadsheet, '調査(店)', AREA_SURVEY_PLACE_HEADERS)
  };
}

/**
 * 指定名のシートを取得する(無ければヘッダー付きで作る)。
 * @param {Spreadsheet} spreadsheet
 * @param {string} name
 * @param {string[]} headers
 * @returns {Sheet}
 */
function ensureSheetWithHeaders(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 調査済みのグリッドIDを読む。再実行時に同じマスを二度叩かないため。
 * @param {Sheet} cellSheet
 * @returns {Set<number>}
 */
function readSurveyedCellIds(cellSheet) {
  const ids = new Set();
  const lastRow = cellSheet.getLastRow();
  if (lastRow < 2) return ids;
  cellSheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row) {
    if (row[0] !== '' && row[0] !== null) ids.add(row[0]);
  });
  return ids;
}

/**
 * マス単位の1行を組み立てる。
 * @param {{gridId: number, lat: number, lng: number, radius: number, tier: number}} cell
 * @param {number} foundCount - 取得件数(エラー時は -1)
 * @param {string} note
 * @returns {Array}
 */
function toAreaSurveyCellRow(cell, foundCount, note) {
  return [
    cell.gridId, cell.lat, cell.lng, cell.radius, cell.tier,
    foundCount < 0 ? '' : foundCount, note, new Date()
  ];
}

/**
 * これまでに集まった調査データから、アルゴリズムを決めるための数字を出す。
 * 実行のたびに最新の全件で集計し直すので、途中経過でも傾向が読める。
 *
 * @param {{cells: Sheet, places: Sheet}} sheets
 * @returns {void}
 */
function reportAreaSurveyFindings(sheets) {
  reportAreaSurveyDensity(sheets.cells);
  reportAreaSurveyTypes(sheets.places);
}

/**
 * マスごとの店舗数の分布を出す。20件が1コールの上限なので、そこを境にコストが変わる。
 * @param {Sheet} cellSheet
 * @returns {void}
 */
function reportAreaSurveyDensity(cellSheet) {
  const lastRow = cellSheet.getLastRow();
  if (lastRow < 2) return;

  const countCol = AREA_SURVEY_CELL_HEADERS.indexOf('取得件数') + 1;
  const counts = cellSheet.getRange(2, countCol, lastRow - 1, 1).getValues()
    .map(function(row) { return row[0]; })
    .filter(function(v) { return v !== '' && v !== null; });
  if (counts.length === 0) return;

  const buckets = [
    { label: '0件(探索不要)      ', test: function(n) { return n === 0; } },
    { label: '1〜4件             ', test: function(n) { return n >= 1 && n <= 4; } },
    { label: '5〜19件(1コールで足りる)', test: function(n) { return n >= 5 && n <= 19; } },
    { label: '20件以上(要分割)   ', test: function(n) { return n >= 20; } }
  ];
  Logger.log('--- 累計: マスごとの店舗数の分布(' + counts.length + 'マス) ---');
  buckets.forEach(function(b) {
    const n = counts.filter(b.test).length;
    Logger.log('  ' + b.label + ': ' + n + 'マス (' + (n / counts.length * 100).toFixed(1) + '%)');
  });
}

/**
 * 集まったタイプの実測から、プローブ集合の被覆率と最小被覆集合を出す。
 * カタログ(166種)のうち何種が実在するかも報告する。刈り込みの判断材料。
 *
 * 集計そのものは lib/catalog/PlaceTypeCoverageAnalysis.js の純関数を使う
 * (entrypoints/auditProbeSetCoverage.js と同じロジック。母集団が違うだけ)。
 *
 * @param {Sheet} placeSheet
 * @returns {void}
 */
function reportAreaSurveyTypes(placeSheet) {
  const lastRow = placeSheet.getLastRow();
  if (lastRow < 2) return;

  const typesCol = AREA_SURVEY_PLACE_HEADERS.indexOf('全タイプ') + 1;
  const typeRows = placeSheet.getRange(2, typesCol, lastRow - 1, 1).getValues()
    .map(function(row) { return parsePlaceTypesCell(row[0]); })
    .filter(function(types) { return types.length > 0; });
  if (typeRows.length === 0) return;

  const summary = summarizeProbeCoverage(typeRows, PLACE_TYPE_PROBE_SET, ALL_SEARCHABLE_PLACE_TYPES);
  const observedCatalogTypes = ALL_SEARCHABLE_PLACE_TYPES.length - summary.catalogTypesNeverObserved.length;

  Logger.log('--- 累計: タイプの実測(' + typeRows.length + '件の店) ---');
  Logger.log('  現行プローブ集合の被覆率: ' + summary.coveredCount + '/' + typeRows.length +
    ' (' + (summary.coveredCount / typeRows.length * 100).toFixed(1) + '%)');
  Logger.log('  カタログ166種のうち実在が確認できたもの: ' + observedCatalogTypes + '種' +
    ' / 1度も出現しないもの: ' + summary.catalogTypesNeverObserved.length + '種');

  const cover = findMinimalProbeCover(typeRows, ALL_SEARCHABLE_PLACE_TYPES, INCLUDED_TYPES_MAX_PER_REQUEST);
  Logger.log('  最小被覆集合(貪欲法):');
  let cumulative = 0;
  cover.cover.forEach(function(entry, index) {
    cumulative += entry.newlyCovered;
    Logger.log('    ' + (index + 1) + '. ' + entry.type + ' (+' + entry.newlyCovered +
      ' / 累計 ' + (cumulative / typeRows.length * 100).toFixed(1) + '%)');
  });
  if (cover.uncoveredRowIndexes.length > 0) {
    Logger.log('    ※ ' + cover.uncoveredRowIndexes.length +
      '件は Table A のタイプを持たないため includedTypes では拾えません。');
  }
}
