/**
 * ===== プレイスタイプ集合による1セルの探索 =====
 *
 * PLACE_TYPE_SEARCH_SET(36種のプレイスタイプ。他を包含する「傘」型を中心に選定)で
 * 1コール投げるだけで、通常のセルはそれで確定する(20件未満、0件を含む)。
 * 20件ちょうど(飽和の疑い)のときは、A/B/C/D への全面フォールバックは行わず、
 * そのまま fineSaturated を立てて呼び出し元(crawlAllGrids)に空間分割
 * (四分木分割)の判断を委ねる。
 *
 * docs/survey-findings-2026-09.md の実測(飽和マス1つあたり: 4分割=5コール、
 * タイプ分割=11コール)により、通常の飽和セルは空間分割の方が安いと判明したため、
 * この経路からはタイプ分割を外した。タイプ分割(lib/crawler/TypeGroupCellSearch.js)は
 * 削除せず残しているが、この経路からは呼び出さない(将来、空間分割の限界に達した
 * セル専用に使う想定。詳細は docs/survey-next-actions-2026-09-20.md を参照)。
 */

/**
 * 1セルをプレイスタイプ集合で探索する。
 *
 * @param {{apiKey: string, fieldMask: string, writer: Object}} search
 * @param {{gridId: number, lat: number, lng: number, radius: number}} cell
 * @returns {{quotaExceeded: boolean, hadFailure: boolean, fineSaturated: boolean,
 *   newRows: number, uncoveredPlaces: Object[],
 *   callLog: Array<{label: string, requestSent: boolean, placeCount: number}>,
 *   placeTypeSetResolved: boolean, placeTypeSetSaturated: boolean, placeTypeSetEmpty: boolean}}
 */
function searchCellByPlaceTypeSet(search, cell) {
  const apiKey = search.apiKey;
  const fieldMask = search.fieldMask;
  const writer = search.writer;
  const gridId = cell.gridId, lat = cell.lat, lng = cell.lng, radius = cell.radius;

  const callLog = [];
  const placeTypeSetResult = callSearchNearby(apiKey, fieldMask, PLACE_TYPE_SEARCH_SET, lat, lng, radius);
  callLog.push({ label: 'placeTypeSet', requestSent: placeTypeSetResult.requestSent, placeCount: placeTypeSetResult.places.length });

  const baseResult = {
    quotaExceeded: false, hadFailure: false, fineSaturated: false, newRows: 0,
    uncoveredPlaces: [], callLog: callLog,
    placeTypeSetResolved: false, placeTypeSetSaturated: false, placeTypeSetEmpty: false
  };

  if (!placeTypeSetResult.ok) {
    if (placeTypeSetResult.quotaExceeded) {
      Logger.log('利用上限に達したと思われるため、処理を中断します。');
      Logger.log('エラー内容: ' + placeTypeSetResult.errorText);
      baseResult.quotaExceeded = true;
      return baseResult;
    }
    Logger.log('グリッド ' + gridId + ' のプレイスタイプ集合検索でエラー: ' + placeTypeSetResult.errorText);
    baseResult.hadFailure = true;
    return baseResult;
  }

  // 飽和したかどうかに関わらず、この検索で取れた店はここで writer に渡す。
  // 既に課金済みのレスポンスなので捨てる理由がない(重複は writer が Place ID で弾く)。
  //
  // あわせて、ここで追加した店に被覆チェック(isCoveredByPlaceTypeSet)をかける。
  // 理屈上 includedTypes: PLACE_TYPE_SEARCH_SET で返ってきた店は必ず被覆されるはずで、
  // ここで引っかかるのは個別セルの問題ではなく、includedTypes が types 配列全体に
  // マッチするという前提そのものが崩れているシグナル。
  let placeTypeSetNewRows = 0;
  placeTypeSetResult.places.forEach(function(place) {
    if (!writer.add(place)) return;
    placeTypeSetNewRows++;
    if (isCoveredByPlaceTypeSet(place.types)) return;
    baseResult.uncoveredPlaces.push(place);
    Logger.log(
      '[被覆漏れ] グリッド ' + gridId + ' の検索結果自体が被覆されません' +
      '(includedTypes のマッチ仕様に関する前提が崩れている疑い): ' +
      (place.displayName ? place.displayName.text : place.id) +
      ' / types=' + (place.types ? place.types.join(', ') : '')
    );
  });

  if (placeTypeSetResult.places.length < MAX_RESULT_COUNT) {
    // 20件未満(0件含む) → 切り捨てが起きていないので、このセルは確定。
    baseResult.newRows = placeTypeSetNewRows;
    baseResult.placeTypeSetResolved = true;
    baseResult.placeTypeSetEmpty = placeTypeSetResult.places.length === 0;
    return baseResult;
  }

  // --- 20件ちょうど: 飽和の疑いがあるため、空間分割(四分木分割)の判断に委ねる ---
  baseResult.newRows = placeTypeSetNewRows;
  baseResult.placeTypeSetSaturated = true;
  baseResult.fineSaturated = true;
  return baseResult;
}
