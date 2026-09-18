const MONTHLY_API_CALL_LIMIT = 1000; // 自前の月間上限(無料枠と合わせる)
const QUOTA_PROP_COUNT = 'MONTHLY_API_CALL_COUNT';
const QUOTA_PROP_MONTH = 'MONTHLY_API_CALL_MONTH';

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
 * 指定した中心座標・半径・タイプで Nearby Search (New) を1回呼び出す薄いラッパー。
 * クォータ超過の判定もここで行い、呼び出し側は戻り値の quotaExceeded だけ見ればよいようにする。
 *
 * @param {string} apiKey
 * @param {string} fieldMask
 * @param {string[]} includedTypes
 * @param {number} lat
 * @param {number} lng
 * @param {number} radius - メートル単位
 * @returns {{ok: boolean, quotaExceeded: boolean, places: Object[], errorText: string}}
 */
function callSearchNearby(apiKey, fieldMask, includedTypes, lat, lng, radius) {
  // 実際にAPIを叩く直前に、自前の月間上限をチェックする(GCP側の割り当て反映タイムラグ対策)
  if (!checkAndIncrementApiQuota()) {
    return {
      ok: false,
      quotaExceeded: true,
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

    return { ok: false, quotaExceeded: isQuotaError, places: [], errorText: errorText };
  }

  const data = JSON.parse(response.getContentText());
  return { ok: true, quotaExceeded: false, places: data.places || [], errorText: '' };
}
