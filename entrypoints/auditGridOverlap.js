/**
 * [エントリーポイント/確認用]
 * 「グリッド一覧」シートの座標データから、以下をAPIコール0で突き合わせる(Issue #24)。
 *
 *   1. 階層0セルの半径が、現行コード(cellCoverRadiusMeters)の計算値と一致するか。
 *      不一致は、半径700mを決め打ちしていた旧 generateGridList が生成した行に由来する
 *      (コミット 84b54f1 より前に作られた行)。ズレの分だけ矩形の四隅が検索円から
 *      はみ出し、取りこぼしが起きている可能性がある。
 *   2. 検索円どうしが大きく重なっている行の組がないか。旧ロジック(親円を0.6倍の
 *      4円で覆う方式)は兄弟円が幾何的に重なる設計だったため、既に処理済みの行に
 *      重複が見つかっても今さら払い戻せる話ではない(参考情報として報告するのみ)。
 *      一方「未処理」どうしの重複は、これから同じ範囲に2回コールしてしまう
 *      無駄なので優先して確認する。
 *
 * 本関数はシートを一切書き換えない。半径のズレを実際に直す場合は
 * fixUnprocessedRootRadius を使う(処理済みの行には触らない)。
 *
 * @returns {void}
 */
function auditGridOverlap() {
  const scriptProps = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。先に generateGridList を実行してください。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    Logger.log('グリッド一覧シートがありません。');
    return;
  }
  ensureGridSchemaMigrated(gridSheet);

  const lastRow = gridSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }
  const values = gridSheet.getRange(2, 1, lastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();
  const cells = values.map(function(r) {
    return { gridId: r[0], lat: r[1], lng: r[2], radius: r[3], status: r[4], tier: r[5] || 0, parentId: r[6] };
  });
  const cellById = {};
  cells.forEach(function(c) { cellById[c.gridId] = c; });
  const isUnprocessed = function(gridId) {
    const c = cellById[gridId];
    return !!c && GRID_DONE_STATUSES.indexOf(c.status) === -1;
  };

  Logger.log('===== グリッド一覧の整合性チェック(APIコール0、対象' + cells.length + '行) =====');

  // --- 1. 階層0セルの半径不一致 ---
  const mismatches = findRootRadiusMismatches(cells, GRID_STEP);
  const unprocessedMismatches = mismatches.filter(function(m) { return isUnprocessed(m.gridId); });
  Logger.log(
    '階層0セルの半径不一致: ' + mismatches.length + '件' +
    '(うち未処理: ' + unprocessedMismatches.length + '件)'
  );
  if (mismatches.length > 0) {
    mismatches.slice(0, 5).forEach(function(m) {
      Logger.log('  グリッド' + m.gridId + ': 記録=' + m.storedRadius + 'm / 現行計算値=' + m.expectedRadius + 'm(差=' + m.diff + 'm)');
    });
    if (mismatches.length > 5) Logger.log('  ...ほか' + (mismatches.length - 5) + '件');
  }
  if (unprocessedMismatches.length > 0) {
    Logger.log('  → 未処理の行はまだ間に合う。fixUnprocessedRootRadius で修正できる。');
  }

  // --- 2. 検索円の重複 ---
  const overlaps = findOverlappingPairs(cells, { minFraction: 0.2 });
  const unprocessedOverlaps = overlaps.filter(function(o) {
    return isUnprocessed(o.aId) && isUnprocessed(o.bId);
  });
  Logger.log(
    '重複率20%以上のセルペア: ' + overlaps.length + '組' +
    '(うち両方が未処理: ' + unprocessedOverlaps.length + '組 ← これから無駄なコールになりうる)'
  );
  const reportPairs = unprocessedOverlaps.length > 0 ? unprocessedOverlaps : overlaps;
  reportPairs.slice(0, 20).forEach(function(o) {
    Logger.log(
      '  グリッド' + o.aId + '(階層' + o.aTier + ') × グリッド' + o.bId + '(階層' + o.bTier + '): ' +
      '重複率' + (o.fraction * 100).toFixed(1) + '% / 中心間' + o.distance.toFixed(0) + 'm'
    );
  });
  if (reportPairs.length > 20) Logger.log('  ...ほか' + (reportPairs.length - 20) + '組');
  if (overlaps.length > 0 && unprocessedOverlaps.length === 0) {
    Logger.log('  → 重複はすべて処理済みの行同士(過去に消費したコールなので、今から直しても払い戻せない)。');
  }
}

/**
 * [エントリーポイント/手動実行]
 * 階層0セルのうち「未処理」の行だけ、半径を現行コードの計算値
 * (cellCoverRadiusMeters)に修正する。旧い generateGridList が半径700mを決め打ちして
 * いた時代の名残で、修正しないと矩形の四隅が検索円からはみ出し取りこぼしが起きる。
 *
 * 既に処理済みの行は対象外(過去の検索をやり直すと無駄なコールになるため)。
 *
 * @returns {void}
 */
function fixUnprocessedRootRadius() {
  const scriptProps = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。先に generateGridList を実行してください。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    Logger.log('グリッド一覧シートがありません。');
    return;
  }
  ensureGridSchemaMigrated(gridSheet);

  const lastRow = gridSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }
  const values = gridSheet.getRange(2, 1, lastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();

  let fixedCount = 0;
  values.forEach(function(row, idx) {
    const tier = row[5] || 0;
    const status = row[4];
    if (tier !== 0) return;
    if (GRID_DONE_STATUSES.indexOf(status) !== -1) return;
    const expected = cellCoverRadiusMeters(GRID_STEP, row[1]);
    if (Math.abs(expected - row[3]) < 1) return;
    gridSheet.getRange(2 + idx, 4, 1, 1).setValue(expected);
    fixedCount++;
  });

  Logger.log('未処理の階層0セル ' + fixedCount + '件の半径を修正しました。');
}
