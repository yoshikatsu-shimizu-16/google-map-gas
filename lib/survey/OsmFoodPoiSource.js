/**
 * ===== OpenStreetMap の飲食系POIを取得する(APIキー不要・Googleのコールを使わない) =====
 *
 * 「どのセルに店が無いか」の当たりを付けるための材料。OSM の網羅性は Google に劣るため
 * 件数そのものは信用しないが、Google のコールを1回も使わずに候補を絞れるのが利点。
 * 0件と出たセルは捨てずに Pro枠で実地確認する(entrypoints/surveyEmptyCells.js)。
 *
 * クエリ組み立てと変換は純関数にしてあり、ローカルの Node からも同じものを使う
 * (tools/fetchOsmFoodPois.js)。通信手段だけが GAS と Node で異なる。
 */

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/** Overpass は既定の User-Agent を 406 で弾く。共用サーバーなので用途と連絡先を明示する。 */
const OVERPASS_USER_AGENT = 'google-map-gas-density-survey/1.0 (research; contact dev@kashiwano-ha.com)';

/**
 * 飲食店として数える OSM タグ。Google の Place Type とは体系が違うため1対1では対応しないが、
 * 「飲食の提供を主目的とする店」という括りを揃えている。
 * amenity 側が本体で、shop 側はパン・菓子・コーヒー豆など物販寄りの補完。
 */
const OSM_FOOD_AMENITY_VALUES = [
  'restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'biergarten', 'food_court', 'ice_cream'
];
const OSM_FOOD_SHOP_VALUES = [
  'bakery', 'confectionery', 'pastry', 'deli', 'coffee', 'tea', 'chocolate', 'ice_cream'
];

/**
 * Overpass QL のクエリを組み立てる。
 * nwr は node/way/relation をまとめる省略記法(建物として描かれた店も拾うため)。
 * `out center` を付けると way/relation にも代表点が付く。
 *
 * @param {{latMin: number, latMax: number, lngMin: number, lngMax: number}} bounds
 * @returns {string}
 */
function buildOverpassFoodQuery(bounds) {
  const bbox = [bounds.latMin, bounds.lngMin, bounds.latMax, bounds.lngMax].join(','); // 南,西,北,東
  return [
    '[out:json][timeout:180];',
    '(',
    '  nwr["amenity"~"^(' + OSM_FOOD_AMENITY_VALUES.join('|') + ')$"](' + bbox + ');',
    '  nwr["shop"~"^(' + OSM_FOOD_SHOP_VALUES.join('|') + ')$"](' + bbox + ');',
    ');',
    'out center tags;'
  ].join('\n');
}

/**
 * Overpass の element 配列を、集計側が必要とする最小限の形に落とす。
 * way/relation は座標を持たないので `out center` が付けた center を使う。
 *
 * @param {Object[]} elements
 * @returns {Array<{lat: number, lng: number, name: string, kind: string}>}
 */
function toOsmFoodPois(elements) {
  const pois = [];
  (elements || []).forEach(function(element) {
    const point = element.type === 'node' ? element : element.center;
    if (!point || point.lat === undefined || point.lon === undefined) return;
    const tags = element.tags || {};
    pois.push({
      lat: point.lat,
      lng: point.lon,
      name: tags.name || '',
      kind: tags.amenity ? 'amenity=' + tags.amenity : 'shop=' + tags.shop
    });
  });
  return pois;
}

/**
 * GAS から Overpass を呼んで飲食系POIを取得する。Google のクォータは一切消費しない。
 *
 * @param {{latMin: number, latMax: number, lngMin: number, lngMax: number}} bounds
 * @returns {{ok: boolean, pois: Array<Object>, errorText: string}}
 */
function fetchOsmFoodPois(bounds) {
  const response = UrlFetchApp.fetch(OVERPASS_ENDPOINT, {
    method: 'post',
    headers: { 'User-Agent': OVERPASS_USER_AGENT },
    payload: { data: buildOverpassFoodQuery(bounds) },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    return { ok: false, pois: [], errorText: 'Overpass の応答が ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 300) };
  }
  return { ok: true, pois: toOsmFoodPois(JSON.parse(response.getContentText()).elements), errorText: '' };
}
