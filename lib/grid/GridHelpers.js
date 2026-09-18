/**
 * ===== 対象エリアの範囲 =====
 * 対象エリアの四極(最北・最南・最西・最東)の座標から少し余裕を持たせ、
 * 0.01度刻みで揃えている。
 */
const TARGET_AREA_BOUNDS = { latMin: 35.77, latMax: 35.94, lngMin: 139.90, lngMax: 140.12 };
const GRID_STEP = 0.01; // 約1km四方

const MAX_TIER = 3; // 半径細分化の上限階層(これ以上は自動分割せず「要確認」扱いにする)

/**
 * 「グリッド一覧」シートが旧スキーマ(5列: グリッドID〜処理状況のみ)の場合、
 * 既存データを一切変更せずに「階層」「親グリッドID」の2列を追加し、
 * 既存の全行に 階層=0, 親グリッドID='' を補完する。
 *
 * generateGridList を再実行すると進捗(処理状況)がリセットされてしまうため、
 * 既に処理済みのグリッドを保持したまま新しい密集エリア対策ロジックに
 * 対応させるための、後方互換のための自己マイグレーション処理。
 *
 * @param {Sheet} gridSheet - 「グリッド一覧」シートオブジェクト
 * @returns {void}
 */
function ensureGridSchemaMigrated(gridSheet) {
  const lastCol = gridSheet.getLastColumn();
  if (lastCol >= 7) return; // 既に新スキーマ済み

  gridSheet.getRange(1, 6, 1, 2).setValues([['階層', '親グリッドID']]);

  const lastRow = gridSheet.getLastRow();
  if (lastRow > 1) {
    const fillValues = [];
    for (let i = 0; i < lastRow - 1; i++) {
      fillValues.push([0, '']); // 既存グリッドはすべて階層0・親なし扱いにする
    }
    gridSheet.getRange(2, 6, fillValues.length, 2).setValues(fillValues);
  }

  Logger.log('グリッド一覧シートに「階層」「親グリッドID」列を追加しました(既存データは保持)。');
}

/**
 * 密集セル(いずれかのタイプグループがちょうど20件返ってきたセル)を、半径を約6割に縮めた
 * 4つの子グリッドに分割し、「グリッド一覧」シートに新しい行として追加する
 * (階層 = 親の階層+1、処理状況='未処理')。
 * 対象エリアの範囲(TARGET_AREA_BOUNDS)を大きく超える位置になる子グリッドは生成しない。
 *
 * @param {Sheet} gridSheet
 * @param {number} parentGridId
 * @param {number} lat - 親グリッドの中心緯度
 * @param {number} lng - 親グリッドの中心経度
 * @param {number} parentRadius - 親グリッドの半径(m)
 * @param {number} parentTier - 親グリッドの階層
 * @param {number} nextGridId - 新規グリッドIDの採番開始値
 * @returns {number} 採番後の次の空きグリッドID
 */
function spawnChildGrids(gridSheet, parentGridId, lat, lng, parentRadius, parentTier, nextGridId) {
  const offsetMeters = parentRadius / 2;
  const newRadius = Math.round(parentRadius * 0.6); // 少し重なりを持たせて隙間を防ぐ
  const latDelta = metersToLatDelta(offsetMeters);
  const lngDelta = metersToLngDelta(offsetMeters, lat);

  const b = TARGET_AREA_BOUNDS;
  const margin = GRID_STEP; // 1グリッド分の余裕は許容し、それを超える子グリッドは作らない

  const childOffsets = [
    [1, 1], [1, -1], [-1, 1], [-1, -1] // 北東・北西・南東・南西の4方向
  ];

  const newRows = [];
  let gridId = nextGridId;
  let skipped = 0;
  childOffsets.forEach(function(offset) {
    const childLat = lat + offset[0] * latDelta;
    const childLng = lng + offset[1] * lngDelta;

    if (childLat < b.latMin - margin || childLat > b.latMax + margin ||
        childLng < b.lngMin - margin || childLng > b.lngMax + margin) {
      skipped++;
      return; // 対象エリアの範囲外なのでこの子グリッドは作らない
    }

    newRows.push([gridId, childLat, childLng, newRadius, '未処理', parentTier + 1, parentGridId]);
    gridId++;
  });

  if (skipped > 0) {
    Logger.log('グリッド ' + parentGridId + ' の子グリッドのうち ' + skipped + '件は対象エリアの範囲外のため生成をスキップしました。');
  }

  if (newRows.length > 0) {
    const startRow = gridSheet.getLastRow() + 1;
    gridSheet.getRange(startRow, 1, newRows.length, 7).setValues(newRows);
  }

  return gridId;
}

/**
 * メートル単位の距離を、指定した緯度における「経度方向」の度数に変換する。
 * 緯度方向は地球上どこでもほぼ一定(1度 ≈ 111,320m)だが、経度方向は
 * 緯度が高くなるほど1度あたりの距離が短くなるため、cos(緯度) で補正する。
 *
 * @param {number} meters
 * @param {number} atLat - 基準となる緯度(度)
 * @returns {number} 経度の度数
 */
function metersToLngDelta(meters, atLat) {
  const metersPerDegreeLng = 111320 * Math.cos(atLat * Math.PI / 180);
  return meters / metersPerDegreeLng;
}

/**
 * メートル単位の距離を緯度方向の度数に変換する(1度 ≈ 111,320m で近似)。
 * @param {number} meters
 * @returns {number} 緯度の度数
 */
function metersToLatDelta(meters) {
  return meters / 111320;
}
