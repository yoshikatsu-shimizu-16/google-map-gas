/**
 * ===== グリッド検索円の重複解析(純関数) =====
 * SpreadsheetApp/Logger に依存しないため、ローカルの Node でそのまま検証できる。
 * tools/verifyGridOverlapAnalysis.js を参照。
 *
 * 「グリッド一覧」の各行は searchNearby に渡した検索円(中心緯度経度・半径)を表す。
 * 旧ロジック(親円を0.6倍の4円で覆う方式)は、docs/Overview.js に記録している通り
 * 兄弟円どうしが幾何的に重なる設計だった(隣接する2つの子円は、中心間距離が
 * 半径の和より小さくなるため必ず重なる)。ここでは実際にどの行同士がどれだけ
 * 重なっているかを定量化する(Issue #24)。
 */

/**
 * 2つの円の共通部分の面積(m^2)。
 * @param {number} d - 中心間の距離(m)
 * @param {number} r1 - 円1の半径(m)
 * @param {number} r2 - 円2の半径(m)
 * @returns {number}
 */
function circleIntersectionArea(d, r1, r2) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) {
    const rMin = Math.min(r1, r2);
    return Math.PI * rMin * rMin;
  }
  const part1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const part2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const part3 = 0.5 * Math.sqrt(
    Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  );
  return part1 + part2 - part3;
}

/**
 * 2つの検索円の重複率(小さい方の円の面積に対する共通部分の割合、0〜1)。
 * 「重複率が高い」= 小さい方の円がほぼ丸ごと大きい方の円に含まれる = 小さい方の
 * コールがほぼ無駄になっている、とみなせる。
 *
 * @param {{lat:number, lng:number, radius:number}} a
 * @param {{lat:number, lng:number, radius:number}} b
 * @returns {number}
 */
function overlapFraction(a, b) {
  const d = distanceMeters(a.lat, a.lng, b.lat, b.lng);
  if (d >= a.radius + b.radius) return 0;
  const intersection = circleIntersectionArea(d, a.radius, b.radius);
  const rMin = Math.min(a.radius, b.radius);
  const smallerArea = Math.PI * rMin * rMin;
  if (smallerArea <= 0) return 0;
  return intersection / smallerArea;
}

/**
 * セル配列から、重複率が閾値以上のペアを列挙する。O(n^2) の総当たりだが、
 * 対象は数千行程度を想定しており(全域調査の実績で638〜2,668行)、
 * 座標による索引付けをしなくても実用上の時間で終わる。
 *
 * @param {Array<{gridId:number, lat:number, lng:number, radius:number, tier:number}>} cells
 * @param {{minFraction: number}} [options] - 報告する重複率の下限(既定 0.2)
 * @returns {Array<{aId:number, bId:number, distance:number, fraction:number, aTier:number, bTier:number}>}
 *   fraction の降順
 */
function findOverlappingPairs(cells, options) {
  const minFraction = (options && options.minFraction != null) ? options.minFraction : 0.2;
  const pairs = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      // 半径の和より明らかに離れていれば重ならないので、distanceMeters の
      // 三角関数呼び出しをする前に緯度経度のラフな差分で足切りする。
      if (Math.abs(a.lat - b.lat) > 0.03 || Math.abs(a.lng - b.lng) > 0.03) continue;
      const fraction = overlapFraction(a, b);
      if (fraction >= minFraction) {
        pairs.push({
          aId: a.gridId, bId: b.gridId,
          distance: distanceMeters(a.lat, a.lng, b.lat, b.lng),
          fraction: fraction, aTier: a.tier, bTier: b.tier
        });
      }
    }
  }
  pairs.sort(function(x, y) { return y.fraction - x.fraction; });
  return pairs;
}

/**
 * 階層0のセルについて、保存されている半径が現行コード(cellCoverRadiusMeters)の
 * 計算値と一致するかを突き合わせる。旧い generateGridList が半径700mを決め打ちして
 * いた時代(コミット 84b54f1 より前)に生成された行は、現行の計算値
 * (対象エリアの緯度帯で約716〜717m)と食い違う。
 *
 * @param {Array<{gridId:number, lat:number, radius:number, tier:number}>} cells
 * @param {number} gridStep - GRID_STEP(セル1辺の大きさ、度)
 * @returns {Array<{gridId:number, storedRadius:number, expectedRadius:number, diff:number}>}
 */
function findRootRadiusMismatches(cells, gridStep) {
  const mismatches = [];
  cells.forEach(function(c) {
    if ((c.tier || 0) !== 0) return;
    const expected = cellCoverRadiusMeters(gridStep, c.lat);
    const diff = expected - c.radius;
    if (Math.abs(diff) >= 1) {
      mismatches.push({ gridId: c.gridId, storedRadius: c.radius, expectedRadius: expected, diff: diff });
    }
  });
  return mismatches;
}
