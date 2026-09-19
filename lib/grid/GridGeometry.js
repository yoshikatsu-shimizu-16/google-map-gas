/**
 * ===== グリッドの幾何計算(純関数) =====
 * SpreadsheetApp に依存しないため、ローカルの Node でそのまま検証できる。
 * tools/verifyGridGeometry.js を参照。
 */

/** 緯度1度あたりの距離(m)。地球上どこでもほぼ一定。 */
const METERS_PER_DEGREE_LAT = 111320;

/**
 * メートル単位の距離を緯度方向の度数に変換する。
 * @param {number} meters
 * @returns {number} 緯度の度数
 */
function metersToLatDelta(meters) {
  return meters / METERS_PER_DEGREE_LAT;
}

/**
 * メートル単位の距離を、指定した緯度における「経度方向」の度数に変換する。
 * 経度は緯度が高くなるほど1度あたりの距離が短くなるため cos(緯度) で補正する。
 *
 * @param {number} meters
 * @param {number} atLat - 基準となる緯度(度)
 * @returns {number} 経度の度数
 */
function metersToLngDelta(meters, atLat) {
  return meters / (METERS_PER_DEGREE_LAT * Math.cos(atLat * Math.PI / 180));
}

/**
 * 正方形(度単位)のセルを過不足なく覆う円の半径(m)、すなわちセル矩形の半対角を返す。
 *
 * セルは「度」で正方形でも、実距離では緯度方向が長い矩形になる(0.01度なら
 * 1,113m × 902m)。その対角線の半分が、セル全体を漏れなく含む最小の円の半径。
 *
 * 検索半径をこの関数からのみ導出することで、半径が独立した値として二重管理
 * されるのを防いでいる(真実源はセルサイズと中心緯度のみ)。
 *
 * @param {number} cellSizeDeg - セル1辺の大きさ(度)
 * @param {number} atLat - セル中心の緯度(度)
 * @returns {number} 半径(m、整数に切り上げ)
 */
function cellCoverRadiusMeters(cellSizeDeg, atLat) {
  const halfLat = METERS_PER_DEGREE_LAT * cellSizeDeg / 2;
  const halfLng = METERS_PER_DEGREE_LAT * Math.cos(atLat * Math.PI / 180) * cellSizeDeg / 2;
  return Math.ceil(Math.sqrt(halfLat * halfLat + halfLng * halfLng));
}

/**
 * 保存されている検索半径から、それが覆っていたセルサイズ(度)を逆算する。
 * cellCoverRadiusMeters の逆関数。旧スキーマの行を新スキーマへ移行する際にのみ使う。
 *
 * @param {number} radiusMeters
 * @param {number} atLat
 * @returns {number} セル1辺の大きさ(度)
 */
function cellSizeDegFromCoverRadius(radiusMeters, atLat) {
  const cosLat = Math.cos(atLat * Math.PI / 180);
  const halfDiagPerDeg = METERS_PER_DEGREE_LAT * Math.sqrt(1 + cosLat * cosLat) / 2;
  return radiusMeters / halfDiagPerDeg;
}
