/**
 * 課金SKUの識別子。無料枠が段ごとに別勘定なので、自前のコール数管理もこの単位で分ける。
 * どのマスクがどのSKUかの判定は lib/api/PlaceSearchFieldMask.js の apiSkuOfFieldMask。
 */
const API_SKU_PRO = 'pro';
const API_SKU_ENTERPRISE = 'enterprise';

/**
 * SKUごとの月間上限(Googleの無料枠と同じ値)と、消費数を記録するスクリプトプロパティ名。
 * 無料枠は段ごとに別勘定なので、カウンタも分けないと調査用のコールが営業用の枠を食い潰す。
 *
 * Enterprise のプロパティ名は変更していない。改名すると運用中のカウントが0に戻り、
 * その月ぶんを二重に消費してしまうため。
 */
const MONTHLY_QUOTA_BY_SKU = {};
MONTHLY_QUOTA_BY_SKU[API_SKU_ENTERPRISE] = {
  limit: 1000,
  countProp: 'MONTHLY_API_CALL_COUNT',
  monthProp: 'MONTHLY_API_CALL_MONTH'
};
MONTHLY_QUOTA_BY_SKU[API_SKU_PRO] = {
  limit: 5000,
  countProp: 'MONTHLY_PRO_API_CALL_COUNT',
  monthProp: 'MONTHLY_PRO_API_CALL_MONTH'
};

/** 営業用(Enterprise)の上限。ログ表示など、SKUを意識しない箇所から参照する。 */
const MONTHLY_API_CALL_LIMIT = MONTHLY_QUOTA_BY_SKU[API_SKU_ENTERPRISE].limit;
const QUOTA_PROP_COUNT = MONTHLY_QUOTA_BY_SKU[API_SKU_ENTERPRISE].countProp;
const QUOTA_PROP_MONTH = MONTHLY_QUOTA_BY_SKU[API_SKU_ENTERPRISE].monthProp;

/**
 * searchNearby の includedTypes に指定できる最大個数(Places API (New) の仕様)。
 * API仕様の定数なので、呼び出しを行うこのファイルに置く(呼び出し側で決め打ちしない)。
 * lib/catalog/PlaceTypeSearchSet.js のプレイスタイプ集合のサイズの上限としても参照される。
 */
const INCLUDED_TYPES_MAX_PER_REQUEST = 50;

/**
 * 指定SKUの月間APIコール数をスクリプトプロパティで自前管理し、上限到達をチェックする。
 * Google Cloud側の割り当て設定の反映タイムラグに関係なく、確実に無料枠で止めるための保険。
 * 月が変わったら自動的にカウントをリセットする。
 *
 * @param {string} sku - API_SKU_PRO または API_SKU_ENTERPRISE
 * @returns {boolean} まだ呼び出し可能なら true、上限到達なら false
 */
function checkAndIncrementApiQuota(sku) {
  const quota = MONTHLY_QUOTA_BY_SKU[sku];
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const savedMonth = scriptProps.getProperty(quota.monthProp);
  let count = parseInt(scriptProps.getProperty(quota.countProp) || '0', 10);

  if (savedMonth !== currentMonth) {
    count = 0; // 月が変わったのでリセット
    scriptProps.setProperty(quota.monthProp, currentMonth);
  }

  if (count >= quota.limit) {
    return false;
  }

  count++;
  scriptProps.setProperty(quota.countProp, String(count));
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
 * @param {string} sku - 加算したときと同じSKU
 * @returns {void}
 */
function refundApiQuota(sku) {
  const quota = MONTHLY_QUOTA_BY_SKU[sku];
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  // 加算と返却のあいだに月をまたいだ場合、返却先のカウンタはもう別の月のもの。
  // 戻すと翌月の枠を1件水増しすることになるので何もしない。
  if (scriptProps.getProperty(quota.monthProp) !== currentMonth) return;

  const count = parseInt(scriptProps.getProperty(quota.countProp) || '0', 10);
  if (count <= 0) return;
  scriptProps.setProperty(quota.countProp, String(count - 1));
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
  // 課金SKUは「どのフィールドを要求したか」で決まるため、fieldMask から導出する。
  // 呼び出し側にSKUを指定させると、マスクとSKUがずれたときに枠を取り違える。
  const sku = apiSkuOfFieldMask(fieldMask);

  // 実際にAPIを叩く直前に、自前の月間上限をチェックする(GCP側の割り当て反映タイムラグ対策)
  if (!checkAndIncrementApiQuota(sku)) {
    return {
      ok: false,
      quotaExceeded: true,
      requestSent: false,
      places: [],
      errorText: '自前の月間上限(' + sku + ': ' + MONTHLY_QUOTA_BY_SKU[sku].limit + '件)に達しました。'
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
    if (isQuotaError) refundApiQuota(sku);

    return { ok: false, quotaExceeded: isQuotaError, requestSent: true, places: [], errorText: errorText };
  }

  const data = JSON.parse(response.getContentText());
  return { ok: true, quotaExceeded: false, requestSent: true, places: data.places || [], errorText: '' };
}
