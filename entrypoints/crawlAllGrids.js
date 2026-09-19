/**
 * [エントリーポイント/トリガー]
 * 「グリッド一覧」シートに保存された各座標を1件ずつ処理し、
 * Places API (New) の searchNearby エンドポイントで店舗を検索して
 * 「全飲食店データ」シートに書き込む。
 *
 * 検索戦略(SearchStrategyMode.js で切り替え。既定は type_groups):
 *   - type_groups(旧方式): 頻度別4グループ(A/B/C/D、BASE_TYPE_GROUPS)で無条件に
 *     検索する(lib/crawler/TypeGroupCellSearch.js)。
 *   - probe(新方式): まずプローブ集合(PLACE_TYPE_PROBE_SET)で1回だけ検索し、
 *     20件未満ならそのセルを確定する。20件ちょうど(飽和の疑い)のときだけ
 *     type_groups に完全フォールバックする(lib/crawler/ProbeFirstCellSearch.js)。
 *     飽和セルの挙動は type_groups と完全に同一になり、プローブ1コールが
 *     上乗せされるだけ。
 *
 * 密集エリア対策(20件の壁への対応、いずれの戦略でも共通):
 *   1. いずれかのグループ(またはプローブ)がちょうど20件(maxResultCount)返ってきた
 *      場合、切り捨ての疑いがあるため、そのグループだけを小グループに細分化して
 *      追加検索する(タイプ分割)。密集判定の主犯はほぼ常にグループA(頻出ジャンル)。
 *   2. タイプ分割してもなお20件ちょうど返ってくる小グループがあれば、
 *      階層が MAX_TIER 未満の場合に限り、セル矩形を4象限に等分した子グリッドを
 *      生成して「グリッド一覧」に追加する(次回実行時に自動的に処理される)。
 *   3. 階層が MAX_TIER に達してもまだ20件出る場合は、これ以上の自動化は
 *      行わず「要確認(上限到達)」のステータスを付けて人間の確認に委ねる。
 *
 * その他の特徴:
 *   - GASの実行時間上限(6分)に対応するため、4分30秒経過時点で安全停止する。
 *     未処理のグリッドが残っていれば、再実行することで続きから再開できる
 *     (「処理状況」列が完了ステータスの行はスキップされるため)。
 *   - Place ID をキーに重複除去を行う(隣接グリッド・タイプ分割の重複ヒットに対応)。
 *     シートへの書き込みはグリッド単位でまとめて行う(PlaceRowWriter)。
 *   - Demoキーの1日あたりのクォータ上限(RESOURCE_EXHAUSTED/429)や、自前の月間上限
 *     (checkAndIncrementApiQuota)を検知した場合は、個別グリッドのエラーとして無視せず、
 *     ループ全体を即座に中断する。このとき「処理状況」は更新されないため、
 *     翌日・翌月以降の再実行でそのグリッドから再開される。
 *   - APIコールの内訳(どのグループで何回・何回飽和したか、階層別の消費、プローブの
 *     内訳)をログに出す。タイプカタログの見直しや格子方式の変更を判断するための計測値。
 *
 * @returns {void}
 */
function crawlAllGrids() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // GASの実行時間上限(6分)に対する安全マージン

  const strategy = getSearchStrategy();
  Logger.log('[検索方式] ' + describeSearchStrategy(strategy));

  const scriptProps = PropertiesService.getScriptProperties();
  const apiKey = scriptProps.getProperty('GOOGLE_MAPS_API_KEY');
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  const gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    Logger.log('グリッド一覧シートがありません。先に generateGridList を実行してください。');
    return;
  }
  ensureGridSchemaMigrated(gridSheet); // 旧スキーマの場合、進捗を保持したまま列を追加

  let dataSheet = spreadsheet.getSheetByName('全飲食店データ');
  if (!dataSheet) {
    dataSheet = spreadsheet.insertSheet('全飲食店データ');
    dataSheet.appendRow(PLACE_DATA_HEADERS);
  }
  ensurePlaceDataSchemaMigrated(dataSheet); // 旧スキーマの場合、取得済みの店舗データを保持したまま列を組み替える

  const lastDataRow = dataSheet.getLastRow();
  const existingIds = new Set();
  if (lastDataRow > 1) {
    const idColValues = dataSheet.getRange(2, PLACE_ID_COLUMN, lastDataRow - 1, 1).getValues();
    idColValues.forEach(function(row) {
      if (row[0]) existingIds.add(row[0]);
    });
  }
  const writer = createPlaceRowWriter(dataSheet, existingIds);

  const gridLastRow = gridSheet.getLastRow();
  if (gridLastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }
  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();

  let processedCount = 0;
  let newRowsCount = 0;
  let denseSplitCount = 0;
  let needsReviewCount = 0;
  let nextGridId = gridValues.reduce(function(max, r) { return Math.max(max, r[0]); }, 0) + 1;
  let quotaExceeded = false;

  // --- コール内訳の計測 ---
  const stats = {
    totalCalls: 0,
    baseGroupCalls: [0, 0, 0, 0],      // グループA/B/C/D それぞれのコール数
    baseGroupSaturated: [0, 0, 0, 0],  // うち20件に達した回数
    typeSplitCalls: 0,                 // タイプ分割で消費したコール数
    callsByTier: {},                   // 階層別のコール数
    emptyByGroupA: 0,                  // グループAが0件でB/C/Dを省略したセル数
    probeCalls: 0,                     // プローブ集合でのコール数
    probeEmpty: 0,                     // プローブが0件だったセル数
    probeResolved: 0,                  // プローブ1コールで確定したセル数(0件を含む)
    probeSaturated: 0,                 // プローブが20件で type_groups にフォールバックした回数
    uncoveredPlaces: 0                 // プローブ集合で被覆されなかった新規取得店舗数
  };

  const GROUP_LABEL_INDEX = { A: 0, B: 1, C: 2, D: 3 };

  /**
   * 1セル分の callLog(実際にHTTPリクエストが飛んだ内訳)を stats に畳み込む。
   * 自前の月間上限で手前で止めた分を数えると実績値がずれるため、requestSent の
   * エントリだけを計上する(このチェックは callSearchNearby の戻り値に由来する)。
   * @param {Array<{label: string, requestSent: boolean, placeCount: number}>} callLog
   * @param {number} tier - このセルの階層(階層別コール数の集計キー)
   */
  const foldCallLog = function(callLog, tier) {
    callLog.forEach(function(entry) {
      if (!entry.requestSent) return;
      stats.totalCalls++;
      stats.callsByTier[tier] = (stats.callsByTier[tier] || 0) + 1;
      if (stats.totalCalls % 20 === 0) {
        Logger.log('進捗: 現在 ' + stats.totalCalls + ' 回コール済み');
      }

      if (entry.label === 'split') {
        stats.typeSplitCalls++;
      } else if (entry.label === 'probe') {
        stats.probeCalls++;
      } else {
        const idx = GROUP_LABEL_INDEX[entry.label];
        if (idx !== undefined) {
          stats.baseGroupCalls[idx]++;
          if (entry.placeCount >= 20) stats.baseGroupSaturated[idx]++;
        }
      }
    });
  };

  const DONE_STATUSES = [
    '処理済み', '処理済み(A=0のため省略)', '処理済み(プローブ)',
    '密集(タイプ分割済み)', '密集(分割済み)', '要確認(上限到達)'
  ];

  // 早期リターン: 未処理のグリッドが1件も残っていなければ、API呼び出しをせず終了する
  // (トリガーによる無駄な自動実行のコストを防ぐため)
  const remainingCount = gridValues.filter(function(r) {
    return DONE_STATUSES.indexOf(r[GRID_COL_STATUS - 1]) === -1;
  }).length;
  if (remainingCount === 0) {
    Logger.log('未処理のグリッドはありません。すべて完了済みのため、今回は何もせず終了します。');
    return;
  }
  Logger.log('未処理のグリッド数: ' + remainingCount + '件。処理を開始します。');

  for (let i = 0; i < gridValues.length; i++) {
    const row = gridValues[i];
    const status = row[GRID_COL_STATUS - 1];
    if (DONE_STATUSES.indexOf(status) !== -1) continue; // 完了済みのグリッドはスキップ

    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      Logger.log('実行時間の上限に近づいたため、ここで停止します。続きは再実行してください。');
      break;
    }

    const gridId = row[0];
    const lat = row[1];
    const lng = row[2];
    const radius = row[3];
    const tier = row[5] || 0;
    const cellSizeDeg = row[7] || GRID_STEP;

    const search = { apiKey: apiKey, fieldMask: PLACE_SEARCH_FIELD_MASK, writer: writer };
    const cell = { gridId: gridId, lat: lat, lng: lng, radius: radius };
    const result = strategy === SEARCH_STRATEGY_PROBE
      ? searchCellByProbeSet(search, cell)
      : searchCellByTypeGroups(search, cell);

    foldCallLog(result.callLog, tier);
    newRowsCount += result.newRows;
    stats.uncoveredPlaces += result.uncoveredPlaces.length;
    if (result.emptyByGroupA) stats.emptyByGroupA++;
    if (result.probeResolved) stats.probeResolved++;
    if (result.probeSaturated) stats.probeSaturated++;
    if (result.probeEmpty) stats.probeEmpty++;

    // 中断する場合も、それまでに集めた行は失わないよう先に書き出す
    writer.flush();
    if (result.quotaExceeded) {
      quotaExceeded = true;
      break;
    }

    if (result.fineSaturated) {
      // --- タイプ分割してもまだ20件出るグループがある → セルの四分木分割 ---
      if (tier < MAX_TIER) {
        nextGridId = spawnChildGrids(gridSheet, gridId, lat, lng, cellSizeDeg, tier, nextGridId);
        gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('密集(分割済み)');
        denseSplitCount++;
      } else {
        // これ以上の自動細分化は行わず、人間の目視確認に委ねる
        gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('要確認(上限到達)');
        needsReviewCount++;
      }
    } else if (result.hadFailure) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('エラー');
    } else if (result.emptyByGroupA) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('処理済み(A=0のため省略)');
      processedCount++;
    } else if (result.probeResolved) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('処理済み(プローブ)');
      processedCount++;
    } else if (result.baseSaturated) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('密集(タイプ分割済み)');
      processedCount++;
    } else {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('処理済み');
      processedCount++;
    }
  }

  writer.flush();

  // 出力シートのヘッダー固定とフィルタを整える。フィルタは範囲がずれたときだけ
  // 張り直すため、運用者が設定したフィルタ条件は通常の実行では消えない
  // (lib/crawler/PlaceDataSheetFilter.js を参照)。
  const finalLastRow = dataSheet.getLastRow();
  dataSheet.setFrozenRows(1);
  if (ensurePlaceDataFilter(dataSheet)) {
    Logger.log('フィルタ範囲が変わったため張り直しました。絞り込み条件の再設定が必要です。');
  }

  Logger.log(
    '今回処理したグリッド数: ' + processedCount +
    ' / 密集で子グリッド生成: ' + denseSplitCount +
    ' / 要確認(上限到達): ' + needsReviewCount +
    ' / 新規追加件数: ' + newRowsCount +
    ' / APIコール回数: ' + stats.totalCalls +
    ' / 累計件数: ' + (finalLastRow - 1)
  );
  Logger.log(
    '[コール内訳] グループ別(A/B/C/D): ' + stats.baseGroupCalls.join('/') +
    ' / うち20件飽和: ' + stats.baseGroupSaturated.join('/') +
    ' / タイプ分割: ' + stats.typeSplitCalls +
    ' / 階層別: ' + JSON.stringify(stats.callsByTier) +
    ' / グループA=0件で省略したセル: ' + stats.emptyByGroupA
  );
  Logger.log(
    '[プローブ内訳] コール: ' + stats.probeCalls +
    ' / 0件: ' + stats.probeEmpty +
    ' / 確定: ' + stats.probeResolved +
    ' / 20件飽和: ' + stats.probeSaturated +
    ' / 未被覆の店: ' + stats.uncoveredPlaces
  );
  if (quotaExceeded) {
    Logger.log('→ 利用上限により中断しました。上限がリセットされたら、同じ crawlAllGrids を再実行すれば続きから再開します。');
  } else {
    Logger.log('未処理のグリッドが残っている場合は、もう一度 crawlAllGrids を実行してください。');
  }
}
