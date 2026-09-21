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

/** 4象限の並び。北東・北西・南東・南西の順で、[緯度の符号, 経度の符号]。 */
const CHILD_QUADRANTS = [
  { label: '北東', latSign: 1, lngSign: 1 },
  { label: '北西', latSign: 1, lngSign: -1 },
  { label: '南東', latSign: -1, lngSign: 1 },
  { label: '南西', latSign: -1, lngSign: -1 }
];

/**
 * 親セルを4象限に等分した子セルの座標と半径を求める(純関数。シートに触らない)。
 *
 * spawnChildGrids はこれを使って「グリッド一覧」に追記するが、調査用の
 * entrypoints/surveySaturatedCells.js は本番の進捗を変えたくないので、
 * 座標だけを受け取って直接APIを叩く。幾何の計算を二重に持たないため分けている。
 *
 * @param {number} lat - 親セルの中心緯度
 * @param {number} lng - 親セルの中心経度
 * @param {number} parentCellSizeDeg - 親セル1辺の大きさ(度)
 * @returns {Array<{label: string, lat: number, lng: number, cellSizeDeg: number, radius: number}>}
 */
function childCellsOf(lat, lng, parentCellSizeDeg) {
  const childCellSizeDeg = parentCellSizeDeg / 2;
  const offsetDeg = childCellSizeDeg / 2; // 親中心から各象限の中心までのずれ(緯度・経度とも同じ度数)

  return CHILD_QUADRANTS.map(function(q) {
    const childLat = lat + q.latSign * offsetDeg;
    const childLng = lng + q.lngSign * offsetDeg;
    return {
      label: q.label,
      lat: childLat,
      lng: childLng,
      cellSizeDeg: childCellSizeDeg,
      radius: cellCoverRadiusMeters(childCellSizeDeg, childLat)
    };
  });
}

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
  const margin = GRID_STEP; // 1グリッド分の余裕は許容し、それを超える子グリッドは作らない

  const newRows = [];
  let gridId = nextGridId;
  let skipped = 0;
  childCellsOf(lat, lng, parentCellSizeDeg).forEach(function(child) {
    if (!isWithinTargetArea(child.lat, child.lng, margin)) {
      skipped++;
      return; // 対象エリアの範囲外なのでこの子グリッドは作らない
    }

    newRows.push([
      gridId, child.lat, child.lng, child.radius, '未処理',
      parentTier + 1, parentGridId, child.cellSizeDeg,
      0 // エラー回数(まだ1回も失敗していない)
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
