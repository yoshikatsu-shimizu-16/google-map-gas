const MONTHLY_API_CALL_LIMIT = 1000; // 自前の月間上限(無料枠と合わせる)
const QUOTA_PROP_COUNT = 'MONTHLY_API_CALL_COUNT';
const QUOTA_PROP_MONTH = 'MONTHLY_API_CALL_MONTH';

/**
 * searchNearby の includedTypes に指定できる最大個数(Places API (New) の仕様)。
 * API仕様の定数なので、呼び出しを行うこのファイルに置く(呼び出し側で決め打ちしない)。
 * lib/catalog/PlaceTypeProbeSet.js のプローブ集合サイズの上限としても参照される。
 */
const INCLUDED_TYPES_MAX_PER_REQUEST = 50;

/**
 * 月間APIコール数をスクリプトプロパティで自前管理し、上限到達をチェックする。
 * Google Cloud側の割り当て設定の反映タイムラグに関係なく、確実に月1000件で止めるための保険。
 * 月が変わったら自動的にカウントをリセットする。
 *
 * @returns {boolean} まだ呼び出し可能なら true、上限到達なら false
 */
function checkAndIncrementApiQuota() {
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const savedMonth = scriptProps.getProperty(QUOTA_PROP_MONTH);
  let count = parseInt(scriptProps.getProperty(QUOTA_PROP_COUNT) || '0', 10);

  if (savedMonth !== currentMonth) {
    count = 0; // 月が変わったのでリセット
    scriptProps.setProperty(QUOTA_PROP_MONTH, currentMonth);
  }

  if (count >= MONTHLY_API_CALL_LIMIT) {
    return false;
  }

  count++;
  scriptProps.setProperty(QUOTA_PROP_COUNT, String(count));
  return true;
}

/**
 * クォータ超過で弾かれた1件ぶんのカウントを自前カウンタから戻す。
 *
 * checkAndIncrementApiQuota は「実際に叩く前」に数える。暴走を確実に止めるにはこの順序が
 * 正しいが、その代償として Google 側のクォータで 429 になった分まで自前の月間枠を
 * 消費してしまう。429(RESOURCE_EXHAUSTED)はリクエストが処理されていない = 課金対象外
 * なので、枠を戻さないと「1回も店を取れていないのに月間枠だけ減る」ことになる。
 *
 * 日次トリガーは GCP 側の日次クォータ(SearchNearbyRequestPerDayPerProject)を使い切った
 * 翌実行で必ずこれを踏むため、放置すると毎日1件ずつ月間1,000の枠が溶ける。
 *
 * 戻すのはクォータ起因の拒否だけに限る。他のエラー(不正リクエスト等)は課金の有無が
 * 仕様として自明でないうえ、戻すと暴走時に上限が効かなくなるため、あえて数えたままにする。
 *
 * @returns {void}
 */
function refundApiQuota() {
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  // 加算と返却のあいだに月をまたいだ場合、返却先のカウンタはもう別の月のもの。
  // 戻すと翌月の枠を1件水増しすることになるので何もしない。
  if (scriptProps.getProperty(QUOTA_PROP_MONTH) !== currentMonth) return;

  const count = parseInt(scriptProps.getProperty(QUOTA_PROP_COUNT) || '0', 10);
  if (count <= 0) return;
  scriptProps.setProperty(QUOTA_PROP_COUNT, String(count - 1));
}

/**
 * 指定した中心座標・半径・タイプで Nearby Search (New) を1回呼び出す薄いラッパー。
 * クォータ超過の判定もここで行い、呼び出し側は戻り値の quotaExceeded だけ見ればよいようにする。
 *
 * @param {string} apiKey
 * @param {string} fieldMask
 * @param {string[]} includedTypes
 * @param {number} lat
 * @param {number} lng
 * @param {number} radius - メートル単位
 * @returns {{ok: boolean, quotaExceeded: boolean, requestSent: boolean, places: Object[], errorText: string}}
 *   requestSent は実際にHTTPリクエストを送ったかどうか。自前の月間上限で手前で止めた場合は
 *   false になる。呼び出し側がコール数を計測する際、送っていない分を数えないために使う。
 */
function callSearchNearby(apiKey, fieldMask, includedTypes, lat, lng, radius) {
  // 実際にAPIを叩く直前に、自前の月間上限をチェックする(GCP側の割り当て反映タイムラグ対策)
  if (!checkAndIncrementApiQuota()) {
    return {
      ok: false,
      quotaExceeded: true,
      requestSent: false,
      places: [],
      errorText: '自前の月間上限(' + MONTHLY_API_CALL_LIMIT + '件)に達しました。'
    };
  }

  const url = 'https://places.googleapis.com/v1/places:searchNearby';
  const payload = {
    includedTypes: includedTypes,
    maxResultCount: 20, // Nearby Search (New) 1回あたりの最大取得件数(この値が「20件の壁」)
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radius
      }
    },
    languageCode: 'ja',
    regionCode: 'JP'
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    const errorText = response.getContentText();
    const isQuotaError = responseCode === 429 ||
      errorText.indexOf('RESOURCE_EXHAUSTED') !== -1 ||
      errorText.indexOf('Quota exceeded') !== -1 ||
      errorText.indexOf('quota') !== -1;

    // 課金されていない分まで自前の月間枠を減らしたままにしない(refundApiQuota 参照)
    if (isQuotaError) refundApiQuota();

    return { ok: false, quotaExceeded: isQuotaError, requestSent: true, places: [], errorText: errorText };
  }

  const data = JSON.parse(response.getContentText());
  return { ok: true, quotaExceeded: false, requestSent: true, places: data.places || [], errorText: '' };
}
