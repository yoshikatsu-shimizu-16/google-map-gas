/**
 * ===== プローブ集合優先による1セルの探索 =====
 *
 * PLACE_TYPE_PROBE_SET で1コール投げ、20件未満(0件を含む)ならそのセルは確定する。
 * 20件ちょうど(飽和の疑い)のときだけ searchCellByTypeGroups に完全フォールバックし、
 * 従来どおり A/B/C/D(+必要ならタイプ分割)で網羅する。
 *
 * この設計により、飽和セルの挙動は現行(SEARCH_STRATEGY=type_groups)と完全に同一になる
 * (プローブ1コールが上乗せされるだけ)。リコール低下が起こり得るのは「総数20件未満の
 * セル」に限られ、そこは原理的に20件の壁による切り捨てが起きない。四分木分割の判定
 * (crawlAllGrids 側、変更なし)は fineSaturated/baseSaturated を見て行うため、
 * プローブで確定したセルは子グリッドを生成しない。
 */

/**
 * 1セルをプローブ集合優先で探索する。
 *
 * @param {{apiKey: string, fieldMask: string, writer: Object}} search
 * @param {{gridId: number, lat: number, lng: number, radius: number}} cell
 * @returns {{quotaExceeded: boolean, hadFailure: boolean, emptyByGroupA: boolean,
 *   baseSaturated: boolean, fineSaturated: boolean, newRows: number,
 *   uncoveredPlaces: Object[],
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
    quotaExceeded: false, hadFailure: false, emptyByGroupA: false,
    baseSaturated: false, fineSaturated: false, newRows: 0,
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

  // 理屈上、includedTypes: PLACE_TYPE_PROBE_SET で返ってきた店は必ずプローブ集合で
  // 被覆されるはず。false が出た場合は個別セルの問題ではなく、includedTypes の
  // マッチ仕様に関する前提そのものが崩れているシグナルなので、コスト0の自己検証として
  // 警告だけ出す(セルの処理自体は続行する)。
  probeResult.places.forEach(function(place) {
    if (!isCoveredByProbeSet(place.types)) {
      Logger.log(
        '[前提崩壊の疑い] グリッド ' + gridId + ' のプローブ結果自体が被覆されません: ' +
        (place.displayName ? place.displayName.text : place.id) +
        ' / types=' + (place.types ? place.types.join(', ') : '')
      );
    }
  });

  if (probeResult.places.length < 20) {
    // 20件未満(0件含む) → 切り捨てが起きていないので、このセルは確定。
    let newRows = 0;
    probeResult.places.forEach(function(place) { if (writer.add(place)) newRows++; });
    baseResult.newRows = newRows;
    baseResult.probeResolved = true;
    baseResult.probeEmpty = probeResult.places.length === 0;
    return baseResult;
  }

  // --- 20件ちょうど: 飽和の疑いがあるため旧方式に完全フォールバック ---
  const fallback = searchCellByTypeGroups(search, cell);
  return {
    quotaExceeded: fallback.quotaExceeded,
    hadFailure: fallback.hadFailure,
    emptyByGroupA: fallback.emptyByGroupA,
    baseSaturated: fallback.baseSaturated,
    fineSaturated: fallback.fineSaturated,
    newRows: fallback.newRows,
    uncoveredPlaces: fallback.uncoveredPlaces,
    callLog: callLog.concat(fallback.callLog),
    probeResolved: false,
    probeSaturated: true,
    probeEmpty: false
  };
}
