/**
 * ===== プローブ集合による1セルの探索 =====
 *
 * PLACE_TYPE_PROBE_SET(36種の傘型プローブ)で1コール投げるだけで、通常のセルは
 * それで確定する(20件未満、0件を含む)。20件ちょうど(飽和の疑い)のときは、
 * A/B/C/D への全面フォールバックは行わず、そのまま fineSaturated を立てて
 * 呼び出し元(crawlAllGrids)に空間分割(四分木分割)の判断を委ねる。
 *
 * docs/survey-findings-2026-09.md の実測(飽和マス1つあたり: 4分割=5コール、
 * タイプ分割=11コール)により、通常の飽和セルは空間分割の方が安いと判明したため、
 * この経路からはタイプ分割を外した。タイプ分割(lib/crawler/TypeGroupCellSearch.js)は
 * 削除せず残しているが、この経路からは呼び出さない(将来、空間分割の限界に達した
 * セル専用に使う想定。詳細は docs/survey-next-actions-2026-09-20.md を参照)。
 */

/**
 * 1セルをプローブ集合で探索する。
 *
 * @param {{apiKey: string, fieldMask: string, writer: Object}} search
 * @param {{gridId: number, lat: number, lng: number, radius: number}} cell
 * @returns {{quotaExceeded: boolean, hadFailure: boolean, fineSaturated: boolean,
 *   newRows: number, uncoveredPlaces: Object[],
 *   callLog: Array<{label: string, requestSent: boolean, placeCount: number}>,
 *   probeResolved: boolean, probeSaturated: boolean, probeEmpty: boolean}}
 */
function searchCellByProbeSet(search, cell) {
  const apiKey = search.apiKey;
  const fieldMask = search.fieldMask;
  const writer = search.writer;
  const gridId = cell.gridId, lat = cell.lat, lng = cell.lng, radius = cell.radius;

  const callLog = [];
  const probeResult = callSearchNearby(apiKey, fieldMask, PLACE_TYPE_PROBE_SET, lat, lng, radius);
  callLog.push({ label: 'probe', requestSent: probeResult.requestSent, placeCount: probeResult.places.length });

  const baseResult = {
    quotaExceeded: false, hadFailure: false, fineSaturated: false, newRows: 0,
    uncoveredPlaces: [], callLog: callLog,
    probeResolved: false, probeSaturated: false, probeEmpty: false
  };

  if (!probeResult.ok) {
    if (probeResult.quotaExceeded) {
      Logger.log('利用上限に達したと思われるため、処理を中断します。');
      Logger.log('エラー内容: ' + probeResult.errorText);
      baseResult.quotaExceeded = true;
      return baseResult;
    }
    Logger.log('グリッド ' + gridId + ' のプローブ検索でエラー: ' + probeResult.errorText);
    baseResult.hadFailure = true;
    return baseResult;
  }

  // 飽和したかどうかに関わらず、プローブで取れた店はここで writer に渡す。
  // 既に課金済みのレスポンスなので捨てる理由がない(重複は writer が Place ID で弾く)。
  //
  // あわせて、ここで追加した店に被覆チェック(isCoveredByProbeSet)をかける。
  // 理屈上 includedTypes: PLACE_TYPE_PROBE_SET で返ってきた店は必ず被覆されるはずで、
  // ここで引っかかるのは個別セルの問題ではなく、includedTypes が types 配列全体に
  // マッチするという前提そのものが崩れているシグナル。
  let probeNewRows = 0;
  probeResult.places.forEach(function(place) {
    if (!writer.add(place)) return;
    probeNewRows++;
    if (isCoveredByProbeSet(place.types)) return;
    baseResult.uncoveredPlaces.push(place);
    Logger.log(
      '[被覆漏れ] グリッド ' + gridId + ' のプローブ結果自体が被覆されません' +
      '(includedTypes のマッチ仕様に関する前提が崩れている疑い): ' +
      (place.displayName ? place.displayName.text : place.id) +
      ' / types=' + (place.types ? place.types.join(', ') : '')
    );
  });

  if (probeResult.places.length < 20) {
    // 20件未満(0件含む) → 切り捨てが起きていないので、このセルは確定。
    baseResult.newRows = probeNewRows;
    baseResult.probeResolved = true;
    baseResult.probeEmpty = probeResult.places.length === 0;
    return baseResult;
  }

  // --- 20件ちょうど: 飽和の疑いがあるため、空間分割(四分木分割)の判断に委ねる ---
  baseResult.newRows = probeNewRows;
  baseResult.probeSaturated = true;
  baseResult.fineSaturated = true;
  return baseResult;
}
