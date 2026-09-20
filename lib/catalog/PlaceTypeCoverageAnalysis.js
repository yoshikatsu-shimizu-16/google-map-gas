/**
 * ===== プローブ集合の被覆分析(純関数) =====
 *
 * Sheet / Logger / API に一切触れない。実測データ(各店の types 配列)を受け取り、
 * 被覆率の集計と貪欲法による最小被覆集合を返すだけの計算ロジック。
 * ローカルの Node からそのまま検証できる(tools/verifyProbeSetCoverage.js)。
 *
 * 「集合の定義」(PlaceTypeProbeSet.js)と「集合を評価するアルゴリズム」(このファイル)を
 * 分離しているのは、前者は実測のたびに変わるデータで、後者は変わらないアルゴリズムであり、
 * 変更理由が違うため。
 */

/**
 * 「全タイプ」列のセル値('a, b' 形式、'a,b' でも可)を配列にパースする。
 * @param {string|number|undefined|null} cellValue
 * @returns {string[]}
 */
function parsePlaceTypesCell(cellValue) {
  if (cellValue === undefined || cellValue === null || cellValue === '') return [];
  return String(cellValue)
    .split(',')
    .map(function(s) { return s.trim(); })
    .filter(function(s) { return s.length > 0; });
}

/**
 * プローブ集合の被覆状況を集計する。
 *
 * @param {string[][]} typeRows - 各行の types 配列(判定対象外にすべき空行は
 *   呼び出し側で除外してから渡すこと)
 * @param {string[]} probeSet - PLACE_TYPE_PROBE_SET
 * @param {string[]} catalogTypes - ALL_SEARCHABLE_PLACE_TYPES(166種)
 * @returns {{rowCount: number, coveredCount: number, uncoveredRowIndexes: number[],
 *   hitCountByProbeType: Object<string, number>, soleCoverCountByProbeType: Object<string, number>,
 *   catalogTypesNeverObserved: string[], observedNonCatalogTypes: Object<string, number>}}
 */
function summarizeProbeCoverage(typeRows, probeSet, catalogTypes) {
  const hitCountByProbeType = {};
  const soleCoverCountByProbeType = {};
  probeSet.forEach(function(t) {
    hitCountByProbeType[t] = 0;
    soleCoverCountByProbeType[t] = 0;
  });

  const observedCatalogTypes = {};
  const observedNonCatalogTypes = {};
  const uncoveredRowIndexes = [];
  let coveredCount = 0;

  typeRows.forEach(function(types, rowIndex) {
    const probeHits = [];
    types.forEach(function(t) {
      if (catalogTypes.indexOf(t) !== -1) {
        observedCatalogTypes[t] = true;
      } else {
        // food / point_of_interest / establishment など Table A 以外が混ざる。
        // includedTypes には指定できないので候補にはしないが、store のような有力候補を
        // 人間が見つけられるよう頻度だけ別途集計する。
        observedNonCatalogTypes[t] = (observedNonCatalogTypes[t] || 0) + 1;
      }
      if (probeSet.indexOf(t) !== -1) probeHits.push(t);
    });

    if (probeHits.length > 0) {
      coveredCount++;
      probeHits.forEach(function(t) { hitCountByProbeType[t]++; });
      if (probeHits.length === 1) soleCoverCountByProbeType[probeHits[0]]++;
    } else {
      uncoveredRowIndexes.push(rowIndex);
    }
  });

  const catalogTypesNeverObserved = catalogTypes.filter(function(t) {
    return !observedCatalogTypes[t];
  });

  return {
    rowCount: typeRows.length,
    coveredCount: coveredCount,
    uncoveredRowIndexes: uncoveredRowIndexes,
    hitCountByProbeType: hitCountByProbeType,
    soleCoverCountByProbeType: soleCoverCountByProbeType,
    catalogTypesNeverObserved: catalogTypesNeverObserved,
    observedNonCatalogTypes: observedNonCatalogTypes
  };
}

/**
 * 貪欲法(greedy algorithm)で最小被覆集合を求める。
 *
 * 転置インデックス(type → それを含む行番号の配列)を先に作り、各反復で未被覆行を
 * 最も多く新規被覆する候補を選ぶ。同数なら総ヒット数、それも同数なら辞書順で選ぶ
 * (決定的にする = 再実行しても選択順が揺れないことがレビュー上重要)。
 * 新規被覆0の候補しか残っていない場合、または maxSize に達した場合に終了する。
 *
 * @param {string[][]} typeRows
 * @param {string[]} candidateTypes - 候補(通常は ALL_SEARCHABLE_PLACE_TYPES)
 * @param {number} maxSize - 最大選択数(通常は INCLUDED_TYPES_MAX_PER_REQUEST)
 * @returns {{cover: Array<{type: string, newlyCovered: number, totalHits: number}>,
 *   coveredCount: number, uncoveredRowIndexes: number[]}}
 */
function findMinimalProbeCover(typeRows, candidateTypes, maxSize) {
  // 転置インデックス: type → それを含む行番号の配列
  const rowsByType = {};
  candidateTypes.forEach(function(t) { rowsByType[t] = []; });
  typeRows.forEach(function(types, rowIndex) {
    types.forEach(function(t) {
      if (rowsByType[t]) rowsByType[t].push(rowIndex);
    });
  });

  const totalHitsByType = {};
  candidateTypes.forEach(function(t) { totalHitsByType[t] = rowsByType[t].length; });

  // 辞書順タイブレーク: あらかじめソートした順に走査し、厳密な不等号でしか best を
  // 更新しないことで、同数のときは先に見つかった(=辞書順で小さい)候補が残る。
  const sortedCandidates = candidateTypes.slice().sort();

  const coveredRow = {};
  const chosen = {};
  const cover = [];

  while (cover.length < maxSize) {
    let best = null;
    let bestNewlyCovered = 0;
    let bestTotalHits = -1;

    sortedCandidates.forEach(function(t) {
      if (chosen[t]) return;
      let newlyCovered = 0;
      rowsByType[t].forEach(function(rowIndex) {
        if (!coveredRow[rowIndex]) newlyCovered++;
      });
      if (newlyCovered === 0) return;

      const totalHits = totalHitsByType[t];
      if (newlyCovered > bestNewlyCovered || (newlyCovered === bestNewlyCovered && totalHits > bestTotalHits)) {
        best = t;
        bestNewlyCovered = newlyCovered;
        bestTotalHits = totalHits;
      }
    });

    if (!best) break; // これ以上新規被覆できる候補がない

    chosen[best] = true;
    rowsByType[best].forEach(function(rowIndex) { coveredRow[rowIndex] = true; });
    cover.push({ type: best, newlyCovered: bestNewlyCovered, totalHits: bestTotalHits });
  }

  const uncoveredRowIndexes = [];
  typeRows.forEach(function(types, rowIndex) {
    if (!coveredRow[rowIndex]) uncoveredRowIndexes.push(rowIndex);
  });

  return {
    cover: cover,
    coveredCount: typeRows.length - uncoveredRowIndexes.length,
    uncoveredRowIndexes: uncoveredRowIndexes
  };
}
