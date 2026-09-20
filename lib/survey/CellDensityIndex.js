/**
 * ===== POI をセルに対応付けて件数を引く(純関数) =====
 *
 * Sheet / Logger / API に触らないので、GAS からもローカルの Node からも同じものを使う。
 *
 * 数え方が2つあるのは、問いが2つあるため:
 *   - 矩形で数える … 「このセルが担当する領域に何件あるか」。密度マップの集計はこちら
 *   - 円で数える   … 「このセルを検索したら何か返るか」。実際の検索範囲は矩形を覆う円で、
 *                    隣にはみ出す。セルを飛ばしてよいかの判定はこちらでないと誤る
 */

/**
 * POI をセル矩形に割り当て、「行_列」をキーに件数を返す。
 * 範囲外の POI は無視する(bbox の外縁ぶん)。
 *
 * @param {Array<{lat: number, lng: number}>} pois
 * @param {{latMin: number, lngMin: number}} bounds
 * @param {number} cellSizeDeg
 * @returns {Object<string, number>}
 */
function countPoisByCell(pois, bounds, cellSizeDeg) {
  const countByCell = {};
  pois.forEach(function(poi) {
    const row = Math.floor((poi.lat - bounds.latMin) / cellSizeDeg);
    const col = Math.floor((poi.lng - bounds.lngMin) / cellSizeDeg);
    const key = row + '_' + col;
    countByCell[key] = (countByCell[key] || 0) + 1;
  });
  return countByCell;
}

/**
 * 中心座標から、その POI が属するセルのキーを求める。countPoisByCell と同じ切り方。
 *
 * @param {number} lat
 * @param {number} lng
 * @param {{latMin: number, lngMin: number}} bounds
 * @param {number} cellSizeDeg
 * @returns {string}
 */
function cellKeyOf(lat, lng, bounds, cellSizeDeg) {
  return Math.floor((lat - bounds.latMin) / cellSizeDeg) + '_' +
         Math.floor((lng - bounds.lngMin) / cellSizeDeg);
}

/**
 * 指定した円の中にある POI の数を数える。実際の searchNearby と同じ範囲なので、
 * 「このセルを検索しても何も返らないはず」という判定はこちらを使う。
 *
 * @param {Array<{lat: number, lng: number}>} pois
 * @param {number} lat - 円の中心
 * @param {number} lng - 円の中心
 * @param {number} radiusMeters
 * @returns {number}
 */
function countPoisWithinRadius(pois, lat, lng, radiusMeters) {
  let count = 0;
  pois.forEach(function(poi) {
    if (distanceMeters(lat, lng, poi.lat, poi.lng) <= radiusMeters) count++;
  });
  return count;
}
