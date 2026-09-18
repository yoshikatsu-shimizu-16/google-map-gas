/**
 * [エントリーポイント/トリガー]
 * 「グリッド一覧」シートに保存された各座標を1件ずつ処理し、
 * Places API (New) の searchNearby エンドポイントで店舗を検索して
 * 「全飲食店データ」シートに書き込む。
 *
 * 密集エリア対策(20件の壁への対応):
 *   1. 頻度別4グループ(A/B/C/D、BASE_TYPE_GROUPS)でそれぞれ検索する(必ず4回)。
 *   2. いずれかのグループがちょうど20件(maxResultCount)返ってきた場合、切り捨ての疑いが
 *      あるため、そのグループだけを DENSE_SPLIT_CHUNK_SIZE 件ずつの小グループに細分化して
 *      追加検索する(タイプ分割)。密集判定の主犯はほぼ常にグループA(頻出ジャンル)。
 *   3. タイプ分割してもなお20件ちょうど返ってくる小グループがあれば、
 *      階層が MAX_TIER 未満の場合に限り、半径を約6割に縮めた4つの子グリッドを
 *      生成して「グリッド一覧」に追加する(次回実行時に自動的に処理される)。
 *   4. 階層が MAX_TIER に達してもまだ20件出る場合は、これ以上の自動化は
 *      行わず「要確認(上限到達)」のステータスを付けて人間の確認に委ねる。
 *
 * その他の特徴:
 *   - GASの実行時間上限(6分)に対応するため、4分30秒経過時点で安全停止する。
 *     未処理のグリッドが残っていれば、再実行することで続きから再開できる
 *     (「処理状況」列が '処理済み' 等の完了ステータスの行はスキップされるため)。
 *   - Place ID をキーに重複除去を行う(隣接グリッド・タイプ分割の重複ヒットに対応)。
 *   - Demoキーの1日あたりのクォータ上限(RESOURCE_EXHAUSTED/429)や、自前の月間上限
 *     (checkAndIncrementApiQuota)を検知した場合は、個別グリッドのエラーとして無視せず、
 *     ループ全体を即座に中断する。このとき「処理状況」は更新されないため、
 *     翌日・翌月以降の再実行でそのグリッドから再開される。
 *
 * @returns {void}
 */
function crawlAllGrids() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // GASの実行時間上限(6分)に対する安全マージン

  const apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_API_KEY');
  const scriptProps = PropertiesService.getScriptProperties();
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
    const headers = [
      '店名', '主タイプ', '住所',
      '電話番号(国内)', 'HP有無', 'HP URL', 'Google Maps URL',
      '評価', '評価件数',
      // 'レビュー抜粋(1件目)', // Demoキーでは取得不可のため無効化
      '営業状況', '通常営業時間', '価格帯',
      'テイクアウト', 'デリバリー', '店内飲食', '予約可',
      '子連れ向き', 'ペット可', '説明文(Editorial)',
      // '写真枚数', // Demoキーでは取得不可のため無効化
      'Place ID'
    ];
    dataSheet.appendRow(headers);
  }

  const lastDataRow = dataSheet.getLastRow();
  const existingIds = new Set();
  const idColIndex = dataSheet.getLastColumn(); // Place IDは最終列
  if (lastDataRow > 1) {
    const idColValues = dataSheet.getRange(2, idColIndex, lastDataRow - 1, 1).getValues();
    idColValues.forEach(function(row) {
      if (row[0]) existingIds.add(row[0]);
    });
  }

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.primaryType',
    'places.primaryTypeDisplayName',
    'places.formattedAddress',
    'places.nationalPhoneNumber',
    'places.websiteUri',
    'places.googleMapsUri',
    'places.regularOpeningHours',
    'places.rating',
    'places.userRatingCount',
    // 'places.reviews', // Demoキーでは取得不可のため無効化
    // 'places.photos',  // Demoキーでは取得不可のため無効化
    'places.editorialSummary',
    'places.priceLevel',
    'places.takeout',
    'places.delivery',
    'places.dineIn',
    'places.reservable',
    'places.goodForChildren',
    'places.allowsDogs',
    'places.businessStatus'
  ].join(',');

  const gridLastRow = gridSheet.getLastRow();
  if (gridLastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }
  // 階層・親グリッドID列(F,G)も含めて7列分読み込む
  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, 7).getValues();

  let processedCount = 0;
  let newRowsCount = 0;
  let denseSplitCount = 0;
  let needsReviewCount = 0;
  let apiCallCount = 0; // このcrawlAllGrids実行で行ったAPIコール(callSearchNearby)の回数
  let nextGridId = gridValues.reduce(function(max, r) { return Math.max(max, r[0]); }, 0) + 1;
  let quotaExceeded = false;

  const DONE_STATUSES = ['処理済み', '密集(タイプ分割済み)', '密集(分割済み)', '要確認(上限到達)'];

  // 早期リターン: 未処理のグリッドが1件も残っていなければ、API呼び出しをせず終了する
  // (トリガーによる無駄な自動実行のコストを防ぐため)
  const remainingCount = gridValues.filter(function(r) { return DONE_STATUSES.indexOf(r[4]) === -1; }).length;
  if (remainingCount === 0) {
    Logger.log('未処理のグリッドはありません。すべて完了済みのため、今回は何もせず終了します。');
    return;
  }
  Logger.log('未処理のグリッド数: ' + remainingCount + '件。処理を開始します。');

  for (let i = 0; i < gridValues.length; i++) {
    const row = gridValues[i];
    const status = row[4];
    if (DONE_STATUSES.indexOf(status) !== -1) continue; // 完了済みのグリッドはスキップ(再開時の重複呼び出し防止)

    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      Logger.log('実行時間の上限に近づいたため、ここで停止します。続きは再実行してください。');
      break;
    }

    const gridId = row[0];
    const lat = row[1];
    const lng = row[2];
    const radius = row[3];
    const tier = row[5] || 0;

    let anyBaseGroupSaturated = false; // 4グループのうち、いずれかが20件に達したか
    let anyFineGroupSaturated = false; // タイプ分割(細分化)してもなお20件出たグループがあるか
    let gridHadFailure = false;

    // --- ステップ1: 頻度別4グループ(A/B/C/D)でそれぞれ検索(必ず4回) ---
    for (let g = 0; g < BASE_TYPE_GROUPS.length; g++) {
      const groupTypes = BASE_TYPE_GROUPS[g];
      const groupResult = callSearchNearby(apiKey, fieldMask, groupTypes, lat, lng, radius);
      apiCallCount++;
      if (apiCallCount % 20 === 0) {
        Logger.log('進捗: 現在 ' + apiCallCount + ' 回コール済み');
      }

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
        if (addPlaceRow(dataSheet, place, existingIds)) newRowsCount++;
      });

      if (groupResult.places.length < 20) continue; // このグループは20件未満なので分割不要
      anyBaseGroupSaturated = true;

      // --- ステップ2: 20件に達したグループだけ、さらに細分化して検索(タイプ分割) ---
      const subGroups = chunkArray(groupTypes, DENSE_SPLIT_CHUNK_SIZE);
      let thisGroupStillSaturated = false;
      for (let s = 0; s < subGroups.length; s++) {
        const subResult = callSearchNearby(apiKey, fieldMask, subGroups[s], lat, lng, radius);
        apiCallCount++;
        if (apiCallCount % 20 === 0) {
          Logger.log('進捗: 現在 ' + apiCallCount + ' 回コール済み');
        }
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
          if (addPlaceRow(dataSheet, place, existingIds)) newRowsCount++;
        });
        if (subResult.places.length >= 20) thisGroupStillSaturated = true;
      }
      if (quotaExceeded) break;
      if (thisGroupStillSaturated) anyFineGroupSaturated = true;
    }
    if (quotaExceeded) break;

    // --- ステップ3: タイプ分割してもまだ20件出るグループがある → 半径の自動細分化 ---
    if (anyFineGroupSaturated) {
      if (tier < MAX_TIER) {
        nextGridId = spawnChildGrids(gridSheet, gridId, lat, lng, radius, tier, nextGridId);
        gridSheet.getRange(i + 2, 5).setValue('密集(分割済み)');
        denseSplitCount++;
      } else {
        // これ以上の自動細分化は行わず、人間の目視確認に委ねる
        gridSheet.getRange(i + 2, 5).setValue('要確認(上限到達)');
        needsReviewCount++;
      }
    } else if (gridHadFailure) {
      gridSheet.getRange(i + 2, 5).setValue('エラー');
    } else if (anyBaseGroupSaturated) {
      gridSheet.getRange(i + 2, 5).setValue('密集(タイプ分割済み)');
      processedCount++;
    } else {
      gridSheet.getRange(i + 2, 5).setValue('処理済み');
      processedCount++;
    }
  }

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
    ' / APIコール回数: ' + apiCallCount +
    ' / 累計件数: ' + (finalLastRow - 1)
  );
  if (quotaExceeded) {
    Logger.log('→ 利用上限により中断しました。上限がリセットされたら、同じ crawlAllGrids を再実行すれば続きから再開します。');
  } else {
    Logger.log('未処理のグリッドが残っている場合は、もう一度 crawlAllGrids を実行してください。');
  }
}
