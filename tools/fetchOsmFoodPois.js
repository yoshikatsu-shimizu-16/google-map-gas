/**
 * ===== ローカルから Overpass を叩いて飲食系POIを取る(GAS側と同じクエリを使う) =====
 *
 * クエリの組み立てとレスポンスの変換は lib/survey/OsmFoodPoiSource.js に置いてあり、
 * GAS 側(entrypoints/surveyEmptyCells.js)と共有する。同じ問い合わせをローカルと
 * GAS で別々に書くと、片方だけタグを足したときに結果がずれるため。
 *
 * このファイルの責務は通信とキャッシュだけ。GAS は UrlFetchApp、こちらは curl を使う
 * (この開発環境では Node の fetch から外向き接続が通らない。ローカル専用のツールなので
 *  curl を前提にしてよいと判断した)。
 *
 * Overpass は共用の無料サーバーなので、集計ロジックを試すたびに叩き直さないよう
 * レスポンスをスクラッチ領域にキャッシュする。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * GAS のソースから、クエリ組み立てと変換の純関数を読み込む。
 * @returns {{buildOverpassFoodQuery: Function, toOsmFoodPois: Function, OVERPASS_USER_AGENT: string}}
 */
function loadOsmFoodPoiSource() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'lib/survey/OsmFoodPoiSource.js'), 'utf8');
  return new Function(source + `
    return {
      buildOverpassFoodQuery: buildOverpassFoodQuery,
      toOsmFoodPois: toOsmFoodPois,
      OVERPASS_USER_AGENT: OVERPASS_USER_AGENT
    };
  `)();
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
 * @param {{latMin: number, latMax: number, lngMin: number, lngMax: number}} bounds
 * @param {{refresh: boolean}} [options] - refresh=true でキャッシュを無視して取り直す
 * @returns {{pois: Array<{lat: number, lng: number, name: string, kind: string}>, fromCache: boolean, timestamp: string}}
 */
function fetchOsmFoodPoisViaCurl(bounds, options) {
  const refresh = !!(options && options.refresh);
  const cacheFile = cachePathFor(bounds);

  if (!refresh && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return { pois: cached.pois, fromCache: true, timestamp: cached.timestamp };
  }

  const { buildOverpassFoodQuery, toOsmFoodPois, OVERPASS_USER_AGENT } = loadOsmFoodPoiSource();
  const raw = execFileSync('curl', [
    '--silent', '--show-error', '--fail', '--max-time', '300',
    '--user-agent', OVERPASS_USER_AGENT,
    '--data-urlencode', 'data=' + buildOverpassFoodQuery(bounds),
    OVERPASS_ENDPOINT
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  const body = JSON.parse(raw);
  const timestamp = (body.osm3s && body.osm3s.timestamp_osm_base) || new Date().toISOString();
  const pois = toOsmFoodPois(body.elements);

  fs.writeFileSync(cacheFile, JSON.stringify({ timestamp: timestamp, pois: pois }));
  return { pois: pois, fromCache: false, timestamp: timestamp };
}

module.exports = { fetchOsmFoodPoisViaCurl };
