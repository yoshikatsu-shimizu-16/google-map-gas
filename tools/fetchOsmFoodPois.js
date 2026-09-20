/**
 * ===== OpenStreetMap から対象エリアの飲食系POIを取得する(APIキー不要・無料) =====
 *
 * Google の Nearby Search を1コールも使わずに「どのセルに飲食店が何件あるか」の
 * 当たりを付けるための入力データ。OSM の網羅性は Google に劣るため件数そのものは
 * 信用しないが、「0件のセル」と「明らかな密集セル」の判定には十分使える。
 *
 * 責務はこのファイルでは「取ってくること」だけに限る。セルへの割り当てと集計は
 * tools/buildDensityMap.js が行う(変更理由が違うため分けている。こちらは Overpass の
 * 仕様やタグの選び方が変わったときに直す)。
 *
 * レスポンスはスクラッチ領域にキャッシュする。Overpass は共用の無料サーバーなので、
 * 集計ロジックを試行錯誤するたびに叩き直さないため。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * Overpass は既定の User-Agent を 406 で弾く。用途と連絡先を明示する
 * (共用サーバーの利用マナーとして求められている)。
 */
const USER_AGENT = 'google-map-gas-density-survey/1.0 (research; contact dev@kashiwano-ha.com)';

/**
 * 飲食店として数える OSM タグ。Google の Place Type とは体系が違うため1対1では
 * 対応しないが、「飲食の提供を主目的とする店」という括りを揃えている。
 * amenity 側が本体で、shop 側はパン・菓子・コーヒー豆など物販寄りの補完。
 */
const FOOD_AMENITY_VALUES = [
  'restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'biergarten', 'food_court', 'ice_cream'
];
const FOOD_SHOP_VALUES = [
  'bakery', 'confectionery', 'pastry', 'deli', 'coffee', 'tea', 'chocolate', 'ice_cream'
];

/**
 * Overpass QL のクエリ文字列を組み立てる。
 *
 * nwr は node/way/relation をまとめて対象にする省略記法。建物として描かれている
 * 店舗(way)も拾うため必要。`out center` を付けると way/relation にも代表点が付く。
 *
 * @param {{latMin: number, latMax: number, lngMin: number, lngMax: number}} bounds
 * @returns {string}
 */
function buildOverpassQuery(bounds) {
  // Overpass の bbox は (南, 西, 北, 東) の順
  const bbox = [bounds.latMin, bounds.lngMin, bounds.latMax, bounds.lngMax].join(',');
  const amenity = FOOD_AMENITY_VALUES.join('|');
  const shop = FOOD_SHOP_VALUES.join('|');
  return [
    '[out:json][timeout:180];',
    '(',
    '  nwr["amenity"~"^(' + amenity + ')$"](' + bbox + ');',
    '  nwr["shop"~"^(' + shop + ')$"](' + bbox + ');',
    ');',
    'out center tags;'
  ].join('\n');
}

/**
 * キャッシュファイルの置き場所。リポジトリを汚さないようスクラッチ領域に置く。
 * @param {{latMin: number, latMax: number, lngMin: number, lngMax: number}} bounds
 * @returns {string}
 */
function cachePathFor(bounds) {
  const key = [bounds.latMin, bounds.latMax, bounds.lngMin, bounds.lngMax].join('_');
  return path.join(os.tmpdir(), 'osm-food-pois-' + key + '.json');
}

/**
 * 対象エリアの飲食系POIを取得する。キャッシュがあればそれを返す。
 *
 * 通信は Node の fetch ではなく curl に投げている。この開発環境では fetch からの
 * 外向き接続が通らず、curl だけが通るため。ローカル実行専用のツールであり、
 * curl は前提にしてよいと判断した(GAS 側にデプロイされるコードではない)。
 *
 * @param {{latMin: number, latMax: number, lngMin: number, lngMax: number}} bounds
 * @param {{refresh: boolean}} [options] - refresh=true でキャッシュを無視して取り直す
 * @returns {{pois: Array<{lat: number, lng: number, name: string, kind: string}>, fromCache: boolean, timestamp: string}}
 */
function fetchOsmFoodPois(bounds, options) {
  const refresh = !!(options && options.refresh);
  const cacheFile = cachePathFor(bounds);

  if (!refresh && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return { pois: cached.pois, fromCache: true, timestamp: cached.timestamp };
  }

  const raw = execFileSync('curl', [
    '--silent', '--show-error', '--fail', '--max-time', '300',
    '--user-agent', USER_AGENT,
    '--data-urlencode', 'data=' + buildOverpassQuery(bounds),
    OVERPASS_ENDPOINT
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  const body = JSON.parse(raw);
  const timestamp = (body.osm3s && body.osm3s.timestamp_osm_base) || new Date().toISOString();
  const pois = body.elements.map(toPoi).filter(Boolean);

  fs.writeFileSync(cacheFile, JSON.stringify({ timestamp: timestamp, pois: pois }));
  return { pois: pois, fromCache: false, timestamp: timestamp };
}

/**
 * Overpass の element を、集計側が必要とする最小限の形に落とす。
 * way/relation は座標を持たないので `out center` が付けた center を使う。
 *
 * @param {Object} element
 * @returns {{lat: number, lng: number, name: string, kind: string}|null} 座標が無ければ null
 */
function toPoi(element) {
  const point = element.type === 'node' ? element : element.center;
  if (!point || point.lat === undefined || point.lon === undefined) return null;

  const tags = element.tags || {};
  return {
    lat: point.lat,
    lng: point.lon,
    name: tags.name || '',
    kind: tags.amenity ? 'amenity=' + tags.amenity : 'shop=' + tags.shop
  };
}

module.exports = {
  fetchOsmFoodPois,
  buildOverpassQuery,
  FOOD_AMENITY_VALUES,
  FOOD_SHOP_VALUES
};
