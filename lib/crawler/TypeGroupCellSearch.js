/**
 * ===== タイプグループ(A/B/C/D)による1セルの探索 =====
 *
 * 旧 crawlAllGrids.js:145-204 の移設(挙動は変えていない)。
 * tools/verifyCrawlerOnStubs.js の既存アサートが無改変で通ることが、この移設が
 * リグレッションを起こしていないことの回帰テストになっている。
 *
 * SEARCH_STRATEGY=type_groups の間はこの関数が唯一の探索経路になり、
 * SEARCH_STRATEGY=probe の間は ProbeFirstCellSearch.js が20件飽和セルの
 * フォールバック先として呼び出す。
 *
 * 移設にあわせて1点だけ副作用を追加している: このセルで新規に取得した各 place に
 * ついて isCoveredByProbeSet をかけ、被覆されなければ警告ログを出し、戻り値の
 * uncoveredPlaces に積む。旧方式のまま運用していても、将来プローブ集合へ切り替えた
 * ときの被覆漏れリスクを追加コールなしで継続的に検知できる
 * (docs/Overview.js のリスク表を参照)。
 */

/** タイプグループのインデックスとログ表示ラベルの対応。callLog のラベルとしても使う。 */
const TYPE_GROUP_LABELS = ['A', 'B', 'C', 'D'];

/**
 * 1セルを頻度別グループ(A/B/C/D)で探索する。20件に達したグループはさらに
 * タイプ分割して再検索する。
 *
 * @param {{apiKey: string, fieldMask: string, writer: Object}} search
 * @param {{gridId: number, lat: number, lng: number, radius: number}} cell
 * @returns {{quotaExceeded: boolean, hadFailure: boolean, emptyByGroupA: boolean,
 *   baseSaturated: boolean, fineSaturated: boolean, newRows: number,
 *   uncoveredPlaces: Object[],
 *   callLog: Array<{label: string, requestSent: boolean, placeCount: number}>}}
 */
function searchCellByTypeGroups(search, cell) {
  const apiKey = search.apiKey;
  const fieldMask = search.fieldMask;
  const writer = search.writer;
  const gridId = cell.gridId, lat = cell.lat, lng = cell.lng, radius = cell.radius;

  const callLog = [];
  const uncoveredPlaces = [];
  let newRows = 0;
  let quotaExceeded = false;
  let hadFailure = false;
  let emptyByGroupA = false;
  let baseSaturated = false;
  let fineSaturated = false;

  /**
   * 新規取得した place を writer に渡し、プローブ集合で被覆されるかを検証する。
   * @param {Object} place
   */
  const addPlace = function(place) {
    if (!writer.add(place)) return;
    newRows++;
    if (!isCoveredByProbeSet(place.types)) {
      uncoveredPlaces.push(place);
      Logger.log(
        '[被覆漏れ] グリッド ' + gridId + ' の店舗がプローブ集合で被覆されません: ' +
        (place.displayName ? place.displayName.text : place.id) +
        ' / types=' + (place.types ? place.types.join(', ') : '')
      );
    }
  };

  for (let g = 0; g < BASE_TYPE_GROUPS.length; g++) {
    const groupTypes = BASE_TYPE_GROUPS[g];
    const groupResult = callSearchNearby(apiKey, fieldMask, groupTypes, lat, lng, radius);
    callLog.push({ label: TYPE_GROUP_LABELS[g], requestSent: groupResult.requestSent, placeCount: groupResult.places.length });

    if (!groupResult.ok) {
      if (groupResult.quotaExceeded) {
        Logger.log('利用上限に達したと思われるため、処理を中断します。');
        Logger.log('エラー内容: ' + groupResult.errorText);
        quotaExceeded = true;
        break;
      }
      Logger.log('グリッド ' + gridId + ' のグループ検索でエラー: ' + groupResult.errorText);
      hadFailure = true;
      continue;
    }

    groupResult.places.forEach(addPlace);

    // グループA(頻出39種)が0件なら、このセルには飲食店が存在しないとみなし
    // B/C/Dの3コールを省略する。稀タイプだけが存在するセルを取りこぼす可能性が
    // ゼロではないため、後から再掃討できるよう専用ステータスで区別する。
    if (g === 0 && groupResult.places.length === 0) {
      emptyByGroupA = true;
      break;
    }

    if (groupResult.places.length < 20) continue; // このグループは20件未満なので分割不要
    baseSaturated = true;

    // --- 20件に達したグループだけ、さらに細分化して検索(タイプ分割) ---
    const subGroups = splitTypeGroupForDenseArea(groupTypes);
    let thisGroupStillSaturated = false;
    for (let s = 0; s < subGroups.length; s++) {
      const subResult = callSearchNearby(apiKey, fieldMask, subGroups[s], lat, lng, radius);
      callLog.push({ label: 'split', requestSent: subResult.requestSent, placeCount: subResult.places.length });
      if (!subResult.ok) {
        if (subResult.quotaExceeded) {
          Logger.log('利用上限に達したと思われるため、処理を中断します。');
          Logger.log('エラー内容: ' + subResult.errorText);
          quotaExceeded = true;
          break;
        }
        Logger.log('グリッド ' + gridId + ' のタイプ分割検索でエラー: ' + subResult.errorText);
        continue;
      }
      subResult.places.forEach(addPlace);
      if (subResult.places.length >= 20) thisGroupStillSaturated = true;
    }
    if (quotaExceeded) break;
    if (thisGroupStillSaturated) fineSaturated = true;
  }

  return {
    quotaExceeded: quotaExceeded,
    hadFailure: hadFailure,
    emptyByGroupA: emptyByGroupA,
    baseSaturated: baseSaturated,
    fineSaturated: fineSaturated,
    newRows: newRows,
    uncoveredPlaces: uncoveredPlaces,
    callLog: callLog
  };
}
