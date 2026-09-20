/**
 * [エントリーポイント/確認用]
 * 「全飲食店データ」シートの 店名 / 全タイプ 列を読み、現行のプローブ集合
 * (PLACE_TYPE_PROBE_SET)の被覆率と、貪欲法による最小被覆集合をログ出力する。
 * APIコールは一切行わない(0コール)。
 *
 * この監査が成立する理由: 現行は crawlAllGrids が毎セル全166タイプ(A/B/C/D)を
 * 検索しているため、既にクロール済みのセルでは取りこぼしのない母集団になっている
 * (20件の壁に当たった分を除く)。各行の「全タイプ」がプローブ集合と交差するかを
 * 集計すれば、それがそのまま被覆判定になる。
 *
 * 重要な注意: この監査の証拠能力は「旧方式(SEARCH_STRATEGY=type_groups)で集めた行」に
 * 由来する。SEARCH_STRATEGY=probe に切り替えたあとに同じ監査を回すと、プローブ集合に
 * 一致するデータしか集まらなくなり自己循環して無意味になる。切替**前**に一度実行し、
 * 確定した根拠を lib/catalog/PlaceTypeProbeSet.js のコメントに転記すること
 * (docs/Overview.js のリスク表も参照)。
 *
 * @returns {void}
 */
function auditProbeSetCoverage() {
  const scriptProps = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。先に generateGridList を実行してください。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  const dataSheet = spreadsheet.getSheetByName('全飲食店データ');
  if (!dataSheet) {
    Logger.log('「全飲食店データ」シートがありません。先に crawlAllGrids を実行してください。');
    return;
  }

  const lastRow = dataSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('「全飲食店データ」にデータ行がありません。crawlAllGrids を実行してから再実行してください。');
    return;
  }

  // 列番号は PLACE_DATA_HEADERS の並びではなく、シートの実際のヘッダー行から引く。
  // 期待するスキーマの並びをそのまま信じると、シートが旧スキーマのままのときに黙って
  // 別の列を読んでしまう(旧20列スキーマでは3列目が「全タイプ」ではなく「住所」なので、
  // 住所文字列をタイプ配列として解釈し、被覆率0%という無意味な結果が出る)。
  const headerRow = dataSheet.getRange(1, 1, 1, dataSheet.getLastColumn()).getValues()[0];
  const headerColumnOf = function(name) {
    for (let i = 0; i < headerRow.length; i++) {
      const value = (headerRow[i] === null || headerRow[i] === undefined) ? '' : String(headerRow[i]).trim();
      if (value === name) return i + 1;
    }
    return -1;
  };
  const nameCol = headerColumnOf('店名');
  const typesCol = headerColumnOf(PLACE_HEADER_ALL_TYPES);
  if (nameCol === -1 || typesCol === -1) {
    Logger.log(
      '「全飲食店データ」シートに「店名」または「' + PLACE_HEADER_ALL_TYPES + '」列がありません' +
      '(旧スキーマのままの可能性があります)。crawlAllGrids を1回実行するとスキーマ移行が走ります。'
    );
    Logger.log(
      'ただし places.types はフィールドマスクに後から追加した項目のため、移行しても' +
      '既存行の「' + PLACE_HEADER_ALL_TYPES + '」は空のままです。移行後に新しく取得した行が' +
      '溜まってから再実行してください。'
    );
    return;
  }
  const readFromCol = Math.min(nameCol, typesCol);
  const readToCol = Math.max(nameCol, typesCol);
  // 「店名」「全タイプ」を含む範囲を1回の getValues でまとめて読む(0コールかつシートアクセスも最小限)。
  const raw = dataSheet.getRange(2, readFromCol, lastRow - 1, readToCol - readFromCol + 1).getValues();
  const nameIdx = nameCol - readFromCol;
  const typesIdx = typesCol - readFromCol;

  Logger.log('===== プローブ集合 被覆監査(APIコール0) =====');

  // --- 1. 母集団の健全性 ---
  const emptyRowCount = raw.filter(function(r) { return r[typesIdx] === '' || r[typesIdx] === undefined || r[typesIdx] === null; }).length;
  const usableRows = [];
  raw.forEach(function(r, i) {
    if (r[typesIdx] !== '' && r[typesIdx] !== undefined && r[typesIdx] !== null) usableRows.push(i);
  });
  const typeRows = usableRows.map(function(i) { return parsePlaceTypesCell(raw[i][typesIdx]); });
  const distinctTypes = {};
  typeRows.forEach(function(types) { types.forEach(function(t) { distinctTypes[t] = true; }); });

  Logger.log(
    '[1. 母集団の健全性] 総行数: ' + raw.length +
    ' / 「全タイプ」空: ' + emptyRowCount + '(places.types をフィールドマスクに追加する前に取得された行)' +
    ' / 判定対象: ' + usableRows.length +
    ' / 異なりタイプ数: ' + Object.keys(distinctTypes).length
  );
  if (usableRows.length === 0) {
    Logger.log(
      '判定に使える行が0件です(全行の「' + PLACE_HEADER_ALL_TYPES + '」が空)。' +
      'places.types はフィールドマスクに後から追加した項目のため、それ以前に取得した行には' +
      '入っていません。しばらくクロールを回して新しい行を溜めてから再実行してください。'
    );
    return;
  }

  // --- 2. 母集団のバイアス注記 ---
  Logger.log(
    '[2. バイアス注記] 20件の壁(maxResultCount)に当たったセルの分は取りこぼしを含むため、' +
    'これは完全な母集団ではない。密集(タイプ分割済み)・要確認(上限到達)のグリッドが多いほど、' +
    'この監査で見えない被覆漏れが残っている可能性が上がる。'
  );

  // --- 3. 現行プローブ集合の被覆率 ---
  const summary = summarizeProbeCoverage(typeRows, PLACE_TYPE_PROBE_SET, ALL_SEARCHABLE_PLACE_TYPES);
  const coverageRate = (summary.coveredCount / summary.rowCount * 100).toFixed(1);
  Logger.log(
    '[3. 現行プローブ集合の被覆率] 被覆 ' + summary.coveredCount + '/' + summary.rowCount +
    '行 (' + coverageRate + '%)'
  );
  const uncoveredSample = summary.uncoveredRowIndexes.slice(0, 30);
  uncoveredSample.forEach(function(rowIndex) {
    const originalIndex = usableRows[rowIndex];
    Logger.log('  未被覆: ' + raw[originalIndex][nameIdx] + ' / 全タイプ=' + raw[originalIndex][typesIdx]);
  });
  if (summary.uncoveredRowIndexes.length > uncoveredSample.length) {
    Logger.log('  ...ほか ' + (summary.uncoveredRowIndexes.length - uncoveredSample.length) + '件(最大30件まで表示)');
  }

  // --- 4. プローブ型ごとのヒット数と単独被覆数 ---
  Logger.log('[4. プローブ型ごとのヒット数と単独被覆数] (単独被覆=このタイプだけで被覆できていた行数)');
  PLACE_TYPE_PROBE_SET.forEach(function(t) {
    Logger.log('  ' + t + ': ' + summary.hitCountByProbeType[t] + '行 (単独 ' + summary.soleCoverCountByProbeType[t] + ')');
  });

  // --- 5. 貪欲法の最小被覆集合 ---
  const minimalCover = findMinimalProbeCover(typeRows, ALL_SEARCHABLE_PLACE_TYPES, INCLUDED_TYPES_MAX_PER_REQUEST);
  Logger.log('[5. 貪欲法の最小被覆集合] (上限 ' + INCLUDED_TYPES_MAX_PER_REQUEST + '種)');
  let cumulative = 0;
  minimalCover.cover.forEach(function(entry, i) {
    cumulative += entry.newlyCovered;
    const pct = (cumulative / typeRows.length * 100).toFixed(1);
    Logger.log('  ' + (i + 1) + '. ' + entry.type + ' (+' + entry.newlyCovered + ' / 累計 ' + pct + '%)');
  });
  Logger.log(
    '  最終被覆: ' + minimalCover.coveredCount + '/' + typeRows.length +
    '行 (未被覆 ' + minimalCover.uncoveredRowIndexes.length + '行)'
  );

  // --- 6. カタログ166種のうち母集団に1件も出現しなかったタイプ一覧 ---
  Logger.log(
    '[6. 母集団に出現しなかったカタログタイプ(シート実測では検証不能な残余リスク)] ' +
    summary.catalogTypesNeverObserved.length + '種: ' + summary.catalogTypesNeverObserved.join(', ')
  );

  // --- 7. カタログ外で観測されたタイプの頻度上位 ---
  const nonCatalogRanked = Object.keys(summary.observedNonCatalogTypes)
    .map(function(t) { return { type: t, count: summary.observedNonCatalogTypes[t] }; })
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, 20);
  Logger.log('[7. カタログ外で観測されたタイプの頻度上位] (store のような includedTypes 追加候補を探す手がかり)');
  nonCatalogRanked.forEach(function(e) {
    Logger.log('  ' + e.type + ': ' + e.count + '行');
  });
}
