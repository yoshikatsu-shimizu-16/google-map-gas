/**
 * ===== 対象エリア 店舗情報取得ワークフロー =====
 * 指定したカテゴリの店舗情報を対象エリア全体で収集する。
 * 実際の処理順序:
 *   1. generateGridList  ... 対象エリア全体をグリッド分割し、「グリッド一覧」シートに座標を保存
 *   2. crawlAllGrids     ... グリッド一覧を巡回して searchNearby を呼び出し、「全店舗データ」シートに書き込み
 *   3. writeToSheet      ... (出力整形用ヘルパー。ヘッダー・フィルタ設定などの共通処理)
 *
 * searchRestaurants は初期の単一エリアテスト用に使っていた関数。
 * 現在は上記のグリッド巡回ワークフローに統合済みのため、非推奨として末尾に残している。
 *
 * 参照: Google Maps Platform - Place Types (New) - Food and Drink カテゴリ一覧
 * https://developers.google.com/maps/documentation/places/web-service/place-types
 * (2026-09-10 UTC 時点のドキュメントを参照。includedTypes は Table A のタイプのみ指定可能。
 *  1リクエストの includedTypes は最大50個までという制約があるため、Food and Drink全166種類は
 *  1回のリクエストに収まらない。そのため頻度別に4グループ(A/B/C/D、各50種以内)に分割している。
 *  詳細は下記 TYPE_GROUP_A 〜 D の定義を参照。)
 *
 * ===== 密集エリア対策(20件の壁への対応) =====
 * Nearby Search (New) は pageToken (ページング) が非サポートのため、
 * 1回のリクエストで maxResultCount(20件)を超える分は原理的に取得できない。
 * これに対応するため、以下の2段構えの対策を行っている。
 *
 *   (1) 頻度別グループ検索 + タイプ分割: まず頻度別4グループ(A:頻出39種 / B:中頻度41種 /
 *       C:やや稀37種 / D:非常に稀49種)でそれぞれ検索する(必ず4回)。20件ちょうど返ってきた
 *       (切り捨ての疑いがある)グループだけ、さらに6種類ずつの小グループに細分化して再検索する。
 *       密集判定の主犯になるのはほぼ常にグループA(頻出ジャンル)で、B/C/Dは束ねても20件に
 *       達することは稀なため、無駄なゼロ件リクエストを最小化しつつ全166タイプを網羅できる。
 *       駅前の雑居ビルのように「1棟に何十店舗も入っている」ケースは、
 *       半径を縮めても解決しないため、カテゴリ単位で別枠の上位20件を
 *       確保できるこの方式が有効。
 *
 *   (2) 半径の自動細分化: タイプ分割してもなお20件ちょうど返ってくる
 *       小グループがあれば、そのグリッドを半径約6割・中心をずらした
 *       4つの子グリッドに分割し、「グリッド一覧」に追加する(階層+1)。
 *       階層が MAX_TIER に達してもまだ20件出る場合は、これ以上の自動化は
 *       行わず「要確認(上限到達)」フラグを立てて人間の目視確認に委ねる。
 *
 * 上記の対策をもってしても、Googleのデータベースに未掲載の店や、
 * それでも取りこぼす極端な密集地は残り得る。完全網羅ではなく
 * 「現実的に拾える範囲を最大化する」ことがゴールである点に留意。
 *
 * ===== 自前の月間APIコール上限(2026-09-17 追加) =====
 * Google Cloud側の割り当て(Quotas)設定は反映にタイムラグがあるため、
 * それとは別にスクリプトプロパティで月間コール数を自前管理し、
 * MONTHLY_API_CALL_LIMIT に達したら callSearchNearby がAPIを叩く前に
 * 自ら停止する二重の安全策を入れている。月が変わると自動的にリセットされる。
 */

const MAX_TIER = 3; // 半径細分化の上限階層(これ以上は自動分割せず「要確認」扱いにする)

const MONTHLY_API_CALL_LIMIT = 1000; // 自前の月間上限(無料枠と合わせる)
const QUOTA_PROP_COUNT = 'MONTHLY_API_CALL_COUNT';
const QUOTA_PROP_MONTH = 'MONTHLY_API_CALL_MONTH';

/**
 * ===== 対象エリアの範囲 =====
 * 対象エリアの四極(最北・最南・最西・最東)の座標から少し余裕を持たせ、
 * 0.01度刻みで揃えている。
 */
const TARGET_AREA_BOUNDS = { latMin: 35.77, latMax: 35.94, lngMin: 139.90, lngMax: 140.12 };
const GRID_STEP = 0.01; // 約1km四方

/**
 * ===== 検索対象タイプ(includedTypes)の頻度別4グループ =====
 * 出典: Google Maps Platform - Place Types (New) - Food and Drink カテゴリ全166種類
 * https://developers.google.com/maps/documentation/places/web-service/place-types
 *
 * 1リクエストの includedTypes は最大50個までのため、全166種類を1回では指定できない。
 * さらに、単純に50種ずつ機械的に分けるのではなく、日本国内(対象エリア)での出現頻度別に分けている:
 *   TYPE_GROUP_A: 頻出(日本でよく見る一般的なジャンル、39種) → 密集判定の主犯になりやすい
 *   TYPE_GROUP_B: 中頻度(41種)
 *   TYPE_GROUP_C: やや稀(37種)
 *   TYPE_GROUP_D: 非常に稀、日本にはほぼ存在しない各国料理など(49種)
 * B/C/Dは束ねても20件の壁に達することが稀なため、実際にタイプ分割(細分化)が発動するのは
 * ほぼグループAのみになり、無駄なゼロ件リクエストを抑えつつ全タイプを網羅できる設計。
 */
const TYPE_GROUP_A = [
  'restaurant', 'japanese_restaurant', 'family_restaurant', 'fine_dining_restaurant', 'diner',
  'japanese_izakaya_restaurant', 'bar', 'pub', 'ramen_restaurant', 'sushi_restaurant',
  'yakiniku_restaurant', 'yakitori_restaurant', 'cafe', 'coffee_shop', 'bakery',
  'chinese_restaurant', 'korean_restaurant', 'italian_restaurant', 'french_restaurant', 'thai_restaurant',
  'fast_food_restaurant', 'food_court', 'meal_takeaway', 'meal_delivery', 'japanese_curry_restaurant',
  'tonkatsu_restaurant', 'seafood_restaurant', 'pizza_restaurant', 'hamburger_restaurant', 'steak_house',
  'sandwich_shop', 'ice_cream_shop', 'dessert_shop', 'donut_shop', 'cake_shop',
  'buffet_restaurant', 'indian_restaurant', 'vietnamese_restaurant', 'hot_pot_restaurant'
];

const TYPE_GROUP_B = [
  'american_restaurant', 'asian_restaurant', 'asian_fusion_restaurant', 'bar_and_grill', 'barbecue_restaurant',
  'beer_garden', 'bistro', 'breakfast_restaurant', 'brunch_restaurant', 'cafeteria',
  'candy_store', 'cat_cafe', 'chicken_restaurant', 'chinese_noodle_restaurant', 'chocolate_shop',
  'cocktail_bar', 'coffee_stand', 'confectionery', 'deli', 'dessert_restaurant',
  'dim_sum_restaurant', 'dog_cafe', 'dumpling_restaurant', 'juice_shop', 'kebab_shop',
  'korean_barbecue_restaurant', 'mediterranean_restaurant', 'mexican_restaurant', 'noodle_shop', 'pastry_shop',
  'pizza_delivery', 'salad_shop', 'snack_bar', 'soup_restaurant', 'sports_bar',
  'taiwanese_restaurant', 'tea_house', 'vegan_restaurant', 'vegetarian_restaurant', 'western_restaurant',
  'wine_bar'
];

const TYPE_GROUP_C = [
  'acai_shop', 'bagel_shop', 'brazilian_restaurant', 'brewery', 'brewpub',
  'burrito_restaurant', 'cantonese_restaurant', 'chicken_wings_restaurant', 'coffee_roastery', 'european_restaurant',
  'filipino_restaurant', 'fish_and_chips_restaurant', 'fusion_restaurant', 'gastropub', 'german_restaurant',
  'greek_restaurant', 'gyro_restaurant', 'halal_restaurant', 'hawaiian_restaurant', 'hot_dog_restaurant',
  'indonesian_restaurant', 'irish_pub', 'latin_american_restaurant', 'lebanese_restaurant', 'lounge_bar',
  'malaysian_restaurant', 'middle_eastern_restaurant', 'north_indian_restaurant', 'oyster_bar_restaurant', 'pakistani_restaurant',
  'polish_restaurant', 'south_indian_restaurant', 'spanish_restaurant', 'sri_lankan_restaurant', 'taco_restaurant',
  'tapas_restaurant', 'turkish_restaurant'
];

const TYPE_GROUP_D = [
  'afghani_restaurant', 'african_restaurant', 'argentinian_restaurant', 'australian_restaurant', 'austrian_restaurant',
  'bangladeshi_restaurant', 'basque_restaurant', 'bavarian_restaurant', 'belgian_restaurant', 'british_restaurant',
  'burmese_restaurant', 'cajun_restaurant', 'californian_restaurant', 'cambodian_restaurant', 'caribbean_restaurant',
  'chilean_restaurant', 'chocolate_factory', 'colombian_restaurant', 'croatian_restaurant', 'cuban_restaurant',
  'czech_restaurant', 'danish_restaurant', 'dutch_restaurant', 'eastern_european_restaurant', 'ethiopian_restaurant',
  'falafel_restaurant', 'fondue_restaurant', 'hookah_bar', 'hot_dog_stand', 'hungarian_restaurant',
  'irish_restaurant', 'israeli_restaurant', 'mongolian_barbecue_restaurant', 'moroccan_restaurant', 'persian_restaurant',
  'peruvian_restaurant', 'portuguese_restaurant', 'romanian_restaurant', 'russian_restaurant', 'scandinavian_restaurant',
  'shawarma_restaurant', 'soul_food_restaurant', 'south_american_restaurant', 'southwestern_us_restaurant', 'swiss_restaurant',
  'tex_mex_restaurant', 'tibetan_restaurant', 'ukrainian_restaurant', 'winery'
];

const BASE_TYPE_GROUPS = [TYPE_GROUP_A, TYPE_GROUP_B, TYPE_GROUP_C, TYPE_GROUP_D];
const DENSE_SPLIT_CHUNK_SIZE = 6; // 20件に達したグループを、この件数ずつのさらに小さいグループに分割する

/**
 * 配列を指定サイズごとの小さい配列の配列に分割するユーティリティ。
 * 密集判定されたタイプグループをさらに細分化する際に使う。
 *
 * @param {Array} arr
 * @param {number} size
 * @returns {Array[]}
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * 対象エリア全体をだいたいカバーする緯度経度の範囲を、約1km四方のグリッド(格子)に分割し、
 * 各グリッドの中心座標・検索半径・処理状況を「グリッド一覧」シートに書き出す。
 *
 * このシートは crawlAllGrids が読み込み、1行(1グリッド)につき1回 searchNearby を
 * 呼び出すための「座標のリスト兼進捗管理台帳」として使われる。
 * 「処理状況」列は初期値として全行 '未処理' になり、crawlAllGrids 側で
 * '処理済み' / 'エラー' / '密集(タイプ分割済み)' / '密集(分割済み)' / '要確認(上限到達)' に更新される。
 *
 * 階層0(元グリッド)として生成するため、「階層」列は0、「親グリッドID」列は空にする。
 * 密集エリアの自動細分化で生まれる子グリッドは、この関数ではなく crawlAllGrids 内で
 * 同じシートに追記される。
 *
 * 注意: 既存の「グリッド一覧」がある場合、この関数を実行するとシートがクリアされ、
 * 処理状況(進捗)がリセットされる。進捗を保持したまま列だけ追加したい場合は
 * generateGridList を再実行せず、crawlAllGrids 内のスキーマ移行処理に任せること。
 *
 * @returns {void}
 */
function generateGridList() {
  const bounds = TARGET_AREA_BOUNDS;
  const gridStep = GRID_STEP;

  const scriptProps = PropertiesService.getScriptProperties();
  let spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  let spreadsheet;

  if (spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.create('店舗リスト');
    scriptProps.setProperty('TARGET_SPREADSHEET_ID', spreadsheet.getId());
    Logger.log('新規スプレッドシートを作成しました: ' + spreadsheet.getUrl());
  }

  let gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    gridSheet = spreadsheet.insertSheet('グリッド一覧');
  }
  gridSheet.clear();
  gridSheet.appendRow(['グリッドID', '中心緯度', '中心経度', '半径(m)', '処理状況', '階層', '親グリッドID']);

  let gridId = 1;
  const rows = [];

  // 浮動小数点の丸め誤差を避けるため、整数カウンタでループし、乗算で座標を算出する。
  // (旧: for(let lat=latMin; lat<latMax; lat+=step) では 0.01 の加算誤差により
  //  意図した範囲を超えた行・列が余分に生成されるバグがあった)
  const latSteps = Math.round((bounds.latMax - bounds.latMin) / gridStep);
  const lngSteps = Math.round((bounds.lngMax - bounds.lngMin) / gridStep);

  for (let i = 0; i < latSteps; i++) {
    const lat = bounds.latMin + i * gridStep;
    for (let j = 0; j < lngSteps; j++) {
      const lng = bounds.lngMin + j * gridStep;
      const centerLat = lat + gridStep / 2;
      const centerLng = lng + gridStep / 2;
      rows.push([gridId, centerLat, centerLng, 700, '未処理', 0, '']); // 半径700m: 1kmグリッドの隙間を埋めるための値。階層0=元グリッド
      gridId++;
    }
  }

  gridSheet.getRange(2, 1, rows.length, 7).setValues(rows);

  Logger.log('グリッド件数: ' + rows.length);
}

/**
 * 「グリッド一覧」シートが旧スキーマ(5列: グリッドID〜処理状況のみ)の場合、
 * 既存データを一切変更せずに「階層」「親グリッドID」の2列を追加し、
 * 既存の全行に 階層=0, 親グリッドID='' を補完する。
 *
 * generateGridList を再実行すると進捗(処理状況)がリセットされてしまうため、
 * 既に処理済みのグリッドを保持したまま新しい密集エリア対策ロジックに
 * 対応させるための、後方互換のための自己マイグレーション処理。
 *
 * @param {Sheet} gridSheet - 「グリッド一覧」シートオブジェクト
 * @returns {void}
 */
function ensureGridSchemaMigrated(gridSheet) {
  const lastCol = gridSheet.getLastColumn();
  if (lastCol >= 7) return; // 既に新スキーマ済み

  gridSheet.getRange(1, 6, 1, 2).setValues([['階層', '親グリッドID']]);

  const lastRow = gridSheet.getLastRow();
  if (lastRow > 1) {
    const fillValues = [];
    for (let i = 0; i < lastRow - 1; i++) {
      fillValues.push([0, '']); // 既存グリッドはすべて階層0・親なし扱いにする
    }
    gridSheet.getRange(2, 6, fillValues.length, 2).setValues(fillValues);
  }

  Logger.log('グリッド一覧シートに「階層」「親グリッドID」列を追加しました(既存データは保持)。');
}

/**
 * 「全店舗データ」シートのデータ行をすべて削除し、ヘッダーのみの状態に戻す。
 * 座標範囲・グリッド生成ロジックの修正後、ゼロからデータを取り直す際に
 * 最初に1回だけ手動で実行する想定(グリッド一覧は generateGridList 自体が
 * クリアするため、ここでは対象にしない)。
 *
 * @returns {void}
 */
function resetRestaurantData() {
  const scriptProps = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。まだ実行されていない可能性があります。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const dataSheet = spreadsheet.getSheetByName('全店舗データ');
  if (!dataSheet) {
    Logger.log('全店舗データシートが見つかりません。');
    return;
  }
  const lastRow = dataSheet.getLastRow();
  if (lastRow > 1) {
    dataSheet.getRange(2, 1, lastRow - 1, dataSheet.getLastColumn()).clearContent();
  }
  Logger.log('全店舗データをクリアしました(ヘッダーのみ残しています)。');
}

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
 * 現在の月間APIコール数を確認用にログ出力する(動作確認用)。
 * @returns {void}
 */
function checkMonthlyApiUsage() {
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const savedMonth = scriptProps.getProperty(QUOTA_PROP_MONTH);
  const count = savedMonth === currentMonth ? (scriptProps.getProperty(QUOTA_PROP_COUNT) || '0') : '0';
  Logger.log('今月(' + currentMonth + ')のAPIコール数: ' + count + ' / ' + MONTHLY_API_CALL_LIMIT);
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

/**
 * Place オブジェクト1件を「全店舗データ」シートに追記する。
 * 既に同じ Place ID が existingIds に含まれる場合は何もせず false を返す(重複除去)。
 *
 * @param {Sheet} dataSheet
 * @param {Object} place
 * @param {Set<string>} existingIds
 * @returns {boolean} 新規に追記した場合は true
 */
function addPlaceRow(dataSheet, place, existingIds) {
  if (existingIds.has(place.id)) return false;
  existingIds.add(place.id);

  const openingHoursText = place.regularOpeningHours && place.regularOpeningHours.weekdayDescriptions
    ? place.regularOpeningHours.weekdayDescriptions.join(' / ')
    : '';

  dataSheet.appendRow([
    place.displayName ? place.displayName.text : '',
    place.primaryTypeDisplayName ? place.primaryTypeDisplayName.text : (place.primaryType || ''),
    place.formattedAddress || '',
    place.nationalPhoneNumber || '',
    place.websiteUri ? 'あり' : 'なし',
    place.websiteUri || '',
    place.googleMapsUri || '',
    place.rating || '',
    place.userRatingCount || '',
    place.businessStatus || '',
    openingHoursText,
    place.priceLevel || '',
    place.takeout === true ? '○' : (place.takeout === false ? '×' : ''),
    place.delivery === true ? '○' : (place.delivery === false ? '×' : ''),
    place.dineIn === true ? '○' : (place.dineIn === false ? '×' : ''),
    place.reservable === true ? '○' : (place.reservable === false ? '×' : ''),
    place.goodForChildren === true ? '○' : '',
    place.allowsDogs === true ? '○' : '',
    place.editorialSummary ? place.editorialSummary.text : '',
    place.id || ''
  ]);
  return true;
}

/**
 * メートル単位の距離を、指定した緯度における「経度方向」の度数に変換する。
 * 緯度方向は地球上どこでもほぼ一定(1度 ≈ 111,320m)だが、経度方向は
 * 緯度が高くなるほど1度あたりの距離が短くなるため、cos(緯度) で補正する。
 *
 * @param {number} meters
 * @param {number} atLat - 基準となる緯度(度)
 * @returns {number} 経度の度数
 */
function metersToLngDelta(meters, atLat) {
  const metersPerDegreeLng = 111320 * Math.cos(atLat * Math.PI / 180);
  return meters / metersPerDegreeLng;
}

/**
 * メートル単位の距離を緯度方向の度数に変換する(1度 ≈ 111,320m で近似)。
 * @param {number} meters
 * @returns {number} 緯度の度数
 */
function metersToLatDelta(meters) {
  return meters / 111320;
}

/**
 * 密集セル(いずれかのタイプグループがちょうど20件返ってきたセル)を、半径を約6割に縮めた
 * 4つの子グリッドに分割し、「グリッド一覧」シートに新しい行として追加する
 * (階層 = 親の階層+1、処理状況='未処理')。
 * 対象エリアの範囲(TARGET_AREA_BOUNDS)を大きく超える位置になる子グリッドは生成しない。
 *
 * @param {Sheet} gridSheet
 * @param {number} parentGridId
 * @param {number} lat - 親グリッドの中心緯度
 * @param {number} lng - 親グリッドの中心経度
 * @param {number} parentRadius - 親グリッドの半径(m)
 * @param {number} parentTier - 親グリッドの階層
 * @param {number} nextGridId - 新規グリッドIDの採番開始値
 * @returns {number} 採番後の次の空きグリッドID
 */
function spawnChildGrids(gridSheet, parentGridId, lat, lng, parentRadius, parentTier, nextGridId) {
  const offsetMeters = parentRadius / 2;
  const newRadius = Math.round(parentRadius * 0.6); // 少し重なりを持たせて隙間を防ぐ
  const latDelta = metersToLatDelta(offsetMeters);
  const lngDelta = metersToLngDelta(offsetMeters, lat);

  const b = TARGET_AREA_BOUNDS;
  const margin = GRID_STEP; // 1グリッド分の余裕は許容し、それを超える子グリッドは作らない

  const childOffsets = [
    [1, 1], [1, -1], [-1, 1], [-1, -1] // 北東・北西・南東・南西の4方向
  ];

  const newRows = [];
  let gridId = nextGridId;
  let skipped = 0;
  childOffsets.forEach(function(offset) {
    const childLat = lat + offset[0] * latDelta;
    const childLng = lng + offset[1] * lngDelta;

    if (childLat < b.latMin - margin || childLat > b.latMax + margin ||
        childLng < b.lngMin - margin || childLng > b.lngMax + margin) {
      skipped++;
      return; // 対象エリアの範囲外なのでこの子グリッドは作らない
    }

    newRows.push([gridId, childLat, childLng, newRadius, '未処理', parentTier + 1, parentGridId]);
    gridId++;
  });

  if (skipped > 0) {
    Logger.log('グリッド ' + parentGridId + ' の子グリッドのうち ' + skipped + '件は対象エリアの範囲外のため生成をスキップしました。');
  }

  if (newRows.length > 0) {
    const startRow = gridSheet.getLastRow() + 1;
    gridSheet.getRange(startRow, 1, newRows.length, 7).setValues(newRows);
  }

  return gridId;
}

/**
 * 「グリッド一覧」シートに保存された各座標を1件ずつ処理し、
 * Places API (New) の searchNearby エンドポイントで店舗を検索して
 * 「全店舗データ」シートに書き込む。
 *
 * 密集エリア対策(20件の壁への対応):
 *   1. 頻度別4グループ(A/B/C/D、BASE_TYPE_GROUPS)でそれぞれ検索する(必ず4回)。
 *   2. いずれかのグループがちょうど20件(maxResultCount)返ってきた場合、切り捨ての疑いが
 *      あるため、そのグループだけを DENSE_SPLIT_CHUNK_SIZE 件ずつの小グループに細分化して
 *      追加検索する(タイプ分割)。密集判定の主犯はほぼ常にグループA(頻出ジャンル)。
 *   3. タイプ分割してもなお20件ちょうど返ってくる小グループがあれば、
 *      階層が MAX_TIER 未満の場合に限り、半径を約6割に縮めた4つの子グリッドを
 *      生成して「グリッド一覧」に追加する(次回実行時に自動的に処理される)。
 *   4. 階層が MAX_TIER に達してもまだ20件出る場合は、これ以上の自動化は
 *      行わず「要確認(上限到達)」のステータスを付けて人間の確認に委ねる。
 *
 * その他の特徴:
 *   - GASの実行時間上限(6分)に対応するため、4分30秒経過時点で安全停止する。
 *     未処理のグリッドが残っていれば、再実行することで続きから再開できる
 *     (「処理状況」列が '処理済み' 等の完了ステータスの行はスキップされるため)。
 *   - Place ID をキーに重複除去を行う(隣接グリッド・タイプ分割の重複ヒットに対応)。
 *   - Demoキーの1日あたりのクォータ上限(RESOURCE_EXHAUSTED/429)や、自前の月間上限
 *     (checkAndIncrementApiQuota)を検知した場合は、個別グリッドのエラーとして無視せず、
 *     ループ全体を即座に中断する。このとき「処理状況」は更新されないため、
 *     翌日・翌月以降の再実行でそのグリッドから再開される。
 *
 * @returns {void}
 */
function crawlAllGrids() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000; // GASの実行時間上限(6分)に対する安全マージン

  const apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_API_KEY');
  const scriptProps = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  const gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    Logger.log('グリッド一覧シートがありません。先に generateGridList を実行してください。');
    return;
  }
  ensureGridSchemaMigrated(gridSheet); // 旧スキーマの場合、進捗を保持したまま列を追加

  let dataSheet = spreadsheet.getSheetByName('全店舗データ');
  if (!dataSheet) {
    dataSheet = spreadsheet.insertSheet('全店舗データ');
    const headers = [
      '店名', '主タイプ', '住所',
      '電話番号(国内)', 'HP有無', 'HP URL', 'Google Maps URL',
      '評価', '評価件数',
      // 'レビュー抜粋(1件目)', // Demoキーでは取得不可のため無効化
      '営業状況', '通常営業時間', '価格帯',
      'テイクアウト', 'デリバリー', '店内飲食', '予約可',
      '子連れ向き', 'ペット可', '説明文(Editorial)',
      // '写真枚数', // Demoキーでは取得不可のため無効化
      'Place ID'
    ];
    dataSheet.appendRow(headers);
  }

  const lastDataRow = dataSheet.getLastRow();
  const existingIds = new Set();
  const idColIndex = dataSheet.getLastColumn(); // Place IDは最終列
  if (lastDataRow > 1) {
    const idColValues = dataSheet.getRange(2, idColIndex, lastDataRow - 1, 1).getValues();
    idColValues.forEach(function(row) {
      if (row[0]) existingIds.add(row[0]);
    });
  }

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.primaryType',
    'places.primaryTypeDisplayName',
    'places.formattedAddress',
    'places.nationalPhoneNumber',
    'places.websiteUri',
    'places.googleMapsUri',
    'places.regularOpeningHours',
    'places.rating',
    'places.userRatingCount',
    // 'places.reviews', // Demoキーでは取得不可のため無効化
    // 'places.photos',  // Demoキーでは取得不可のため無効化
    'places.editorialSummary',
    'places.priceLevel',
    'places.takeout',
    'places.delivery',
    'places.dineIn',
    'places.reservable',
    'places.goodForChildren',
    'places.allowsDogs',
    'places.businessStatus'
  ].join(',');

  const gridLastRow = gridSheet.getLastRow();
  if (gridLastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }
  // 階層・親グリッドID列(F,G)も含めて7列分読み込む
  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, 7).getValues();

  let processedCount = 0;
  let newRowsCount = 0;
  let denseSplitCount = 0;
  let needsReviewCount = 0;
  let apiCallCount = 0; // このcrawlAllGrids実行で行ったAPIコール(callSearchNearby)の回数
  let nextGridId = gridValues.reduce(function(max, r) { return Math.max(max, r[0]); }, 0) + 1;
  let quotaExceeded = false;

  const DONE_STATUSES = ['処理済み', '密集(タイプ分割済み)', '密集(分割済み)', '要確認(上限到達)'];

  // 早期リターン: 未処理のグリッドが1件も残っていなければ、API呼び出しをせず終了する
  // (トリガーによる無駄な自動実行のコストを防ぐため)
  const remainingCount = gridValues.filter(function(r) { return DONE_STATUSES.indexOf(r[4]) === -1; }).length;
  if (remainingCount === 0) {
    Logger.log('未処理のグリッドはありません。すべて完了済みのため、今回は何もせず終了します。');
    return;
  }
  Logger.log('未処理のグリッド数: ' + remainingCount + '件。処理を開始します。');

  for (let i = 0; i < gridValues.length; i++) {
    const row = gridValues[i];
    const status = row[4];
    if (DONE_STATUSES.indexOf(status) !== -1) continue; // 完了済みのグリッドはスキップ(再開時の重複呼び出し防止)

    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      Logger.log('実行時間の上限に近づいたため、ここで停止します。続きは再実行してください。');
      break;
    }

    const gridId = row[0];
    const lat = row[1];
    const lng = row[2];
    const radius = row[3];
    const tier = row[5] || 0;

    let anyBaseGroupSaturated = false; // 4グループのうち、いずれかが20件に達したか
    let anyFineGroupSaturated = false; // タイプ分割(細分化)してもなお20件出たグループがあるか
    let gridHadFailure = false;

    // --- ステップ1: 頻度別4グループ(A/B/C/D)でそれぞれ検索(必ず4回) ---
    for (let g = 0; g < BASE_TYPE_GROUPS.length; g++) {
      const groupTypes = BASE_TYPE_GROUPS[g];
      const groupResult = callSearchNearby(apiKey, fieldMask, groupTypes, lat, lng, radius);
      apiCallCount++;
      if (apiCallCount % 20 === 0) {
        Logger.log('進捗: 現在 ' + apiCallCount + ' 回コール済み');
      }

      if (!groupResult.ok) {
        if (groupResult.quotaExceeded) {
          Logger.log('利用上限に達したと思われるため、処理を中断します。');
          Logger.log('エラー内容: ' + groupResult.errorText);
          quotaExceeded = true;
          break;
        }
        Logger.log('グリッド ' + gridId + ' のグループ検索でエラー: ' + groupResult.errorText);
        gridHadFailure = true;
        continue;
      }

      groupResult.places.forEach(function(place) {
        if (addPlaceRow(dataSheet, place, existingIds)) newRowsCount++;
      });

      if (groupResult.places.length < 20) continue; // このグループは20件未満なので分割不要
      anyBaseGroupSaturated = true;

      // --- ステップ2: 20件に達したグループだけ、さらに細分化して検索(タイプ分割) ---
      const subGroups = chunkArray(groupTypes, DENSE_SPLIT_CHUNK_SIZE);
      let thisGroupStillSaturated = false;
      for (let s = 0; s < subGroups.length; s++) {
        const subResult = callSearchNearby(apiKey, fieldMask, subGroups[s], lat, lng, radius);
        apiCallCount++;
        if (apiCallCount % 20 === 0) {
          Logger.log('進捗: 現在 ' + apiCallCount + ' 回コール済み');
        }
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
        subResult.places.forEach(function(place) {
          if (addPlaceRow(dataSheet, place, existingIds)) newRowsCount++;
        });
        if (subResult.places.length >= 20) thisGroupStillSaturated = true;
      }
      if (quotaExceeded) break;
      if (thisGroupStillSaturated) anyFineGroupSaturated = true;
    }
    if (quotaExceeded) break;

    // --- ステップ3: タイプ分割してもまだ20件出るグループがある → 半径の自動細分化 ---
    if (anyFineGroupSaturated) {
      if (tier < MAX_TIER) {
        nextGridId = spawnChildGrids(gridSheet, gridId, lat, lng, radius, tier, nextGridId);
        gridSheet.getRange(i + 2, 5).setValue('密集(分割済み)');
        denseSplitCount++;
      } else {
        // これ以上の自動細分化は行わず、人間の目視確認に委ねる
        gridSheet.getRange(i + 2, 5).setValue('要確認(上限到達)');
        needsReviewCount++;
      }
    } else if (gridHadFailure) {
      gridSheet.getRange(i + 2, 5).setValue('エラー');
    } else if (anyBaseGroupSaturated) {
      gridSheet.getRange(i + 2, 5).setValue('密集(タイプ分割済み)');
      processedCount++;
    } else {
      gridSheet.getRange(i + 2, 5).setValue('処理済み');
      processedCount++;
    }
  }

  // 出力シートにヘッダー固定・フィルタを再設定(既存フィルタは一度削除してから再作成)
  const finalLastRow = dataSheet.getLastRow();
  const finalLastCol = dataSheet.getLastColumn();
  dataSheet.setFrozenRows(1);
  const existingFilter = dataSheet.getFilter();
  if (existingFilter) existingFilter.remove();
  if (finalLastRow > 1) {
    dataSheet.getRange(1, 1, finalLastRow, finalLastCol).createFilter();
  }

  Logger.log(
    '今回処理したグリッド数: ' + processedCount +
    ' / 密集で子グリッド生成: ' + denseSplitCount +
    ' / 要確認(上限到達): ' + needsReviewCount +
    ' / 新規追加件数: ' + newRowsCount +
    ' / APIコール回数: ' + apiCallCount +
    ' / 累計件数: ' + (finalLastRow - 1)
  );
  if (quotaExceeded) {
    Logger.log('→ 利用上限により中断しました。上限がリセットされたら、同じ crawlAllGrids を再実行すれば続きから再開します。');
  } else {
    Logger.log('未処理のグリッドが残っている場合は、もう一度 crawlAllGrids を実行してください。');
  }
}

/**
 * 店舗データの配列を受け取り、スプレッドシートの先頭シートに
 * ヘッダー付きで書き込み、行固定・フィルタ設定まで行う出力用ヘルパー関数。
 *
 * crawlAllGrids は自前でシートへの書き込みを行うため、この関数は使用しない。
 * 現在は非推奨の searchRestaurants からのみ呼び出される。
 *
 * @param {Object[]} places - Places API (New) のレスポンスに含まれる Place オブジェクトの配列
 * @returns {void}
 */
function writeToSheet(places) {
  const scriptProps = PropertiesService.getScriptProperties();
  let spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  let spreadsheet;

  if (spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.create('店舗リスト');
    scriptProps.setProperty('TARGET_SPREADSHEET_ID', spreadsheet.getId());
    Logger.log('新規スプレッドシートを作成しました: ' + spreadsheet.getUrl());
  }

  const sheet = spreadsheet.getSheets()[0];
  sheet.clear();

  const headers = [
    '店名', '主タイプ', '住所',
    '電話番号(国内)', 'HP有無', 'HP URL', 'Google Maps URL',
    '評価', '評価件数',
    // 'レビュー抜粋(1件目)', // Demoキーでは取得不可のため列自体は残すが値は空になる
    '営業状況', '通常営業時間', '価格帯',
    'テイクアウト', 'デリバリー', '店内飲食', '予約可',
    '子連れ向き', 'ペット可', '説明文(Editorial)',
    // '写真枚数', // Demoキーでは取得不可のため列自体は残すが値は空になる
    'Place ID'
  ];
  sheet.appendRow(headers);

  places.forEach(function(place) {
    const openingHoursText = place.regularOpeningHours && place.regularOpeningHours.weekdayDescriptions
      ? place.regularOpeningHours.weekdayDescriptions.join(' / ')
      : '';

    sheet.appendRow([
      place.displayName ? place.displayName.text : '',
      place.primaryTypeDisplayName ? place.primaryTypeDisplayName.text : (place.primaryType || ''),
      place.formattedAddress || '',
      place.nationalPhoneNumber || '',
      place.websiteUri ? 'あり' : 'なし',
      place.websiteUri || '',
      place.googleMapsUri || '',
      place.rating || '',
      place.userRatingCount || '',
      place.businessStatus || '',
      openingHoursText,
      place.priceLevel || '',
      place.takeout === true ? '○' : (place.takeout === false ? '×' : ''),
      place.delivery === true ? '○' : (place.delivery === false ? '×' : ''),
      place.dineIn === true ? '○' : (place.dineIn === false ? '×' : ''),
      place.reservable === true ? '○' : (place.reservable === false ? '×' : ''),
      place.goodForChildren === true ? '○' : '',
      place.allowsDogs === true ? '○' : '',
      place.editorialSummary ? place.editorialSummary.text : '',
      place.id || ''
    ]);
  });

  sheet.setFrozenRows(1);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const existingFilter = sheet.getFilter();
  if (existingFilter) {
    existingFilter.remove();
  }
  if (lastRow > 1) {
    sheet.getRange(1, 1, lastRow, lastCol).createFilter();
  }

  Logger.log(places.length + '件のデータを書き込みました(フィルタ設定済み)');
}

/**
 * @deprecated 単一エリア(特定の駅周辺)のテスト・動作確認用に使っていた関数。
 * 現在は generateGridList → crawlAllGrids のワークフローに統合済みのため、
 * 通常の運用ではこの関数は使用しない。動作確認用の参考として残している。
 *
 * Text Search (New) で指定エリアのテキスト検索を行い、最大3ページ(60件)まで
 * ページングしながら取得し、writeToSheet でスプレッドシートに書き込む。
 *
 * @returns {void}
 */
function searchRestaurants() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_API_KEY');
  const query = '〇〇駅 店舗'; // ← 地域×カテゴリはここを変更

  const url = 'https://places.googleapis.com/v1/places:searchText';

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.types',
    'places.primaryType',
    'places.primaryTypeDisplayName',
    'places.formattedAddress',
    'places.shortFormattedAddress',
    'places.nationalPhoneNumber',
    'places.internationalPhoneNumber',
    'places.websiteUri',
    'places.googleMapsUri',
    'places.regularOpeningHours',
    'places.rating',
    'places.userRatingCount',
    // 'places.reviews',   // Demoキーでは取得不可のため無効化
    // 'places.photos',    // Demoキーでは取得不可のため無効化
    'places.editorialSummary',
    'places.priceLevel',
    'places.takeout',
    'places.delivery',
    'places.dineIn',
    'places.reservable',
    'places.servesBreakfast',
    'places.servesLunch',
    'places.servesDinner',
    'places.servesVegetarianFood',
    'places.outdoorSeating',
    'places.liveMusic',
    'places.goodForChildren',
    'places.goodForGroups',
    'places.allowsDogs',
    'places.restroom',
    'places.businessStatus'
  ].join(',');

  let allPlaces = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    const payload = {
      textQuery: query,
      languageCode: 'ja',
      regionCode: 'JP'
    };
    if (pageToken) {
      payload.pageToken = pageToken;
    }

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
    if (response.getResponseCode() !== 200) {
      Logger.log('エラー: ' + response.getContentText());
      break;
    }

    const data = JSON.parse(response.getContentText());
    const places = data.places || [];
    allPlaces = allPlaces.concat(places);
    pageToken = data.nextPageToken || null;
    pageCount++;

    Logger.log('ページ ' + pageCount + ': ' + places.length + '件取得(累計 ' + allPlaces.length + '件)');

    if (pageToken) {
      Utilities.sleep(2000); // 次ページが有効になるまで少し待つ必要がある
    }
  } while (pageToken && pageCount < 3);

  Logger.log('合計取得件数: ' + allPlaces.length);

  writeToSheet(allPlaces);
}


/**
 * crawlAllGrids を毎日自動実行するための時間主導型トリガーを設定する。
 * 初回のみ手動で実行すればよい(既存の同名トリガーがあれば一度削除してから再作成するため、
 * 何度実行してもトリガーが重複しない)。
 *
 * クォータの日次リセット時刻は公式に明示されていないため、深夜帯(3時台)に
 * 実行することで、リセット後できるだけ早いタイミングで未処理分を進める狙い。
 * 「グリッド一覧」が全て完了ステータスになれば、crawlAllGrids 側の早期リターンにより
 * 無駄なAPI呼び出しは発生しない(トリガー自体は動くが即座に終了する)。
 *
 * @returns {void}
 */
function createDailyTrigger() {
  // 同じ関数を実行対象とする既存トリガーがあれば削除(重複作成防止)
  const existingTriggers = ScriptApp.getProjectTriggers();
  existingTriggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'crawlAllGrids') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('crawlAllGrids')
    .timeBased()
    .atHour(3) // 深夜3時台に実行(クォータのリセット後、早めに進めたいための目安)
    .everyDays(1)
    .create();

  Logger.log('crawlAllGrids の日次トリガーを作成しました(毎日3時台に自動実行)。');
}

/**
 * 現在設定されているトリガーの一覧をログに出力する(設定確認用)。
 * @returns {void}
 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('現在、トリガーは1件も設定されていません。');
    return;
  }
  triggers.forEach(function(trigger) {
    Logger.log(
      '関数: ' + trigger.getHandlerFunction() +
      ' / イベント種別: ' + trigger.getEventType() +
      ' / トリガーID: ' + trigger.getUniqueId()
    );
  });
}
