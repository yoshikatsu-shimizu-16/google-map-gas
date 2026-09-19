/**
 * ===== 対象エリアの範囲 =====
 * 対象エリアの四極(最北・最南・最西・最東)の座標から少し余裕を持たせ、
 * 0.01度刻みで揃えている。
 */
const TARGET_AREA_BOUNDS = { latMin: 35.77, latMax: 35.94, lngMin: 139.90, lngMax: 140.12 };

/** 階層0のセル1辺の大きさ(度)。緯度方向 約1,113m / 経度方向 約902m の矩形になる。 */
const GRID_STEP = 0.01;

/** 半径細分化の上限階層(これ以上は自動分割せず「要確認」扱いにする)。階層3で半径約90m。 */
const MAX_TIER = 3;

/**
 * セルの中心座標が探索対象に含まれるかを判定する。
 *
 * 現在は「対象エリアは柏市付近」という定義のため矩形判定のみだが、
 * 将来この1関数を差し替えるだけで市域ポリゴンや円形マスクに移行できるよう、
 * 判定をここに集約している。子グリッド生成時のはみ出し許容分だけ余裕を持たせる。
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} [marginDeg] - 境界の外側に許容する余裕(度)。省略時は余裕なし。
 * @returns {boolean}
 */
function isWithinTargetArea(lat, lng, marginDeg) {
  const m = marginDeg || 0;
  const b = TARGET_AREA_BOUNDS;
  return lat >= b.latMin - m && lat <= b.latMax + m &&
         lng >= b.lngMin - m && lng <= b.lngMax + m;
}
