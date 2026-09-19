/**
 * [エントリーポイント/トリガー]
 * 「グリッド一覧」シートに保存された各座標を1件ずつ処理し、
 * Places API (New) の searchNearby エンドポイントで店舗を検索して
 * 「全飲食店データ」シートに書き込む。
 *
 * 密集エリア対策(20件の壁への対応):
 *   1. 頻度別4グループ(A/B/C/D、BASE_TYPE_GROUPS)で検索する。
 *      ただしグループA(頻出39種)が0件だったセルは、田畑・河川・住宅のみで
 *      飲食店が存在しないとみなし、残りB/C/Dの3回を省略する。
 *   2. いずれかのグループがちょうど20件(maxResultCount)返ってきた場合、切り捨ての疑いが
 *      あるため、そのグループだけを小グループに細分化して追加検索する(タイプ分割)。
 *      密集判定の主犯はほぼ常にグループA(頻出ジャンル)。
 *   3. タイプ分割してもなお20件ちょうど返ってくる小グループがあれば、
 *      階層が MAX_TIER 未満の場合に限り、セル矩形を4象限に等分した子グリッドを
 *      生成して「グリッド一覧」に追加する(次回実行時に自動的に処理される)。
 *   4. 階層が MAX_TIER に達してもまだ20件出る場合は、これ以上の自動化は
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
 *   - APIコールの内訳(どのグループで何回・何回飽和したか、階層別の消費)をログに出す。
 *     タイプカタログの見直しや格子方式の変更を判断するための計測値。
 *
 * @returns {void}
 */
function crawlAllGrids() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // GASの実行時間上限(6分)に対する安全マージン

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
    emptyByGroupA: 0                   // グループAが0件でB/C/Dを省略したセル数
  };

  const DONE_STATUSES = [
    '処理済み', '処理済み(A=0のため省略)',
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

    /**
     * 実際にHTTPリクエストが飛んだ場合だけコール数を数える計測用のフック。
     * 自前の月間上限で手前で止めた分を数えると、実績値がずれてしまうため。
     * @param {{requestSent: boolean}} result - callSearchNearby の戻り値
     */
    const countCall = function(result) {
      if (!result.requestSent) return;
      stats.totalCalls++;
      stats.callsByTier[tier] = (stats.callsByTier[tier] || 0) + 1;
      if (stats.totalCalls % 20 === 0) {
        Logger.log('進捗: 現在 ' + stats.totalCalls + ' 回コール済み');
      }
    };

    let anyBaseGroupSaturated = false; // 4グループのうち、いずれかが20件に達したか
    let anyFineGroupSaturated = false; // タイプ分割してもなお20件出たグループがあるか
    let gridHadFailure = false;
    let emptyByGroupA = false;

    // --- ステップ1: 頻度別グループ(A/B/C/D)で検索 ---
    for (let g = 0; g < BASE_TYPE_GROUPS.length; g++) {
      const groupTypes = BASE_TYPE_GROUPS[g];
      const groupResult = callSearchNearby(apiKey, PLACE_SEARCH_FIELD_MASK, groupTypes, lat, lng, radius);
      if (groupResult.requestSent) stats.baseGroupCalls[g]++;
      countCall(groupResult);

      if (!groupResult.ok) {
        if (groupResult.quotaExceeded) {
          Logger.log('利用上限に達したと思われるため、処理を中断します。');
          Logger.log('エラー内容: ' + groupResult.errorText);
          quotaExceeded = true;
          break;
        }
        Logger.log('グリッド ' + gridId + ' のグループ検索でエラー: ' + groupResult.errorText);
        gridHadFailure = true;
        continue;
      }

      groupResult.places.forEach(function(place) {
        if (writer.add(place)) newRowsCount++;
      });

      // グループA(頻出39種)が0件なら、このセルには飲食店が存在しないとみなし
      // B/C/Dの3コールを省略する。稀タイプだけが存在するセルを取りこぼす可能性が
      // ゼロではないため、後から再掃討できるよう専用ステータスで区別する。
      if (g === 0 && groupResult.places.length === 0) {
        emptyByGroupA = true;
        stats.emptyByGroupA++;
        break;
      }

      if (groupResult.places.length < 20) continue; // このグループは20件未満なので分割不要
      anyBaseGroupSaturated = true;
      stats.baseGroupSaturated[g]++;

      // --- ステップ2: 20件に達したグループだけ、さらに細分化して検索(タイプ分割) ---
      const subGroups = splitTypeGroupForDenseArea(groupTypes);
      let thisGroupStillSaturated = false;
      for (let s = 0; s < subGroups.length; s++) {
        const subResult = callSearchNearby(apiKey, PLACE_SEARCH_FIELD_MASK, subGroups[s], lat, lng, radius);
        if (subResult.requestSent) stats.typeSplitCalls++;
        countCall(subResult);
        if (!subResult.ok) {
          if (subResult.quotaExceeded) {
            Logger.log('利用上限に達したと思われるため、処理を中断します。');
            Logger.log('エラー内容: ' + subResult.errorText);
            quotaExceeded = true;
            break;
          }
          Logger.log('グリッド ' + gridId + ' のタイプ分割検索でエラー: ' + subResult.errorText);
          continue;
        }
        subResult.places.forEach(function(place) {
          if (writer.add(place)) newRowsCount++;
        });
        if (subResult.places.length >= 20) thisGroupStillSaturated = true;
      }
      if (quotaExceeded) break;
      if (thisGroupStillSaturated) anyFineGroupSaturated = true;
    }

    // 中断する場合も、それまでに集めた行は失わないよう先に書き出す
    writer.flush();
    if (quotaExceeded) break;

    // --- ステップ3: タイプ分割してもまだ20件出るグループがある → セルの四分木分割 ---
    if (anyFineGroupSaturated) {
      if (tier < MAX_TIER) {
        nextGridId = spawnChildGrids(gridSheet, gridId, lat, lng, cellSizeDeg, tier, nextGridId);
        gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('密集(分割済み)');
        denseSplitCount++;
      } else {
        // これ以上の自動細分化は行わず、人間の目視確認に委ねる
        gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('要確認(上限到達)');
        needsReviewCount++;
      }
    } else if (gridHadFailure) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('エラー');
    } else if (emptyByGroupA) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('処理済み(A=0のため省略)');
      processedCount++;
    } else if (anyBaseGroupSaturated) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('密集(タイプ分割済み)');
      processedCount++;
    } else {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue('処理済み');
      processedCount++;
    }
  }

  writer.flush();

  // 出力シートにヘッダー固定・フィルタを再設定(既存フィルタは一度削除してから再作成)
  const finalLastRow = dataSheet.getLastRow();
  const finalLastCol = dataSheet.getLastColumn();
  dataSheet.setFrozenRows(1);
  const existingFilter = dataSheet.getFilter();
  if (existingFilter) existingFilter.remove();
  if (finalLastRow > 1) {
    dataSheet.getRange(1, 1, finalLastRow, finalLastCol).createFilter();
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
  if (quotaExceeded) {
    Logger.log('→ 利用上限により中断しました。上限がリセットされたら、同じ crawlAllGrids を再実行すれば続きから再開します。');
  } else {
    Logger.log('未処理のグリッドが残っている場合は、もう一度 crawlAllGrids を実行してください。');
  }
}
