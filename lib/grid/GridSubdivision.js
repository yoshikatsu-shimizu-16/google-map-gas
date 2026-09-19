/**
 * ===== 密集セルの四分木分割 =====
 *
 * 旧実装は「親の円」を半径0.6倍の4つの円で覆おうとしていたが、子の中心が
 * 親中心から 0.707R 離れているのに子半径が 0.6R しかなく、親中心に半径0.107R
 * (700mなら75m)の穴が空き、親円の 4.51% が未被覆だった。分割が発動するのは
 * 密集セル、つまり店舗が最も濃い場所であり、その中心が抜け落ちていた。
 *
 * 本実装は「親の円」ではなく「親のセル矩形」を4象限に等分し、各象限の外接円を
 * 子の検索範囲とする。矩形は隙間なく分割できるため被覆漏れが原理的に発生せず、
 * かつ1階層あたり半径がちょうど半分になるため、必要な解像度に到達するまでの
 * コール数が理論下限(面積比そのもの)に一致する。
 *
 *   0.01度セル(1,113m × 902m, 半径716m)
 *     → 0.005度セル 4個(556m × 451m, 半径358m)
 *     → 0.0025度セル 16個(半径179m)
 *     → 0.00125度セル 64個(半径90m)
 */

/** 親セルを何分割するか。矩形の4象限に等分する。 */
const CHILD_CELLS_PER_PARENT = 4;

/**
 * 密集セルを4つの子セルに分割し、「グリッド一覧」シートに追記する
 * (階層 = 親の階層+1、処理状況='未処理')。
 * 対象エリアの範囲を大きく超える位置になる子セルは生成しない。
 *
 * @param {Sheet} gridSheet
 * @param {number} parentGridId
 * @param {number} lat - 親セルの中心緯度
 * @param {number} lng - 親セルの中心経度
 * @param {number} parentCellSizeDeg - 親セル1辺の大きさ(度)
 * @param {number} parentTier - 親セルの階層
 * @param {number} nextGridId - 新規グリッドIDの採番開始値
 * @returns {number} 採番後の次の空きグリッドID
 */
function spawnChildGrids(gridSheet, parentGridId, lat, lng, parentCellSizeDeg, parentTier, nextGridId) {
  const childCellSizeDeg = parentCellSizeDeg / 2;
  const offsetDeg = childCellSizeDeg / 2; // 親中心から各象限の中心までのずれ(緯度・経度とも同じ度数)
  const margin = GRID_STEP; // 1グリッド分の余裕は許容し、それを超える子グリッドは作らない

  const quadrants = [
    [1, 1], [1, -1], [-1, 1], [-1, -1] // 北東・北西・南東・南西の4象限
  ];

  const newRows = [];
  let gridId = nextGridId;
  let skipped = 0;
  quadrants.forEach(function(q) {
    const childLat = lat + q[0] * offsetDeg;
    const childLng = lng + q[1] * offsetDeg;

    if (!isWithinTargetArea(childLat, childLng, margin)) {
      skipped++;
      return; // 対象エリアの範囲外なのでこの子グリッドは作らない
    }

    const childRadius = cellCoverRadiusMeters(childCellSizeDeg, childLat);
    newRows.push([
      gridId, childLat, childLng, childRadius, '未処理',
      parentTier + 1, parentGridId, childCellSizeDeg
    ]);
    gridId++;
  });

  if (skipped > 0) {
    Logger.log('グリッド ' + parentGridId + ' の子グリッドのうち ' + skipped + '件は対象エリアの範囲外のため生成をスキップしました。');
  }

  if (newRows.length > 0) {
    const startRow = gridSheet.getLastRow() + 1;
    gridSheet.getRange(startRow, 1, newRows.length, GRID_SHEET_COLUMN_COUNT).setValues(newRows);
  }

  return gridId;
}
