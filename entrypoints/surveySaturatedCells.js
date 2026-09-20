/**
 * [エントリーポイント/調査用]
 * 飽和したマス(20件以上)を4分割し、子マスにプローブを1コールずつ投げて深さを測る。
 * 何度でも実行でき、そのたびに1段ずつ深く掘る。
 *
 * ねらい: 収穫(Enterprise枠)で叩く必要があるのは「20件未満と分かっているマス」だけ。
 * 飽和マスに無駄打ちしないで済むよう、全域が20件未満に割れるまで Pro枠で先に測る。
 * Pro枠で測った1コールは、Enterprise枠の無駄な1コールを消す。
 *
 * 実測(2026-09-20):
 *   1段目 … 220の飽和マスを4分割 → 50.9%が解決。179の子マスがまだ飽和
 *   タイプ分割(4+7=11コール)より4分割(1+4=5コール)のほうが安く、解決率も同等以上
 *
 * コスト: Pro段なので **Enterprise枠(営業用)を消費しない**。飽和マス1つにつき4コール。
 *
 * 安全性: 「グリッド一覧」に子グリッドを追加しない。本番の進捗を変えずに測るのが目的で、
 * 追加すると crawlAllGrids が営業用の枠でそれを処理してしまう。座標は計算するだけで、
 * 結果は「調査(分割マス)」シートにのみ書く。
 *
 * 親マス単位で4件まとめて記録するので、途中で止まっても中途半端な親は残らない
 * (次回やり直される)。
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

  Logger.log('===== 飽和マスの分割調査(Pro段・営業用の枠は使いません) =====');

  const subSheet = ensureSubdividedCellSheet(spreadsheet, cellSheet);
  const surveyed = readSubdividedCells(subSheet);
  const parents = collectCellsNeedingSubdivision(cellSheet, surveyed);

  if (parents.length === 0) {
    Logger.log('分割が必要なマスはありません。全域が20件未満に割れています。');
    reportSubdivisionDepth(subSheet, 0);
    return;
  }

  const affordableParents = maxCalls === null
    ? parents.length
    : Math.floor(maxCalls / CHILD_CELLS_PER_PARENT);
  if (affordableParents === 0) {
    Logger.log('未分割の飽和マス: ' + parents.length + ' / 実行すれば ' +
      (parents.length * CHILD_CELLS_PER_PARENT) + ' コール消費します(親1つにつき子4コール、すべてPro段)');
    Logger.log(SURVEY_MAX_CALLS_PROP + ' が ' + maxCalls +
      ' のため、ここで終了します(親1つに4コール必要なので刻むなら4の倍数で指定してください)。');
    return;
  }
  const plannedParents = Math.min(parents.length, affordableParents);
  Logger.log('未分割の飽和マス: ' + parents.length + ' / 今回消費するコール数: ' +
    (plannedParents * CHILD_CELLS_PER_PARENT) + '(親' + plannedParents + '個 × 子4コール、すべてPro段)');

  const rows = [];
  let nextRow = subSheet.getLastRow() + 1;
  let surveyedParents = 0, resolvedParents = 0, stillSaturatedChildren = 0;
  let stoppedReason = '';

  const flush = function() {
    if (rows.length === 0) return;
    subSheet.getRange(nextRow, 1, rows.length, SUBDIVIDED_CELL_HEADERS.length).setValues(rows);
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
        parentRows.push(toSubdividedCellRow(parent, child, -1, 'エラー'));
        continue;
      }
      const found = result.places.length;
      if (found >= 20) saturatedChildren++;
      parentRows.push(toSubdividedCellRow(parent, child, found, found >= 20 ? '飽和(20件以上)' : ''));
    }
    if (quotaHit) break; // この親は記録しない(次回まるごとやり直す)

    rows.push.apply(rows, parentRows);
    surveyedParents++;
    stillSaturatedChildren += saturatedChildren;
    if (saturatedChildren === 0) resolvedParents++;

    if (surveyedParents % FLUSH_EVERY_PARENTS === 0) {
      flush();
      // 数分かかるので途中経過を出す。出さないと「止まっているのか動いているのか」が
      // 実行ログから分からない。
      Logger.log('進捗: ' + surveyedParents + '/' + plannedParents + '親マス (' +
        (surveyedParents * CHILD_CELLS_PER_PARENT) + 'コール済み)');
    }
  }
  flush();

  Logger.log('--- 今回の調査 ---');
  Logger.log('分割した親マス: ' + surveyedParents +
    ' / 4分割で解決: ' + resolvedParents +
    ' / まだ飽和している子マス: ' + stillSaturatedChildren);
  if (stoppedReason) Logger.log('→ ' + stoppedReason);
  if (stillSaturatedChildren > 0) {
    Logger.log('→ まだ飽和しているマスがあります。もう一度実行すると、さらに1段掘ります。');
  }

  // 残数はシートを読み直して数える。「飽和しているが既に分割済み」のマスを
  // 未処理として数えてしまわないため(分割済みかどうかは子行の有無でしか分からない)。
  const remaining = collectCellsNeedingSubdivision(cellSheet, readSubdividedCells(subSheet));
  reportSubdivisionDepth(subSheet, remaining.length);
}

/**
 * 分割マスの記録。セルIDはパス形式(例: 301-北東-南西)で、何段掘っても一意になる。
 * 「調査(マス)」のマスと合わせて、全域の木構造を表す。
 */
const SUBDIVIDED_CELL_HEADERS = [
  'セルID', '親セルID', '階層', '中心緯度', '中心経度', '半径m', '取得件数', '備考', '確認日時'
];

/** 旧スキーマ(1段目だけを想定していた頃の列)。移行の判定に使う。 */
const LEGACY_SUBDIVIDED_CELL_HEADERS = [
  '親グリッドID', '象限', '中心緯度', '中心経度', '半径m', '取得件数', '備考', '確認日時'
];

/**
 * 掘り進める深さの上限。これ以上は分割せず、人の確認に委ねる。
 * 階層6は1辺が十数mで、そこに20件あるなら1棟のビルに集中しているケース。
 * 自動分割では解けないので、無限に掘らないための歯止めとして置いている。
 */
const SURVEY_MAX_TIER = 6;

/**
 * 分割マスのシートを用意する。旧スキーマ(1段目専用)のシートがあれば内容を引き継ぐ。
 *
 * 移行では親の階層を「調査(マス)」から引く。旧スキーマは親グリッドIDしか持っておらず、
 * 階層を記録していなかったため。既に投じた Pro枠のコールを捨てないための処理。
 *
 * @param {Spreadsheet} spreadsheet
 * @param {Sheet} cellSheet - 「調査(マス)」
 * @returns {Sheet}
 */
function ensureSubdividedCellSheet(spreadsheet, cellSheet) {
  const current = spreadsheet.getSheetByName('調査(分割マス)');
  if (current) return current;

  const sheet = spreadsheet.insertSheet('調査(分割マス)');
  sheet.appendRow(SUBDIVIDED_CELL_HEADERS);
  sheet.setFrozenRows(1);

  const legacy = spreadsheet.getSheetByName('調査(子マス)');
  if (!legacy || legacy.getLastRow() < 2) return sheet;

  const header = legacy.getRange(1, 1, 1, LEGACY_SUBDIVIDED_CELL_HEADERS.length).getValues()[0];
  if (header.join('|') !== LEGACY_SUBDIVIDED_CELL_HEADERS.join('|')) return sheet;

  const tierByGridId = readCellTiers(cellSheet);
  const migrated = legacy.getRange(2, 1, legacy.getLastRow() - 1, LEGACY_SUBDIVIDED_CELL_HEADERS.length)
    .getValues()
    .map(function(row) {
      // 旧: [親グリッドID, 象限, 緯度, 経度, 半径, 件数, 備考, 日時]
      const parentId = row[0];
      const parentTier = tierByGridId[parentId] === undefined ? 0 : tierByGridId[parentId];
      return [parentId + '-' + row[1], String(parentId), parentTier + 1,
        row[2], row[3], row[4], row[5], row[6], row[7]];
    });
  sheet.getRange(2, 1, migrated.length, SUBDIVIDED_CELL_HEADERS.length).setValues(migrated);
  Logger.log('「調査(子マス)」の ' + migrated.length + '行を「調査(分割マス)」へ引き継ぎました' +
    '(1段目だけの形式から、任意の深さを扱える形式へ)。');
  return sheet;
}

/**
 * 「調査(マス)」からグリッドIDごとの階層を読む。
 * @param {Sheet} cellSheet
 * @returns {Object<string, number>}
 */
function readCellTiers(cellSheet) {
  const tierByGridId = {};
  const lastRow = cellSheet.getLastRow();
  if (lastRow < 2) return tierByGridId;
  const idIdx = AREA_SURVEY_CELL_HEADERS.indexOf('グリッドID');
  const tierIdx = AREA_SURVEY_CELL_HEADERS.indexOf('階層');
  cellSheet.getRange(2, 1, lastRow - 1, AREA_SURVEY_CELL_HEADERS.length).getValues()
    .forEach(function(row) { tierByGridId[row[idIdx]] = row[tierIdx] || 0; });
  return tierByGridId;
}

/**
 * 「調査(分割マス)」の内容を読む。
 * @param {Sheet} subSheet
 * @returns {{byId: Object<string, Object>, parentIds: Object<string, boolean>}}
 *   parentIds は「既に分割済みのセルID」の集合(子が1行でもあれば分割済み)
 */
function readSubdividedCells(subSheet) {
  const byId = {};
  const parentIds = {};
  const lastRow = subSheet.getLastRow();
  if (lastRow < 2) return { byId: byId, parentIds: parentIds };

  subSheet.getRange(2, 1, lastRow - 1, SUBDIVIDED_CELL_HEADERS.length).getValues()
    .forEach(function(row) {
      byId[row[0]] = {
        cellId: row[0], parentId: row[1], tier: row[2],
        lat: row[3], lng: row[4], radius: row[5], count: row[6]
      };
      parentIds[row[1]] = true;
    });
  return { byId: byId, parentIds: parentIds };
}

/**
 * これから分割すべきマスを集める。「調査(マス)」と「調査(分割マス)」の両方から、
 * 飽和していて、まだ子を測っていないものを拾う。これにより実行のたびに1段ずつ深くなる。
 *
 * @param {Sheet} cellSheet
 * @param {{byId: Object, parentIds: Object}} surveyed
 * @returns {Array<{cellId: string, tier: number, lat: number, lng: number, radius: number}>}
 */
function collectCellsNeedingSubdivision(cellSheet, surveyed) {
  const needs = [];
  const isSaturated = function(count) { return count !== '' && count !== null && count >= 20; };

  // グリッド一覧由来のマス
  const idIdx = AREA_SURVEY_CELL_HEADERS.indexOf('グリッドID');
  const latIdx = AREA_SURVEY_CELL_HEADERS.indexOf('中心緯度');
  const lngIdx = AREA_SURVEY_CELL_HEADERS.indexOf('中心経度');
  const radiusIdx = AREA_SURVEY_CELL_HEADERS.indexOf('半径m');
  const tierIdx = AREA_SURVEY_CELL_HEADERS.indexOf('階層');
  const countIdx = AREA_SURVEY_CELL_HEADERS.indexOf('取得件数');

  cellSheet.getRange(2, 1, cellSheet.getLastRow() - 1, AREA_SURVEY_CELL_HEADERS.length).getValues()
    .forEach(function(row) {
      const cellId = String(row[idIdx]);
      if (!isSaturated(row[countIdx])) return;
      if (surveyed.parentIds[cellId]) return;         // 分割済み
      if ((row[tierIdx] || 0) >= SURVEY_MAX_TIER) return;
      needs.push({ cellId: cellId, tier: row[tierIdx] || 0,
        lat: row[latIdx], lng: row[lngIdx], radius: row[radiusIdx] });
    });

  // 分割で生まれたマス(2段目以降)
  Object.keys(surveyed.byId).forEach(function(cellId) {
    const cell = surveyed.byId[cellId];
    if (!isSaturated(cell.count)) return;
    if (surveyed.parentIds[cellId]) return;
    if (cell.tier >= SURVEY_MAX_TIER) return;
    needs.push({ cellId: cellId, tier: cell.tier, lat: cell.lat, lng: cell.lng, radius: cell.radius });
  });

  // 浅い順に処理する。深く掘る前に同じ深さを揃えたほうが、途中で止めたときに
  // 「いまどの深さまで見えているか」が読みやすい。
  needs.sort(function(a, b) { return a.tier - b.tier; });
  return needs;
}

/**
 * 分割マス1件の記録行を組み立てる。
 * @param {{cellId: string, tier: number}} parent
 * @param {{label: string, lat: number, lng: number, radius: number}} child
 * @param {number} foundCount - 取得件数(エラー時は -1)
 * @param {string} note
 * @returns {Array}
 */
function toSubdividedCellRow(parent, child, foundCount, note) {
  return [
    parent.cellId + '-' + child.label, parent.cellId, parent.tier + 1,
    child.lat, child.lng, child.radius,
    foundCount < 0 ? '' : foundCount, note, new Date()
  ];
}

/**
 * 分割結果を階層ごとに報告する。「あと何マス掘れば全域が20件未満になるか」が読める。
 *
 * @param {Sheet} subSheet
 * @param {number} pendingCount - まだ分割していない飽和マスの数。飽和していても
 *   既に分割済みのマスは掘る必要がないため、行から数えずに呼び出し側から受け取る。
 * @returns {void}
 */
function reportSubdivisionDepth(subSheet, pendingCount) {
  const lastRow = subSheet.getLastRow();
  if (lastRow < 2) return;

  const values = subSheet.getRange(2, 1, lastRow - 1, SUBDIVIDED_CELL_HEADERS.length).getValues();
  const tierIdx = SUBDIVIDED_CELL_HEADERS.indexOf('階層');
  const countIdx = SUBDIVIDED_CELL_HEADERS.indexOf('取得件数');

  const byTier = {};
  values.forEach(function(row) {
    const tier = row[tierIdx];
    if (!byTier[tier]) byTier[tier] = { total: 0, empty: 0, resolved: 0, saturated: 0 };
    const b = byTier[tier];
    b.total++;
    const n = row[countIdx];
    if (n === '' || n === null) return;
    if (n === 0) b.empty++;
    else if (n < 20) b.resolved++;
    else b.saturated++;
  });

  Logger.log('--- 累計: 分割マスの階層別内訳 ---');
  Object.keys(byTier).sort().forEach(function(tier) {
    const b = byTier[tier];
    Logger.log('  階層' + tier + ': ' + b.total + 'マス' +
      ' / 0件 ' + b.empty + ' / 1〜19件 ' + b.resolved + ' / 飽和 ' + b.saturated);
  });

  // 収穫(Enterprise枠)で叩く必要があるのは「1〜19件と分かっているマス」だけ。
  // 飽和マスは分割すればさらに減るので、この数字が収穫コストの下限になる。
  const harvestable = values.filter(function(row) {
    const n = row[countIdx];
    return n !== '' && n !== null && n >= 1 && n < 20;
  }).length;
  Logger.log('  収穫対象(1〜19件)の分割マス: ' + harvestable + 'マス');
  // 上限階層で飽和したまま打ち切ったマス。これ以上分割できないので「割り切れた」とは言えない。
  const terminal = values.filter(function(row) {
    const n = row[countIdx];
    return row[tierIdx] >= SURVEY_MAX_TIER && n !== '' && n !== null && n >= 20;
  }).length;

  if (pendingCount > 0) {
    Logger.log('  未分割の飽和マス: ' + pendingCount + ' → もう一度実行すると ' +
      (pendingCount * CHILD_CELLS_PER_PARENT) + 'コールで1段掘ります。');
    return;
  }
  if (terminal > 0) {
    Logger.log('  これ以上分割できるマスはありません。');
    Logger.log('  ただし階層' + SURVEY_MAX_TIER + '(上限)で飽和したままのマスが ' + terminal + ' あります。');
    Logger.log('  1辺が十数mでも20件以上 = 1棟のビルに集中しているケースで、空間分割では解けません。');
    Logger.log('  このマスだけはタイプ分割(restaurant を具体的な種類に割る)で取る必要があります。');
    return;
  }
  Logger.log('  飽和は残っていません。全域が20件未満に割れました。');
}
