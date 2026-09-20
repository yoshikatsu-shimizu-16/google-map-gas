/**
 * GASスタブ上でエントリーポイントを実際に動かす検証スクリプト(ローカル実行用)。
 *
 *   node tools/verifyCrawlerOnStubs.js
 *
 * GAS には型チェックもコンパイルもないため、関数名や定数名の取り違えはデプロイして
 * 実行するまで分からない。ここでは .claspignore のホワイトリスト全ファイルを
 * GAS と同じ単一グローバルスコープに結合し、ネットワークもスプレッドシートも使わずに
 * generateGridList → crawlAllGrids を通し、スキーマ移行の後方互換も確認する。
 */
const { loadDeployedSource, createFakeSheet, installGasGlobals } = require('./gasStubs');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  -- ' + detail : ''));
  if (!ok) failures++;
}

const { source, files } = loadDeployedSource();
console.log('\nデプロイ対象 ' + files.length + ' ファイルを結合して検証します。');

// =====================================================================
console.log('\n[1] generateGridList → crawlAllGrids の通し実行');
// =====================================================================
// 特定の狭い範囲だけ「20件飽和」、南寄りは「0件」、それ以外は少数を返すフェイク
const stub = installGasGlobals({
  respondToSearch: function(body) {
    const c = body.locationRestriction.circle.center;
    const dense = c.latitude > 35.85 && c.latitude < 35.87 &&
                  c.longitude > 139.96 && c.longitude < 139.98;
    const empty = c.latitude < 35.80;
    const count = dense ? 20 : (empty ? 0 : 3);
    const places = [];
    for (let i = 0; i < count; i++) {
      places.push({
        id: 'p_' + c.latitude.toFixed(5) + '_' + c.longitude.toFixed(5) + '_' + body.includedTypes[0] + '_' + i,
        displayName: { text: '店舗' + i },
        formattedAddress: '住所',
        location: { latitude: c.latitude, longitude: c.longitude },
        types: [body.includedTypes[0], 'restaurant', 'food'],
        // 偶数番の店だけ Instagram を持たせ、HP種別が SNSのみ に倒れることを見る
        websiteUri: i % 2 === 0 ? 'https://www.instagram.com/tenpo' + i + '/' : '',
        rating: 4.1,
        userRatingCount: 0
      });
    }
    return { places: places };
  }
});
stub.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
stub.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
// この[1]は「旧方式(type_groups)が無改変であること」の回帰テストと位置づける。
// crawlAllGrids.js:145-204 を TypeGroupCellSearch.js へ移設した際のデグレ検知になるため、
// 既定値に頼らず明示的に固定し、以下のアサート内容は一切変えない。
stub.properties['SEARCH_STRATEGY'] = 'type_groups';

const api = new Function(source + `
  return {
    generateGridList: generateGridList,
    crawlAllGrids: crawlAllGrids,
    ensureGridSchemaMigrated: ensureGridSchemaMigrated,
    ensurePlaceDataSchemaMigrated: ensurePlaceDataSchemaMigrated,
    ensurePlaceDataFilter: ensurePlaceDataFilter,
    createPlaceRowWriter: createPlaceRowWriter,
    classifyWebsite: classifyWebsite,
    cellCoverRadiusMeters: cellCoverRadiusMeters,
    GRID_SHEET_HEADERS: GRID_SHEET_HEADERS,
    PLACE_DATA_HEADERS: PLACE_DATA_HEADERS,
    PLACE_ID_COLUMN: PLACE_ID_COLUMN,
    GRID_STEP: GRID_STEP,
    MAX_TIER: MAX_TIER,
    callSearchNearby: callSearchNearby,
    MONTHLY_API_CALL_LIMIT: MONTHLY_API_CALL_LIMIT,
    QUOTA_PROP_COUNT: QUOTA_PROP_COUNT,
    MONTHLY_QUOTA_BY_SKU: MONTHLY_QUOTA_BY_SKU,
    API_SKU_PRO: API_SKU_PRO,
    API_SKU_ENTERPRISE: API_SKU_ENTERPRISE,
    PLACE_SEARCH_FIELD_MASK: PLACE_SEARCH_FIELD_MASK,
    PLACE_SURVEY_FIELD_MASK: PLACE_SURVEY_FIELD_MASK,
    apiSkuOfFieldMask: apiSkuOfFieldMask,
    surveyEmptyCells: surveyEmptyCells,
    checkMonthlyApiUsage: checkMonthlyApiUsage,
    SURVEY_LOG_HEADERS: SURVEY_LOG_HEADERS,
    PLACE_TYPE_PROBE_SET: PLACE_TYPE_PROBE_SET,
    OSM_EMPTY_GRID_IDS: OSM_EMPTY_GRID_IDS,
    TARGET_AREA_BOUNDS: TARGET_AREA_BOUNDS,
    GRID_STATUS_EMPTY_BY_GROUP_A: GRID_STATUS_EMPTY_BY_GROUP_A,
    compareProbeSetWithTypeGroups: compareProbeSetWithTypeGroups,
    PROBE_SURVEY_LOG_HEADERS: PROBE_SURVEY_LOG_HEADERS,
    BASE_TYPE_GROUPS: BASE_TYPE_GROUPS,
    surveyAllCells: surveyAllCells,
    AREA_SURVEY_CELL_HEADERS: AREA_SURVEY_CELL_HEADERS,
    AREA_SURVEY_PLACE_HEADERS: AREA_SURVEY_PLACE_HEADERS,
    surveySaturatedCells: surveySaturatedCells,
    SATURATED_CHILD_HEADERS: SATURATED_CHILD_HEADERS,
    childCellsOf: childCellsOf,
    CHILD_CELLS_PER_PARENT: CHILD_CELLS_PER_PARENT
  };
`)();

api.generateGridList();
const gridAfterGenerate = stub.sheets['グリッド一覧'].rows().length - 1;
check('階層0のグリッドが374件生成される', gridAfterGenerate === 374, gridAfterGenerate + '件');

api.crawlAllGrids();
const grid = stub.sheets['グリッド一覧'].rows();
const data = stub.sheets['全飲食店データ'].rows();
const statusCounts = {};
grid.slice(1).forEach(function(r) { statusCounts[r[4]] = (statusCounts[r[4]] || 0) + 1; });
console.log('       処理状況: ' + JSON.stringify(statusCounts));

check('「処理済み」が付く', (statusCounts['処理済み'] || 0) > 0);
check('飲食店ゼロのセルに「処理済み(A=0のため省略)」が付く',
  (statusCounts['処理済み(A=0のため省略)'] || 0) > 0, (statusCounts['処理済み(A=0のため省略)'] || 0) + '件');
check('密集セルに「密集(分割済み)」が付く', (statusCounts['密集(分割済み)'] || 0) > 0);

const splitCount = statusCounts['密集(分割済み)'] || 0;
check('密集セル1件につき子グリッドが4件追加される',
  grid.length - 1 === 374 + splitCount * 4, '総グリッド数=' + (grid.length - 1));

const child = grid.slice(1).find(function(r) { return r[5] === 1; });
check('子グリッドの半径が359m・セルサイズが0.005度',
  child && child[3] === 359 && child[7] === 0.005,
  child ? '半径=' + child[3] + 'm セルサイズ=' + child[7] + '度 親=' + child[6] : '子グリッドなし');

const placeCol = function(name) { return api.PLACE_DATA_HEADERS.indexOf(name); };
check('新規取得行に緯度・経度・全タイプが入る',
  data.slice(1).every(function(r) {
    return typeof r[placeCol('緯度')] === 'number' && typeof r[placeCol('経度')] === 'number' &&
      String(r[placeCol('全タイプ')]).indexOf('restaurant') !== -1;
  }));
check('新規取得行のHP種別が websiteUri から振り分けられる',
  data.slice(1).some(function(r) { return r[placeCol('HP種別')] === 'SNSのみ'; }) &&
  data.slice(1).some(function(r) { return r[placeCol('HP種別')] === 'なし'; }));
check('評価件数0が空セルにならず0のまま残る',
  data.slice(1).every(function(r) { return r[placeCol('評価件数')] === 0; }));

const ids = data.slice(1).map(function(r) { return r[api.PLACE_ID_COLUMN - 1]; });
check('Place ID が重複しない', ids.length === new Set(ids).size,
  (ids.length - new Set(ids).size) + '件の重複 / 総数' + ids.length);

const breakdown = stub.logs.filter(function(l) { return l.indexOf('[コール内訳]') === 0; }).pop();
check('コール内訳のログが出力される', !!breakdown);
if (breakdown) console.log('       ' + breakdown);

const summary = stub.logs.filter(function(l) { return l.indexOf('APIコール回数:') !== -1; }).pop();
const reported = summary && Number(summary.match(/APIコール回数: (\d+)/)[1]);
check('計測したコール数が実際のHTTPリクエスト数と一致する',
  reported === stub.requestCount(), '計測=' + reported + ' / 実リクエスト=' + stub.requestCount());

// グループA=0件のセルでは残り3グループを省略している(A のコール数だけ多くなる)
const groupCalls = breakdown && breakdown.match(/グループ別\(A\/B\/C\/D\): (\d+)\/(\d+)\/(\d+)\/(\d+)/);
if (groupCalls) {
  const a = Number(groupCalls[1]), b = Number(groupCalls[2]);
  check('グループAが0件のセルでB/C/Dが省略されている', a > b, 'A=' + a + ' > B=' + b);
}

// =====================================================================
console.log('\n[2] 旧5列スキーマからの移行(進捗を保持すること)');
// =====================================================================
const sheet5 = createFakeSheet([
  ['グリッドID', '中心緯度', '中心経度', '半径(m)', '処理状況'],
  [1, 35.775, 139.905, 700, '処理済み'],
  [2, 35.775, 139.915, 700, '密集(タイプ分割済み)'],
  [3, 35.785, 139.905, 700, '未処理']
]);
api.ensureGridSchemaMigrated(sheet5);
let rows = sheet5.rows();
check('ヘッダーが8列になる', rows[0].join('|') === api.GRID_SHEET_HEADERS.join('|'), rows[0].join('|'));
check('処理状況が保持される',
  rows[1][4] === '処理済み' && rows[2][4] === '密集(タイプ分割済み)' && rows[3][4] === '未処理');
check('既存の半径700mが書き換えられない', rows[1][3] === 700, '半径=' + rows[1][3] + 'm');
check('階層0・親なしが補完される', rows[1][5] === 0 && rows[1][6] === '');
check('セルサイズに0.01度が入る', rows[1][7] === api.GRID_STEP, 'セルサイズ=' + rows[1][7]);

const snapshot = JSON.stringify(sheet5.rows());
api.ensureGridSchemaMigrated(sheet5);
check('2回実行しても結果が変わらない(冪等)', JSON.stringify(sheet5.rows()) === snapshot);

// =====================================================================
console.log('\n[3] 旧7列スキーマ + 旧ロジックが生成した子グリッドからの移行');
// =====================================================================
const sheet7 = createFakeSheet([
  ['グリッドID', '中心緯度', '中心経度', '半径(m)', '処理状況', '階層', '親グリッドID'],
  [1, 35.775, 139.905, 700, '密集(分割済み)', 0, ''],
  [2, 35.7781, 139.9081, 420, '未処理', 1, 1],    // 旧ロジック: 700 × 0.6
  [3, 35.7794, 139.9094, 252, '処理済み', 2, 2]   // 旧ロジック: 420 × 0.6
]);
api.ensureGridSchemaMigrated(sheet7);
rows = sheet7.rows();
check('処理状況が保持される', rows[1][4] === '密集(分割済み)' && rows[3][4] === '処理済み');
check('階層0はセルサイズ0.01度', rows[1][7] === api.GRID_STEP, 'セルサイズ=' + rows[1][7]);
[[2, 420], [3, 252]].forEach(function(pair) {
  const r = rows[pair[0]];
  const rederived = api.cellCoverRadiusMeters(r[7], r[1]);
  check('旧ロジックの半径' + pair[1] + 'mからセルサイズを逆算できる',
    Math.abs(rederived - pair[1]) <= 1,
    'セルサイズ=' + r[7].toFixed(6) + '度 → 再導出半径=' + rederived + 'm');
});
check('逆算したセルサイズが階層に応じて小さくなる', rows[2][7] > rows[3][7] && rows[3][7] > 0);

// 旧ロジック(円0.6倍)が生成した tier≥1 の行を、新ロジックの矩形四分木分割に
// かけると被覆漏れが再発するため、移行時に階層を MAX_TIER へ固定していること。
check('旧ロジックのtier1行の階層がMAX_TIERに固定される',
  rows[2][5] === api.MAX_TIER, '階層=' + rows[2][5] + ' (MAX_TIER=' + api.MAX_TIER + ')');
check('旧ロジックのtier2行の階層がMAX_TIERに固定される',
  rows[3][5] === api.MAX_TIER, '階層=' + rows[3][5] + ' (MAX_TIER=' + api.MAX_TIER + ')');
check('tier0の親行は階層0のまま', rows[1][5] === 0, '階層=' + rows[1][5]);

// =====================================================================
console.log('\n[4] HP種別の判定(classifyWebsite)');
// =====================================================================
// 実際のシートに入っていた URL をそのまま使う。HPありの約3割が SNS だったため、
// あり/なしの2値では営業リストとして使えないというのがこの列を足した理由。
[
  ['', 'なし', ''],
  [undefined, 'なし', ''],
  ['https://www.instagram.com/tenpo_a/', 'SNSのみ', 'instagram.com'],
  ['https://ja-jp.facebook.com/tenpo_b/', 'SNSのみ', 'ja-jp.facebook.com'],
  // 短縮ドメインは本体ドメインのサブドメインではないため、個別に登録しないと自社HPに倒れる。
  // lin.ee は LINE 公式アカウントの標準的なリンク形式で、拾いたい層がそのまま漏れる。
  ['https://lin.ee/AbCdEfG', 'SNSのみ', 'lin.ee'],
  ['https://fb.me/tenpo_d', 'SNSのみ', 'fb.me'],
  ['https://manisancurry.saidomenu.com/', 'グルメポータル', 'manisancurry.saidomenu.com'],
  ['https://pkg.navitime.co.jp/matsuyafoods/spot/detail?code=0000000792', 'グルメポータル', 'pkg.navitime.co.jp'],
  ['https://sites.google.com/view/tenpo-c', '簡易ページ', 'sites.google.com'],
  ['https://shop.dennys.jp/map/21855/', '自社HP', 'shop.dennys.jp'],
  ['https://notfacebook.com/', '自社HP', 'notfacebook.com']
].forEach(function(c) {
  const r = api.classifyWebsite(c[0]);
  check('classifyWebsite(' + JSON.stringify(c[0]) + ') → ' + c[1],
    r.category === c[1] && r.domain === c[2], r.category + ' / ' + r.domain);
});

// =====================================================================
console.log('\n[5] 旧20列スキーマからの移行(取得済みの店舗データを保持すること)');
// =====================================================================
const LEGACY_PLACE_HEADERS = [
  '店名', '主タイプ', '住所',
  '電話番号(国内)', 'HP有無', 'HP URL', 'Google Maps URL',
  '評価', '評価件数',
  '営業状況', '通常営業時間', '価格帯',
  'テイクアウト', 'デリバリー', '店内飲食', '予約可',
  '子連れ向き', 'ペット可', '説明文(Editorial)',
  'Place ID'
];
const legacySheet = createFakeSheet([
  LEGACY_PLACE_HEADERS,
  ['横浜家系ラーメン 祭家', 'ラーメン屋', '千葉県松戸市二十世紀が丘萩町1-2', '047-712-0007',
   'なし', '', 'https://maps.google.com/?cid=1', 3.4, 655,
   'OPERATIONAL', '月曜日: 11時00分～0時00分', 'PRICE_LEVEL_MODERATE',
   '○', '×', '○', '×', '○', '', '', 'ChIJ_nashi'],
  ['カフェ インスタ', 'カフェ・喫茶', '千葉県松戸市松戸1', '047-000-0001',
   'あり', 'https://www.instagram.com/cafe_insta/', 'https://maps.google.com/?cid=2', 4.5, 120,
   'OPERATIONAL', '月曜日: 定休日', '',
   '', '', '○', '', '', '', '紹介文', 'ChIJ_sns'],
  ['デニーズ 二十世紀ヶ丘店', 'ファミリー レストラン', '千葉県松戸市二十世紀が丘中松町20', '080-3437-7625',
   'あり', 'https://shop.dennys.jp/map/21855/', 'https://maps.google.com/?cid=3', 3.6, 660,
   'OPERATIONAL', '月曜日: 7時00分～0時00分', 'PRICE_LEVEL_MODERATE',
   '○', '○', '○', '○', '○', '', '', 'ChIJ_chain']
]);

api.ensurePlaceDataSchemaMigrated(legacySheet);
const migrated = legacySheet.rows();
const col = function(name) { return api.PLACE_DATA_HEADERS.indexOf(name); };

check('ヘッダーが17列の新スキーマになる',
  migrated[0].join('|') === api.PLACE_DATA_HEADERS.join('|'), migrated[0].join('|'));
check('データ行が3行とも保持される', migrated.length === 4, (migrated.length - 1) + '行');
check('Place ID が末尾列に移っても欠損しない',
  migrated[1][api.PLACE_ID_COLUMN - 1] === 'ChIJ_nashi' &&
  migrated[3][api.PLACE_ID_COLUMN - 1] === 'ChIJ_chain');
check('店名・評価・評価件数が保持される',
  migrated[1][col('店名')] === '横浜家系ラーメン 祭家' &&
  migrated[1][col('評価')] === 3.4 && migrated[1][col('評価件数')] === 655);
check('通常営業時間・価格帯が保持される',
  migrated[3][col('通常営業時間')] === '月曜日: 7時00分～0時00分' &&
  migrated[3][col('価格帯')] === 'PRICE_LEVEL_MODERATE');
check('Atmosphere系の値が新スキーマに混入しない',
  migrated.slice(1).every(function(r) { return r.indexOf('○') === -1 && r.indexOf('紹介文') === -1; }));

// 旧「HP有無」では「あり」に埋もれていた Instagram の店が、SNSのみ として拾えること。
// この1件が拾えるかどうかがターゲット母数を左右する(実データでは HPあり の約3割)。
check('HP URL なし → HP種別「なし」', migrated[1][col('HP種別')] === 'なし', migrated[1][col('HP種別')]);
check('旧「HP有無=あり」のInstagram → HP種別「SNSのみ」',
  migrated[2][col('HP種別')] === 'SNSのみ', migrated[2][col('HP種別')]);
check('チェーン店舗ページ → HP種別「自社HP」/ HPドメインで識別できる',
  migrated[3][col('HP種別')] === '自社HP' && migrated[3][col('HPドメイン')] === 'shop.dennys.jp',
  migrated[3][col('HP種別')] + ' / ' + migrated[3][col('HPドメイン')]);
check('HP URL が新スキーマでも保持される',
  migrated[2][col('HP URL')] === 'https://www.instagram.com/cafe_insta/');
check('旧スキーマに無い 緯度/経度/全タイプ は空になる',
  migrated.slice(1).every(function(r) {
    return r[col('緯度')] === '' && r[col('経度')] === '' && r[col('全タイプ')] === '';
  }));

const migratedSnapshot = JSON.stringify(legacySheet.rows());
api.ensurePlaceDataSchemaMigrated(legacySheet);
check('2回実行しても結果が変わらない(冪等)',
  JSON.stringify(legacySheet.rows()) === migratedSnapshot);

// 移行は列数を変えるためフィルタを一度外す。crawlAllGrids の末尾にも再作成処理があるが、
// 未処理グリッドが残っていない実行はその手前で早期リターンしてそこへ到達しない。
// 移行自体は冪等で次回以降スキップされるため、ここで戻さないとフィルタが永久に消える。
const filteredSheet = createFakeSheet([
  LEGACY_PLACE_HEADERS,
  ['店A', 'ラーメン屋', '住所', '047-000-0000', 'なし', '', 'https://maps.google.com/?cid=9',
   3.9, 100, 'OPERATIONAL', '月曜日: 定休日', '', '', '', '', '', '', '', '', 'ChIJ_filter']
]);
filteredSheet.getRange(1, 1, 2, LEGACY_PLACE_HEADERS.length).createFilter();
api.ensurePlaceDataSchemaMigrated(filteredSheet);
const filterRange = filteredSheet.filterRange();
check('移行後もフィルタが張られたまま残る', filterRange !== null,
  filterRange === null ? 'フィルタが消えている' : 'あり');
check('張り直したフィルタが新スキーマの17列を覆う',
  filterRange !== null && filterRange.numCols === api.PLACE_DATA_HEADERS.length,
  filterRange ? filterRange.numRows + '行 x ' + filterRange.numCols + '列' : '-');
check('張り直したフィルタはデータ行数ではなくシート全行を覆う(以後の行追加で範囲が変わらない)',
  filterRange !== null && filterRange.numRows === filteredSheet.getMaxRows(),
  filterRange ? filterRange.numRows + '行 / シート全行=' + filteredSheet.getMaxRows() : '-');

const emptySheet = createFakeSheet([LEGACY_PLACE_HEADERS]);
api.ensurePlaceDataSchemaMigrated(emptySheet);
check('データ行0件でもヘッダーだけ移行できる',
  emptySheet.rows().length === 1 &&
  emptySheet.rows()[0].join('|') === api.PLACE_DATA_HEADERS.join('|'));

// =====================================================================
console.log('\n[6] プローブ優先モード(SEARCH_STRATEGY=probe)');
// =====================================================================
// このセクション専用のフェイク: id を「中心座標とインデックス」だけから作る
// (includedTypes には依存しない)。[1]のフェイクは id に includedTypes[0] を
// 使っているため type_groups と probe とでモード間の id が変わってしまい、
// 「同じセルなら同じ店が返る」ことの検証に使えない。ここでは同一セルに対して
// type_groups / probe のどちらで検索しても物理的に同じ店が返る、という
// 「プローブ1コールで取りこぼさない」ことのローカル側の主張を検証する。
const SPARSE_CELL = { gridId: 101, lat: 35.80, lng: 139.95 };
const EMPTY_CELL = { gridId: 102, lat: 35.79, lng: 139.94 };
const DENSE_CELL = { gridId: 103, lat: 35.86, lng: 139.97 };
// 被覆漏れ警告の検証専用: 密集(飽和)しつつ、types が point_of_interest/establishment
// だけ(=プローブ集合で被覆されない)の店だけを返すセル。
const DENSE_UNCOVERED_CELL = { gridId: 104, lat: 35.865, lng: 139.975 };

const cellKey = function(lat, lng) { return lat.toFixed(5) + '_' + lng.toFixed(5); };
const DENSE_KEY = cellKey(DENSE_CELL.lat, DENSE_CELL.lng);
const DENSE_UNCOVERED_KEY = cellKey(DENSE_UNCOVERED_CELL.lat, DENSE_UNCOVERED_CELL.lng);
const EMPTY_KEY = cellKey(EMPTY_CELL.lat, EMPTY_CELL.lng);

const respondByCellOnly = function(body) {
  const c = body.locationRestriction.circle.center;
  const key = cellKey(c.latitude, c.longitude);
  const isDense = key === DENSE_KEY || key === DENSE_UNCOVERED_KEY;
  const isEmpty = key === EMPTY_KEY;
  const count = isDense ? 20 : (isEmpty ? 0 : 3);
  const places = [];
  for (let i = 0; i < count; i++) {
    places.push({
      id: 'q_' + key + '_' + i,
      displayName: { text: '店舗' + i },
      formattedAddress: '住所',
      location: { latitude: c.latitude, longitude: c.longitude },
      types: key === DENSE_UNCOVERED_KEY ? ['point_of_interest', 'establishment'] : ['restaurant', 'food'],
      websiteUri: '',
      rating: 4.0,
      userRatingCount: 10
    });
  }
  return { places: places };
};

/** 指定したセル配列だけを持つ「グリッド一覧」シートを作る(階層0・未処理・8列の最新スキーマ)。 */
const buildGridSheet = function(cells) {
  const rows = [api.GRID_SHEET_HEADERS];
  cells.forEach(function(cell) {
    rows.push([cell.gridId, cell.lat, cell.lng, 700, '未処理', 0, '', api.GRID_STEP]);
  });
  return createFakeSheet(rows);
};

/**
 * SEARCH_STRATEGY を指定して crawlAllGrids を1回実行する。
 * installGasGlobals は呼ぶたびに global.Logger 等を差し替えるため、この関数の
 * 呼び出しごとに独立したシート・ログ・コール数で計測できる。
 * @param {string} strategy - 'type_groups' | 'probe'
 * @param {Array<{gridId:number, lat:number, lng:number}>} cells
 * @returns {{stub: Object, gridRows: Array[], dataRows: Array[]}}
 */
const runCrawlWithStrategy = function(strategy, cells) {
  const s = installGasGlobals({ respondToSearch: respondByCellOnly });
  s.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
  s.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
  s.properties['SEARCH_STRATEGY'] = strategy;
  s.sheets['グリッド一覧'] = buildGridSheet(cells);
  api.crawlAllGrids();
  return {
    stub: s,
    gridRows: s.sheets['グリッド一覧'].rows(),
    dataRows: s.sheets['全飲食店データ'].rows()
  };
};

// --- 疎セル・空セルだけのグリッドで、処理状況とコール数を確認する ---
const sparseRun = runCrawlWithStrategy('probe', [SPARSE_CELL, EMPTY_CELL]);
const sparseStatuses = sparseRun.gridRows.slice(1).map(function(r) { return r[4]; });
check('疎セルに「処理済み(プローブ)」が付く', sparseStatuses[0] === '処理済み(プローブ)', sparseStatuses[0]);
check('空セルにも「処理済み(プローブ)」が付く(プローブは何も省略していないため0件と区別しない)',
  sparseStatuses[1] === '処理済み(プローブ)', sparseStatuses[1]);
check('疎セル・空セルとも1回のコールで確定する(2セルでコール数2)',
  sparseRun.stub.requestCount() === 2, 'requestCount=' + sparseRun.stub.requestCount());

const probeBreakdown = sparseRun.stub.logs.filter(function(l) { return l.indexOf('[プローブ内訳]') === 0; }).pop();
check('[プローブ内訳]ログが出力される', !!probeBreakdown, probeBreakdown);

// --- 密集セル: 旧モードと新モード(フォールバック経由)の子グリッド生成数が一致する ---
const denseTypeGroups = runCrawlWithStrategy('type_groups', [DENSE_CELL]);
const denseProbe = runCrawlWithStrategy('probe', [DENSE_CELL]);
const countStatus = function(rows, status) {
  return rows.slice(1).filter(function(r) { return r[4] === status; }).length;
};
check('密集セルの「密集(分割済み)」件数が旧モードと新モードで一致する(ともに1件)',
  countStatus(denseTypeGroups.gridRows, '密集(分割済み)') === 1 &&
  countStatus(denseProbe.gridRows, '密集(分割済み)') === 1,
  'type_groups=' + countStatus(denseTypeGroups.gridRows, '密集(分割済み)') +
  ' / probe=' + countStatus(denseProbe.gridRows, '密集(分割済み)'));

// --- 計測コール数=実HTTPリクエスト数(密集セルのフォールバック込みでも成り立つこと) ---
const probeSummary = denseProbe.stub.logs.filter(function(l) { return l.indexOf('APIコール回数:') !== -1; }).pop();
const probeReported = probeSummary && Number(probeSummary.match(/APIコール回数: (\d+)/)[1]);
check('プローブモードでも計測コール数が実際のHTTPリクエスト数と一致する(密集セルのフォールバック込み)',
  probeReported === denseProbe.stub.requestCount(),
  '計測=' + probeReported + ' / 実リクエスト=' + denseProbe.stub.requestCount());

// --- 疎セル: 旧モードと新モードで取得する Place ID 集合が完全一致すること ---
const sparseTypeGroups = runCrawlWithStrategy('type_groups', [SPARSE_CELL]);
const sparseProbe = runCrawlWithStrategy('probe', [SPARSE_CELL]);
const idSet = function(rows) {
  return rows.slice(1).map(function(r) { return r[api.PLACE_ID_COLUMN - 1]; }).sort();
};
check('疎セルの取得Place ID集合が旧モードと新モードで一致する',
  JSON.stringify(idSet(sparseTypeGroups.dataRows)) === JSON.stringify(idSet(sparseProbe.dataRows)),
  'type_groups=' + JSON.stringify(idSet(sparseTypeGroups.dataRows)) +
  ' / probe=' + JSON.stringify(idSet(sparseProbe.dataRows)));

// --- 被覆漏れ警告: point_of_interest/establishment のみの店を返す密集セル ---
const uncoveredRun = runCrawlWithStrategy('probe', [DENSE_UNCOVERED_CELL]);
const warningLog = uncoveredRun.stub.logs.filter(function(l) { return l.indexOf('[被覆漏れ]') === 0; });
check('プローブ集合で被覆されない店が新規取得されると警告ログが出る', warningLog.length > 0, warningLog.length + '件');
const uncoveredSummary = uncoveredRun.stub.logs.filter(function(l) { return l.indexOf('[プローブ内訳]') === 0; }).pop();
check('[プローブ内訳]ログの「未被覆の店」にも反映される(0件ではない)',
  !!uncoveredSummary && uncoveredSummary.indexOf('未被覆の店: 0') === -1, uncoveredSummary);

// =====================================================================
console.log('\n[7] フィルタ条件の保持と行容量(Issue #5)');
// =====================================================================
// 旧実装は crawlAllGrids の末尾で毎回 remove() → createFilter() しており、
// 運用者が設定した絞り込み条件(HP種別=なし / 評価>=3.8 等)が日次トリガーのたびに
// 消えていた。ここでは「範囲が変わらない限りフィルタに触らない」ことを、
// フィルタオブジェクトの同一性で検証する(スタブの remove() は別インスタンスを作るため、
// 同一インスタンスが残っている = 張り直していない = 条件が生きている)。

const filterSheet = createFakeSheet([api.PLACE_DATA_HEADERS]);
const created = api.ensurePlaceDataFilter(filterSheet);
const firstFilter = filterSheet.getFilter();
check('フィルタが無ければ張られる', created === true && firstFilter !== null);
check('フィルタ範囲がシート全行 × スキーマ列数になる',
  filterSheet.filterRange().numRows === filterSheet.getMaxRows() &&
  filterSheet.filterRange().numCols === api.PLACE_DATA_HEADERS.length,
  filterSheet.filterRange().numRows + '行 x ' + filterSheet.filterRange().numCols + '列');

// 運用者が設定した絞り込み条件の代わりに目印を付け、これが生き残るかを見る
firstFilter.operatorCriteria = 'HP種別=なし / 評価>=3.8';

// 行が増えても範囲は変わらない ＝ 張り直さない
const writer = api.createPlaceRowWriter(filterSheet, new Set());
for (let i = 0; i < 50; i++) {
  writer.add({ id: 'f_' + i, displayName: { text: '店' + i }, types: ['restaurant'] });
}
writer.flush();
const rebuiltAfterWrite = api.ensurePlaceDataFilter(filterSheet);
check('行が増えてもフィルタを張り直さない', rebuiltAfterWrite === false);
check('運用者が設定した絞り込み条件が残る',
  filterSheet.getFilter() === firstFilter &&
  filterSheet.getFilter().operatorCriteria === 'HP種別=なし / 評価>=3.8',
  String(filterSheet.getFilter() && filterSheet.getFilter().operatorCriteria));

// 列数が変わったとき(スキーマ移行)だけは張り直す必要がある
const staleSheet = createFakeSheet([api.PLACE_DATA_HEADERS]);
staleSheet.getRange(1, 1, 2, 5).createFilter(); // 旧い狭い範囲を掴んだフィルタ
check('範囲が意図と違えば張り直す', api.ensurePlaceDataFilter(staleSheet) === true);

// --- crawlAllGrids を2回通しても条件が残ること(エンドツーエンド) ---
// どのセルでも3件だけ返す単純なフェイクで、1セルだけのグリッドを2回クロールする
// (日次トリガーが毎朝走る状況に相当)。
const twiceRun = installGasGlobals({
  respondToSearch: function(body) {
    const c = body.locationRestriction.circle.center;
    const places = [];
    for (let i = 0; i < 3; i++) {
      places.push({
        id: 'e2e_' + body.includedTypes[0] + '_' + i,
        displayName: { text: '店舗' + i },
        location: { latitude: c.latitude, longitude: c.longitude },
        types: ['restaurant', 'food'],
        websiteUri: '',
        rating: 4.0,
        userRatingCount: 10
      });
    }
    return { places: places };
  }
});
twiceRun.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
twiceRun.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
twiceRun.sheets['グリッド一覧'] = createFakeSheet([
  api.GRID_SHEET_HEADERS,
  [901, 35.80, 139.95, 717, '未処理', 0, '', api.GRID_STEP]
]);
api.crawlAllGrids();
const dataSheetTwice = twiceRun.sheets['全飲食店データ'];
const filterAfterFirstRun = dataSheetTwice.getFilter();
filterAfterFirstRun.operatorCriteria = 'HP種別=なし';
// 2回目は同じセルを未処理に戻して再クロールする(日次トリガーの再実行に相当)
twiceRun.sheets['グリッド一覧'].getRange(2, 5).setValue('未処理');
api.crawlAllGrids();
check('crawlAllGrids を2回実行してもフィルタ条件が消えない',
  dataSheetTwice.getFilter() === filterAfterFirstRun &&
  dataSheetTwice.getFilter().operatorCriteria === 'HP種別=なし',
  String(dataSheetTwice.getFilter() && dataSheetTwice.getFilter().operatorCriteria));

// --- 行容量: シートの既定行数(1000行)を超えても落ちないこと ---
// 旧実装は getMaxRows を見ておらず、実機では「範囲が不正」でクロールごと落ちる。
// スタブも同じ条件で例外を投げるようにしてある(tools/gasStubs.js)。
const smallSheet = createFakeSheet([api.PLACE_DATA_HEADERS], { maxRows: 5 });
const smallWriter = api.createPlaceRowWriter(smallSheet, new Set());
for (let i = 0; i < 10; i++) {
  smallWriter.add({ id: 'cap_' + i, displayName: { text: '店' + i }, types: ['restaurant'] });
}
let capacityError = null;
try { smallWriter.flush(); } catch (e) { capacityError = e; }
check('シートの行数を超える書き込みでも例外にならない(行を自動追加する)',
  capacityError === null, capacityError ? String(capacityError.message) : '11行まで書き込み成功');
check('追加後の行数が必要行数以上になる', smallSheet.getMaxRows() >= 11,
  '行数=' + smallSheet.getMaxRows());
check('書き込んだ10件が欠けない', smallSheet.rows().length === 11, smallSheet.rows().length + '行');

// =====================================================================
console.log('\n[8] クォータ拒否で自前の月間枠を減らさないこと');
// =====================================================================
// checkAndIncrementApiQuota は実際に叩く前に数えるため、Google 側の日次クォータで
// 429 になった分まで自前の月間枠を消費していた。429 は課金対象外なので戻す。
// 日次トリガーは日次クォータを使い切った翌実行で必ずこれを踏むため、放置すると
// 毎日1件ずつ月間1,000の枠が溶ける。

/** 指定した HTTP ステータスを返すスタブを立て、1回だけ callSearchNearby する。 */
const callOnceWithResponse = function(responseCode) {
  const s = installGasGlobals({
    respondToSearch: function() { return { responseCode: responseCode, places: [] }; }
  });
  const result = api.callSearchNearby('stub-key', 'places.id', ['restaurant'], 35.8, 139.95, 700);
  return { count: parseInt(s.properties[api.QUOTA_PROP_COUNT] || '0', 10), result: result };
};

const okCall = callOnceWithResponse(200);
check('成功したコールは月間枠を1件消費する', okCall.count === 1, '消費=' + okCall.count);

const quotaCall = callOnceWithResponse(429);
check('429(クォータ拒否)は月間枠を消費しない', quotaCall.count === 0, '消費=' + quotaCall.count);
check('429 は quotaExceeded として返る',
  quotaCall.result.quotaExceeded === true && quotaCall.result.ok === false);
check('429 でも requestSent は true(実際に叩いているのでコール数の計測には出す)',
  quotaCall.result.requestSent === true);

// クォータ以外のエラーは戻さない: 課金の有無が仕様として自明でなく、戻すと暴走時に
// 上限が効かなくなるため。
const badRequestCall = callOnceWithResponse(400);
check('クォータ以外のエラー(400)は月間枠を消費したままにする', badRequestCall.count === 1,
  '消費=' + badRequestCall.count);
check('400 は quotaExceeded にならない', badRequestCall.result.quotaExceeded === false);

// 自前の上限に達していれば、そもそも叩かない(既存の挙動が壊れていないこと)
const atLimit = installGasGlobals({ respondToSearch: function() { return { places: [] }; } });
atLimit.properties[api.QUOTA_PROP_COUNT] = String(api.MONTHLY_API_CALL_LIMIT);
atLimit.properties['MONTHLY_API_CALL_MONTH'] = '2026-09'; // スタブの formatDate と同じ値
const blocked = api.callSearchNearby('stub-key', 'places.id', ['restaurant'], 35.8, 139.95, 700);
check('自前の月間上限に達していたらHTTPリクエストを送らない',
  blocked.requestSent === false && blocked.quotaExceeded === true &&
  atLimit.requestCount() === 0,
  'requestSent=' + blocked.requestSent + ' / 実リクエスト=' + atLimit.requestCount());

// =====================================================================
console.log('\n[9] 調査用(Pro段)と営業用(Enterprise段)で枠を食い合わないこと');
// =====================================================================
// 無料枠は段ごとに別勘定(Pro 5,000/月、Enterprise 1,000/月)。カウンタを分けないと
// 調査のコールが営業用の枠を食い潰し、分離した意味がなくなる。

const proQuota = api.MONTHLY_QUOTA_BY_SKU[api.API_SKU_PRO];
const entQuota = api.MONTHLY_QUOTA_BY_SKU[api.API_SKU_ENTERPRISE];

check('SKUの判定が fieldMask から導出される',
  api.apiSkuOfFieldMask(api.PLACE_SURVEY_FIELD_MASK) === api.API_SKU_PRO &&
  api.apiSkuOfFieldMask(api.PLACE_SEARCH_FIELD_MASK) === api.API_SKU_ENTERPRISE);
check('未知の fieldMask は安全側(Enterprise)に倒れる',
  api.apiSkuOfFieldMask('places.id') === api.API_SKU_ENTERPRISE);
check('Pro枠は Enterprise枠より大きい',
  proQuota.limit === 5000 && entQuota.limit === 1000,
  'Pro=' + proQuota.limit + ' / Enterprise=' + entQuota.limit);
check('Enterprise のプロパティ名が変わっていない(運用中のカウントを引き継ぐため)',
  entQuota.countProp === 'MONTHLY_API_CALL_COUNT' && entQuota.monthProp === 'MONTHLY_API_CALL_MONTH',
  entQuota.countProp);
check('Pro と Enterprise で別のプロパティを使う',
  proQuota.countProp !== entQuota.countProp, proQuota.countProp);

/** 指定した fieldMask で1回だけ callSearchNearby し、両SKUのカウンタを返す。 */
const callWithMask = function(fieldMask) {
  const s = installGasGlobals({ respondToSearch: function() { return { places: [] }; } });
  api.callSearchNearby('stub-key', fieldMask, ['restaurant'], 35.8, 139.95, 700);
  return {
    pro: parseInt(s.properties[proQuota.countProp] || '0', 10),
    enterprise: parseInt(s.properties[entQuota.countProp] || '0', 10)
  };
};

const surveyCall = callWithMask(api.PLACE_SURVEY_FIELD_MASK);
check('調査用コールは Pro枠だけを消費する',
  surveyCall.pro === 1 && surveyCall.enterprise === 0,
  'Pro=' + surveyCall.pro + ' / Enterprise=' + surveyCall.enterprise);

const harvestCall = callWithMask(api.PLACE_SEARCH_FIELD_MASK);
check('営業用コールは Enterprise枠だけを消費する',
  harvestCall.enterprise === 1 && harvestCall.pro === 0,
  'Pro=' + harvestCall.pro + ' / Enterprise=' + harvestCall.enterprise);

// Enterprise枠を使い切っていても、調査は Pro枠で続けられること
const entExhausted = installGasGlobals({ respondToSearch: function() { return { places: [] }; } });
entExhausted.properties[entQuota.countProp] = String(entQuota.limit);
entExhausted.properties[entQuota.monthProp] = '2026-09'; // スタブの formatDate と同じ値
const surveyWhileExhausted = api.callSearchNearby(
  'stub-key', api.PLACE_SURVEY_FIELD_MASK, ['restaurant'], 35.8, 139.95, 700);
check('Enterprise枠が尽きていても調査コールは通る',
  surveyWhileExhausted.requestSent === true && surveyWhileExhausted.quotaExceeded === false,
  'requestSent=' + surveyWhileExhausted.requestSent);
check('調査用の fieldMask では PLACE_SURVEY_FIELD_MASK が実際に送られる',
  api.PLACE_SURVEY_FIELD_MASK.indexOf('places.types') !== -1 &&
  api.PLACE_SURVEY_FIELD_MASK.indexOf('places.rating') === -1 &&
  api.PLACE_SURVEY_FIELD_MASK.indexOf('places.websiteUri') === -1,
  'Enterprise段の項目が混ざっていない');

// =====================================================================
console.log('\n[10] 0件予測セルの実地確認(surveyEmptyCells)');
// =====================================================================
// OSM が0件と見ているセルだけを Pro枠1コールずつで確認する。OSM の網羅性は
// Google に劣るので、0件のセルを捨てる前にここで裏を取る。

// 予測一覧(lib/survey/EmptyCellPrediction.js、自動生成)にあるIDを使う。
// 1 は一覧に無い = OSM が店を知っているセル。15 と 16 は一覧にある。
const PREDICTED_EMPTY_A = api.OSM_EMPTY_GRID_IDS[0];
const PREDICTED_EMPTY_B = api.OSM_EMPTY_GRID_IDS[1];
const NOT_PREDICTED_EMPTY = 1;
check('前提: 予測一覧に 1 は含まれず、先頭2件は含まれる',
  api.OSM_EMPTY_GRID_IDS.indexOf(NOT_PREDICTED_EMPTY) === -1 && api.OSM_EMPTY_GRID_IDS.length >= 2,
  '先頭: ' + PREDICTED_EMPTY_A + ', ' + PREDICTED_EMPTY_B);

// 緯度で応答を切り替えられるよう、セルごとに別の座標を与える
const SURVEY_CELLS = [
  [NOT_PREDICTED_EMPTY, 35.800, 139.950, 717, '未処理', 0, '', 0.01],
  [PREDICTED_EMPTY_A, 35.900, 140.100, 717, '未処理', 0, '', 0.01],
  [PREDICTED_EMPTY_B, 35.910, 140.110, 717, '未処理', 0, '', 0.01]
];

/**
 * surveyEmptyCells を1回実行する。
 * @param {Object} sheets - 引き継ぎたいシート(2回目の実行で調査ログを引き継ぐ)
 * @param {Object} props - 追加で設定するスクリプトプロパティ
 */
const runSurvey = function(sheets, props) {
  const s = installGasGlobals({
    // 予測Bのセルだけ、OSMが知らなかった店が返る
    respondToSearch: function(body) {
      if (body.locationRestriction.circle.center.latitude === 35.910) {
        return { places: [{ id: 'hidden_1', displayName: { text: '隠れた店' }, primaryType: 'ramen_restaurant', types: ['ramen_restaurant', 'restaurant'] }] };
      }
      return { places: [] };
    }
  });
  s.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
  s.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
  s.sheets['グリッド一覧'] = (sheets && sheets['グリッド一覧']) ||
    createFakeSheet([api.GRID_SHEET_HEADERS].concat(SURVEY_CELLS.map(function(r) { return r.slice(); })));
  if (sheets && sheets['調査ログ']) s.sheets['調査ログ'] = sheets['調査ログ'];
  Object.keys(props || {}).forEach(function(k) { s.properties[k] = props[k]; });
  api.surveyEmptyCells();
  return s;
};

const survey = runSurvey(null, null);
const surveyLog = survey.sheets['調査ログ'];
check('調査ログシートが作られる', !!surveyLog);

const logRows = surveyLog ? surveyLog.rows() : [];
check('ヘッダーが調査ログの定義どおり',
  logRows.length > 0 && logRows[0].join('|') === api.SURVEY_LOG_HEADERS.join('|'), logRows[0] && logRows[0].join('|'));
check('予測一覧に無いセルは確認対象にならない(OSMが店を知っている)',
  logRows.slice(1).every(function(r) { return r[0] !== NOT_PREDICTED_EMPTY; }),
  '記録されたグリッドID: ' + logRows.slice(1).map(function(r) { return r[0]; }).join(','));
check('予測一覧にある2セルだけが確認される', logRows.length - 1 === 2, (logRows.length - 1) + '件');

const judgementOf = function(gridId) {
  const row = logRows.slice(1).filter(function(r) { return r[0] === gridId; })[0];
  return row ? row[5] : '(記録なし)';
};
check('本当に空だったセルは「空(確認済み)」',
  judgementOf(PREDICTED_EMPTY_A) === '空(確認済み)', judgementOf(PREDICTED_EMPTY_A));
check('OSMが知らない店があったセルは「空でない」',
  judgementOf(PREDICTED_EMPTY_B) === '空でない', judgementOf(PREDICTED_EMPTY_B));

// 枠の分離: 調査は Pro枠だけを使う
check('調査は Pro枠だけを消費し、営業用のEnterprise枠を使わない',
  parseInt(survey.properties[proQuota.countProp] || '0', 10) === 2 &&
  parseInt(survey.properties[entQuota.countProp] || '0', 10) === 0,
  'Pro=' + (survey.properties[proQuota.countProp] || 0) +
  ' / Enterprise=' + (survey.properties[entQuota.countProp] || 0));
check('Googleへのリクエストは確認したセル数だけ(1セル1コール)',
  survey.requestCount() === 2, survey.requestCount() + '回');
check('実行時にネットワークへ出るのはGoogleだけ(OSMは事前生成なので叩かない)',
  survey.requestCount() === 2, survey.requestCount() + '回');

// 本番のシートを汚さないこと
check('「全飲食店データ」を作らない(営業用データには触らない)',
  !survey.sheets['全飲食店データ']);
check('「グリッド一覧」の処理状況を書き換えない',
  survey.sheets['グリッド一覧'].rows().slice(1).every(function(r) { return r[4] === '未処理'; }),
  survey.sheets['グリッド一覧'].rows().slice(1).map(function(r) { return r[4]; }).join(','));

// 再実行しても同じセルを二度叩かない(再開可能・冪等)
const second = runSurvey(survey.sheets, null);
check('再実行しても確認済みのセルは叩き直さない', second.requestCount() === 0,
  second.requestCount() + '回');
check('再実行で調査ログが増えない', second.sheets['調査ログ'].rows().length === logRows.length,
  second.sheets['調査ログ'].rows().length + '行');

// 予測一覧が現在のグリッド定義と食い違っていたら止まること
check('予測一覧は現在の対象範囲・セルサイズと一致している(生成し直し忘れの検知)',
  !survey.logs.some(function(l) { return l.indexOf('現在のグリッド定義と一致しません') !== -1; }),
  survey.logs.filter(function(l) { return l.indexOf('予測一覧') === 0; })[0] || '一致');

// --- 試算モード: 叩く前に消費コール数だけ知る ---
// 請求先を紐付けた本番キーに切り替えた直後など、消費量を確定させてから実行したい場合に使う。
const dryRun = runSurvey(null, { SURVEY_MAX_CALLS: '0' });
check('SURVEY_MAX_CALLS=0 ならGoogleへのリクエストが1件も発生しない',
  dryRun.requestCount() === 0, dryRun.requestCount() + '回');
check('試算モードは「実行したら何コール要るか」を報告する',
  dryRun.logs.some(function(l) { return l.indexOf('実行すれば 2 コール消費します') !== -1; }),
  dryRun.logs.filter(function(l) { return l.indexOf('確認対象:') === 0; })[0] || '(報告なし)');
check('試算モードでは調査ログに行を追加しない',
  !dryRun.sheets['調査ログ'] || dryRun.sheets['調査ログ'].rows().length <= 1,
  dryRun.sheets['調査ログ'] ? dryRun.sheets['調査ログ'].rows().length + '行' : 'シートなし');
check('試算モードではPro枠も消費しない',
  !dryRun.properties[proQuota.countProp], String(dryRun.properties[proQuota.countProp]));

// --- 上限を決めて少しずつ実行する ---
const capped = runSurvey(null, { SURVEY_MAX_CALLS: '1' });
check('SURVEY_MAX_CALLS で1回の実行を指定件数に抑えられる',
  capped.requestCount() === 1, capped.requestCount() + '回');
check('上限で止まった旨をログに出す',
  capped.logs.some(function(l) { return l.indexOf('SURVEY_MAX_CALLS') !== -1 && l.indexOf('達したため中断') !== -1; }));

// --- 探索済みのセルは調査しない ---
// どちらも予測一覧にあるセル。片方だけ探索済みにして、対象から外れることを見る。
const doneCells = [
  [PREDICTED_EMPTY_A, 35.900, 140.100, 717, '処理済み', 0, '', 0.01],
  [PREDICTED_EMPTY_B, 35.910, 140.110, 717, '未処理', 0, '', 0.01]
];
const withDone = runSurvey({
  'グリッド一覧': createFakeSheet([api.GRID_SHEET_HEADERS].concat(doneCells.map(function(r) { return r.slice(); })))
}, null);
check('探索済みのセルは調査対象から外れる(結果が分かっているため)',
  withDone.requestCount() === 1, withDone.requestCount() + '回');
check('対象外にした件数を報告する',
  withDone.logs.some(function(l) { return l.indexOf('探索済みのため対象外: 1セル') !== -1; }),
  withDone.logs.filter(function(l) { return l.indexOf('探索済みのため対象外') === 0; })[0] || '(報告なし)');

// --- 探索済みセルによる答え合わせ(APIコール0) ---
// 予測が0件と言ったセルのうち探索済みのものは、Googleでの結果がシートに残っている。
// コールを使う前にOSMの信頼度が分かる。
const A_ZERO = api.GRID_STATUS_EMPTY_BY_GROUP_A;
const accuracyCells = [
  // Googleでも見つからなかった3セル = 予測が当たり
  [api.OSM_EMPTY_GRID_IDS[0], 35.90, 140.10, 717, A_ZERO, 0, '', 0.01],
  [api.OSM_EMPTY_GRID_IDS[1], 35.90, 140.09, 717, A_ZERO, 0, '', 0.01],
  [api.OSM_EMPTY_GRID_IDS[2], 35.90, 140.08, 717, A_ZERO, 0, '', 0.01],
  // Googleでは店が見つかった1セル = 予測が外れ
  [api.OSM_EMPTY_GRID_IDS[3], 35.90, 140.07, 717, '処理済み', 0, '', 0.01]
];
const accuracy = runSurvey({
  'グリッド一覧': createFakeSheet([api.GRID_SHEET_HEADERS].concat(accuracyCells.map(function(r) { return r.slice(); })))
}, null);
const accuracyLogs = accuracy.logs.join('\n');
check('答え合わせにAPIコールを使わない', accuracy.requestCount() === 0, accuracy.requestCount() + '回');
check('予測が当たったセル数を報告する',
  accuracyLogs.indexOf('Googleでも見つからなかった: 3セル') !== -1,
  accuracy.logs.filter(function(l) { return l.indexOf('見つからなかった') !== -1; })[0] || '(報告なし)');
check('予測が外れたセル数を報告する',
  accuracyLogs.indexOf('Googleでは店が見つかった  : 1セル') !== -1,
  accuracy.logs.filter(function(l) { return l.indexOf('見つかった  :') !== -1; })[0] || '(報告なし)');
check('的中率を報告する', accuracyLogs.indexOf('的中率: 75.0%') !== -1,
  accuracy.logs.filter(function(l) { return l.indexOf('的中率') !== -1; })[0] || '(報告なし)');
check('外れたセルのステータス内訳を出す(原因を追えるように)',
  accuracyLogs.indexOf('外れたセルのステータス内訳') !== -1);
check('探索済みセルが無ければ答え合わせを出さない',
  survey.logs.every(function(l) { return l.indexOf('答え合わせ') === -1; }));

// --- 使用量の表示はSKUごとに出す(合計だけでは逼迫具合が分からない) ---
const usageStub = installGasGlobals({});
usageStub.properties[proQuota.countProp] = '154';
usageStub.properties[proQuota.monthProp] = '2026-09';
usageStub.properties[entQuota.countProp] = '1000';
usageStub.properties[entQuota.monthProp] = '2026-09';
api.checkMonthlyApiUsage();
check('Pro段の消費と残りを表示する',
  usageStub.logs.some(function(l) { return l.indexOf('154 / 5000') !== -1 && l.indexOf('残り 4846') !== -1; }),
  usageStub.logs.filter(function(l) { return l.indexOf('調査') !== -1; })[0] || '(表示なし)');
check('Enterprise段の消費と残りを表示する',
  usageStub.logs.some(function(l) { return l.indexOf('1000 / 1000') !== -1 && l.indexOf('残り 0') !== -1; }),
  usageStub.logs.filter(function(l) { return l.indexOf('営業') !== -1; })[0] || '(表示なし)');

// 先月のカウントが残っていても今月は0として表示する
const staleStub = installGasGlobals({});
staleStub.properties[entQuota.countProp] = '999';
staleStub.properties[entQuota.monthProp] = '2026-08'; // スタブの formatDate は 2026-09 を返す
api.checkMonthlyApiUsage();
check('先月のカウントは今月の消費として表示しない',
  staleStub.logs.some(function(l) { return l.indexOf('0 / 1000') !== -1; }),
  staleStub.logs.filter(function(l) { return l.indexOf('営業') !== -1; })[0] || '(表示なし)');

// =====================================================================
console.log('\n[11] 傘型プローブの被覆検証(compareProbeSetWithTypeGroups)');
// =====================================================================
// プローブ1コールで A/B/C/D 4コールと同じ店が取れるかを実地で見る。
// Pro段で行い、取得した place は「全飲食店データ」に書かない
// (rating も websiteUri も無い不完全な行を入れると、Place ID の重複除去で
//  本番クロールが二度とその店の営業データを取りに行かなくなる)。

const PROBE_CELLS = [
  [501, 35.80, 139.95, 717, '未処理', 0, '', 0.01],
  [502, 35.81, 139.96, 717, '未処理', 0, '', 0.01]
];

/**
 * compareProbeSetWithTypeGroups を1回実行する。
 * @param {function(Object): Object} respond - includedTypes に応じて返す places を決める
 * @param {Object} props
 */
const runProbeSurvey = function(respond, props) {
  const s = installGasGlobals({ respondToSearch: respond });
  s.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
  s.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
  s.sheets['グリッド一覧'] = createFakeSheet([api.GRID_SHEET_HEADERS].concat(PROBE_CELLS.map(function(r) { return r.slice(); })));
  Object.keys(props || {}).forEach(function(k) { s.properties[k] = props[k]; });
  api.compareProbeSetWithTypeGroups();
  return s;
};

/** プローブでも4グループでも同じ1件が返る = 傘型が成立しているケース。 */
const agreeingResponse = function() {
  return { places: [{ id: 'same_1', displayName: { text: '同じ店' }, types: ['ramen_restaurant', 'restaurant'] }] };
};

const agreed = runProbeSurvey(agreeingResponse, { PROBE_SURVEY_SAMPLE_SIZE: '2' });
check('判定できたセル数と一致セル数を報告する',
  agreed.logs.some(function(l) { return l.indexOf('完全一致: 2/2セル') !== -1; }),
  agreed.logs.filter(function(l) { return l.indexOf('完全一致') === 0; })[0] || '(報告なし)');
check('取りこぼしが無ければその旨を報告する',
  agreed.logs.some(function(l) { return l.indexOf('取りこぼしはありませんでした') !== -1; }));
check('1セルあたり5コール(プローブ1 + A/B/C/D 4)', agreed.requestCount() === 10,
  agreed.requestCount() + '回 / 2セル');
check('Pro枠だけを消費する(営業用のEnterprise枠を使わない)',
  parseInt(agreed.properties[proQuota.countProp] || '0', 10) === 10 &&
  parseInt(agreed.properties[entQuota.countProp] || '0', 10) === 0,
  'Pro=' + agreed.properties[proQuota.countProp] + ' / Enterprise=' + (agreed.properties[entQuota.countProp] || 0));
check('「全飲食店データ」に書き込まない(不完全な行で本番を汚さない)',
  !agreed.sheets['全飲食店データ']);

/** グループDでしか返らない店がある = 傘型が取りこぼしているケース。 */
const leakingResponse = function(body) {
  const isProbe = body.includedTypes.length === api.PLACE_TYPE_PROBE_SET.length;
  if (isProbe) return { places: [{ id: 'same_1', types: ['restaurant'] }] };
  const isGroupD = body.includedTypes[0] === api.BASE_TYPE_GROUPS[3][0];
  if (isGroupD) {
    return { places: [{ id: 'leaked_1', displayName: { text: '漏れた店' }, types: ['tibetan_restaurant', 'food'] }] };
  }
  return { places: [{ id: 'same_1', types: ['restaurant'] }] };
};

const leaked = runProbeSurvey(leakingResponse, { PROBE_SURVEY_SAMPLE_SIZE: '1' });
check('取りこぼした店を数える',
  leaked.logs.some(function(l) { return l.indexOf('プローブが取りこぼした店: 1件') !== -1; }),
  leaked.logs.filter(function(l) { return l.indexOf('比較した店') === 0; })[0] || '(報告なし)');
check('被覆率を報告する',
  leaked.logs.some(function(l) { return l.indexOf('被覆率: 50.0%') !== -1; }),
  leaked.logs.filter(function(l) { return l.indexOf('被覆率') !== -1; })[0] || '(報告なし)');
check('プローブ集合に足すべきタイプを提案する',
  leaked.logs.some(function(l) { return l.indexOf('tibetan_restaurant') !== -1; }),
  leaked.logs.filter(function(l) { return l.indexOf('tibetan') !== -1; })[0] || '(提案なし)');
check('検証ログに漏れた店のtypesが残る',
  leaked.sheets['調査ログ(傘型)'].rows().slice(1).some(function(r) {
    return String(r[7]).indexOf('tibetan_restaurant') !== -1;
  }),
  String(leaked.sheets['調査ログ(傘型)'].rows()[1] && leaked.sheets['調査ログ(傘型)'].rows()[1][7]));

/** プローブが20件返る = 飽和。U も切り捨てられるので比較しても意味が無い。 */
const saturatedResponse = function() {
  const places = [];
  for (let i = 0; i < 20; i++) places.push({ id: 'sat_' + i, types: ['restaurant'] });
  return { places: places };
};

const saturatedRun = runProbeSurvey(saturatedResponse, { PROBE_SURVEY_SAMPLE_SIZE: '1' });
check('飽和セルはプローブ1コールで打ち切る(4グループを叩かない)',
  saturatedRun.requestCount() === 1, saturatedRun.requestCount() + '回');
check('飽和セルは判定不能として数える',
  saturatedRun.logs.some(function(l) { return l.indexOf('飽和で判定不能: 1') !== -1; }),
  saturatedRun.logs.filter(function(l) { return l.indexOf('判定できたセル') === 0; })[0] || '(報告なし)');

// 再実行時に同じセルを二度叩かないこと
const probeLogSheet = agreed.sheets['調査ログ(傘型)'];
check('検証ログのヘッダーが定義どおり',
  probeLogSheet.rows()[0].join('|') === api.PROBE_SURVEY_LOG_HEADERS.join('|'),
  probeLogSheet.rows()[0].join('|'));
check('検証したセルがログに残る(再実行で続きから進めるため)',
  probeLogSheet.rows().length - 1 === 2, (probeLogSheet.rows().length - 1) + '行');

// =====================================================================
console.log('\n[12] 全マスの密度・タイプ調査(surveyAllCells)');
// =====================================================================
// Pro枠で全マスに1コールずつ投げ、密度とタイプの実態を集める。
// 本番シートには一切書かず、Enterprise枠も消費しない。

const AREA_CELLS = [
  [601, 35.80, 139.95, 717, '未処理', 0, '', 0.01],  // 3件
  [602, 35.81, 139.96, 717, '未処理', 0, '', 0.01],  // 0件
  [603, 35.82, 139.97, 358, '密集(分割済み)', 1, 601, 0.005] // 20件(飽和)
];

/**
 * surveyAllCells を1回実行する。
 * @param {Object} sheets - 引き継ぎたいシート(再実行の検証用)
 * @param {Object} props
 */
const runAreaSurvey = function(sheets, props) {
  const s = installGasGlobals({
    respondToSearch: function(body) {
      const lat = body.locationRestriction.circle.center.latitude;
      if (lat === 35.81) return { places: [] };
      const count = lat === 35.82 ? 20 : 3;
      const places = [];
      for (let i = 0; i < count; i++) {
        places.push({
          id: 'a_' + lat.toFixed(2) + '_' + i,
          displayName: { text: '店' + i },
          primaryType: 'ramen_restaurant',
          types: ['ramen_restaurant', 'restaurant', 'food']
        });
      }
      return { places: places };
    }
  });
  s.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
  s.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
  s.sheets['グリッド一覧'] = createFakeSheet([api.GRID_SHEET_HEADERS].concat(AREA_CELLS.map(function(r) { return r.slice(); })));
  ['調査(マス)', '調査(店)'].forEach(function(name) {
    if (sheets && sheets[name]) s.sheets[name] = sheets[name];
  });
  Object.keys(props || {}).forEach(function(k) { s.properties[k] = props[k]; });
  api.surveyAllCells();
  return s;
};

// --- 試算モード: 叩く前に消費コール数を知る ---
const areaDryRun = runAreaSurvey(null, { SURVEY_MAX_CALLS: '0' });
check('試算モードではGoogleへのリクエストが発生しない', areaDryRun.requestCount() === 0,
  areaDryRun.requestCount() + '回');
check('試算モードは実行に必要なコール数を報告する',
  areaDryRun.logs.some(function(l) { return l.indexOf('実行すれば 3 コール消費します') !== -1; }),
  areaDryRun.logs.filter(function(l) { return l.indexOf('未調査:') === 0; })[0] || '(報告なし)');

// --- 本実行 ---
const area = runAreaSurvey(null, null);
check('1マス1コール(飽和しても分割しない)', area.requestCount() === 3, area.requestCount() + '回');
check('Pro枠だけを消費する',
  parseInt(area.properties[proQuota.countProp] || '0', 10) === 3 &&
  parseInt(area.properties[entQuota.countProp] || '0', 10) === 0,
  'Pro=' + area.properties[proQuota.countProp] + ' / Enterprise=' + (area.properties[entQuota.countProp] || 0));
check('「全飲食店データ」に書き込まない', !area.sheets['全飲食店データ']);
check('「グリッド一覧」を書き換えない',
  area.sheets['グリッド一覧'].rows()[1][4] === '未処理',
  area.sheets['グリッド一覧'].rows()[1][4]);

const areaCellSheet = area.sheets['調査(マス)'];
const areaPlaceSheet = area.sheets['調査(店)'];
check('マス単位のシートに全マスが記録される', areaCellSheet.rows().length - 1 === 3,
  (areaCellSheet.rows().length - 1) + '行');
check('店単位のシートに取得した店が記録される(3+0+20=23件)',
  areaPlaceSheet.rows().length - 1 === 23, (areaPlaceSheet.rows().length - 1) + '行');
check('階層も記録する(子マスの密度を親と区別するため)',
  areaCellSheet.rows().slice(1).some(function(r) { return r[4] === 1; }),
  areaCellSheet.rows().slice(1).map(function(r) { return r[4]; }).join(','));
check('飽和したマスに印が付く',
  areaCellSheet.rows().slice(1).filter(function(r) { return String(r[6]).indexOf('飽和') !== -1; }).length === 1,
  areaCellSheet.rows().slice(1).map(function(r) { return r[6]; }).join('|'));

check('密度の分布を報告する',
  area.logs.some(function(l) { return l.indexOf('0件(探索不要)') !== -1; }),
  area.logs.filter(function(l) { return l.indexOf('0件(探索不要)') !== -1; })[0] || '(報告なし)');
check('タイプの被覆率と最小被覆集合を報告する',
  area.logs.some(function(l) { return l.indexOf('現行プローブ集合の被覆率') !== -1; }) &&
  area.logs.some(function(l) { return l.indexOf('最小被覆集合') !== -1; }));
check('カタログのうち実在が確認できた種類数を報告する(刈り込みの根拠)',
  area.logs.some(function(l) { return l.indexOf('実在が確認できたもの') !== -1; }),
  area.logs.filter(function(l) { return l.indexOf('カタログ166種') !== -1; })[0] || '(報告なし)');

// --- 再実行: 調査済みのマスは叩き直さない ---
const areaSecond = runAreaSurvey(area.sheets, null);
check('再実行しても調査済みのマスは叩き直さない', areaSecond.requestCount() === 0,
  areaSecond.requestCount() + '回');
check('全マス調査済みならその旨を報告する',
  areaSecond.logs.some(function(l) { return l.indexOf('未調査のマスはありません') !== -1; }));
check('再実行でも累計の分析は出る(途中経過を読めるように)',
  areaSecond.logs.some(function(l) { return l.indexOf('最小被覆集合') !== -1; }));

// --- 書き込みがバッチ化されていること ---
// シートへのラウンドトリップは実行時間を食い、6分の制限内に回せるAPIコール数を減らす。
// 1マスごとに書いていないことを、書き込み回数で機械的に保証する。
const MANY_CELLS = [];
for (let i = 0; i < 250; i++) {
  MANY_CELLS.push([700 + i, 35.80, 139.95, 717, '未処理', 0, '', 0.01]);
}
const batched = installGasGlobals({
  respondToSearch: function() {
    return { places: [{ id: 'b', displayName: { text: '店' }, primaryType: 'x', types: ['restaurant'] }] };
  }
});
batched.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
batched.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
batched.sheets['グリッド一覧'] = createFakeSheet([api.GRID_SHEET_HEADERS].concat(MANY_CELLS));
api.surveyAllCells();

const cellWrites = batched.sheets['調査(マス)'].writeCount();
const placeWrites = batched.sheets['調査(店)'].writeCount();
check('250マスでもシート書き込みは数回に収まる(1マス1回書いていない)',
  cellWrites <= 6 && placeWrites <= 6,
  '調査(マス)=' + cellWrites + '回 / 調査(店)=' + placeWrites + '回 / APIコール=' + batched.requestCount() + '回');
check('長い実行では途中経過を出す(止まって見えないように)',
  batched.logs.some(function(l) { return l.indexOf('進捗: 100/250マス調査済み') !== -1; }),
  batched.logs.filter(function(l) { return l.indexOf('進捗:') === 0; }).join(' / ') || '(進捗なし)');
check('バッチ化しても記録は欠けない',
  batched.sheets['調査(マス)'].rows().length - 1 === 250 &&
  batched.sheets['調査(店)'].rows().length - 1 === 250,
  'マス=' + (batched.sheets['調査(マス)'].rows().length - 1) +
  ' / 店=' + (batched.sheets['調査(店)'].rows().length - 1));
check('書き出し位置をメモリで進めても行が重ならない',
  new Set(batched.sheets['調査(マス)'].rows().slice(1).map(function(r) { return r[0]; })).size === 250);

// --- 上限で刻めること ---
const areaCapped = runAreaSurvey(null, { SURVEY_MAX_CALLS: '1' });
check('SURVEY_MAX_CALLS で1回の実行を刻める', areaCapped.requestCount() === 1,
  areaCapped.requestCount() + '回');

// =====================================================================
console.log('\n[13] 飽和マスの深さ調査(surveySaturatedCells)');
// =====================================================================
// 飽和マスを4分割した子マスにプローブを投げ、4分割で足りるかを測る。
// 「グリッド一覧」に子グリッドを追加しない(本番の進捗を変えずに測るのが目的)。

check('childCellsOf は親を4象限に割り、子の半径が概ね半分になる',
  api.childCellsOf(35.80, 139.95, 0.01).length === 4 &&
  Math.abs(api.childCellsOf(35.80, 139.95, 0.01)[0].radius - 359) <= 2,
  '子半径=' + api.childCellsOf(35.80, 139.95, 0.01)[0].radius + 'm');

/** 「調査(マス)」を模したシートを作る。2つ飽和、1つは疎。 */
const buildAreaCellSheet = function() {
  return createFakeSheet([
    api.AREA_SURVEY_CELL_HEADERS,
    [801, 35.80, 139.95, 717, 0, 20, '飽和(20件以上)', new Date()],
    [802, 35.82, 139.97, 717, 0, 5, '', new Date()],
    [803, 35.84, 139.99, 717, 0, 20, '飽和(20件以上)', new Date()]
  ]);
};

/**
 * surveySaturatedCells を1回実行する。
 * @param {Object} sheets
 * @param {Object} props
 * @param {function} respond
 */
const runSaturatedSurvey = function(sheets, props, respond) {
  const s = installGasGlobals({ respondToSearch: respond || function() {
    return { places: [{ id: 'c1', types: ['restaurant'] }] }; // 子は1件 = 解決
  }});
  s.properties['GOOGLE_MAPS_API_KEY'] = 'stub-key';
  s.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
  s.sheets['調査(マス)'] = (sheets && sheets['調査(マス)']) || buildAreaCellSheet();
  if (sheets && sheets['調査(子マス)']) s.sheets['調査(子マス)'] = sheets['調査(子マス)'];
  Object.keys(props || {}).forEach(function(k) { s.properties[k] = props[k]; });
  api.surveySaturatedCells();
  return s;
};

const satDry = runSaturatedSurvey(null, { SURVEY_MAX_CALLS: '0' }, null);
check('試算モードではGoogleへのリクエストが発生しない', satDry.requestCount() === 0,
  satDry.requestCount() + '回');
check('試算モードは必要なコール数(親2×子4=8)を報告する',
  satDry.logs.some(function(l) { return l.indexOf('実行すれば 8 コール消費します') !== -1; }),
  satDry.logs.filter(function(l) { return l.indexOf('未調査:') === 0; })[0] || '(報告なし)');

const sat = runSaturatedSurvey(null, null, null);
check('飽和マスだけを対象にする(疎なマスは調べない)', sat.requestCount() === 8,
  sat.requestCount() + '回 / 飽和2マス × 子4');
check('Pro枠だけを消費する',
  parseInt(sat.properties[proQuota.countProp] || '0', 10) === 8 &&
  parseInt(sat.properties[entQuota.countProp] || '0', 10) === 0,
  'Pro=' + sat.properties[proQuota.countProp] + ' / Enterprise=' + (sat.properties[entQuota.countProp] || 0));
check('「グリッド一覧」に子グリッドを追加しない(本番の進捗を変えない)',
  !sat.sheets['グリッド一覧']);
check('「全飲食店データ」に書き込まない', !sat.sheets['全飲食店データ']);

const childRows = sat.sheets['調査(子マス)'].rows();
check('親1つにつき子4行を記録する', childRows.length - 1 === 8, (childRows.length - 1) + '行');
check('象限のラベルが4種そろう',
  new Set(childRows.slice(1).map(function(r) { return r[1]; })).size === 4,
  Array.from(new Set(childRows.slice(1).map(function(r) { return r[1]; }))).join(','));
check('4分割で解決した割合を報告する',
  sat.logs.some(function(l) { return l.indexOf('4分割で解決した親マス: 2/2') !== -1; }),
  sat.logs.filter(function(l) { return l.indexOf('4分割で解決した親マス') !== -1; })[0] || '(報告なし)');

// 子もまだ飽和するケース
const deep = runSaturatedSurvey(null, null, function() {
  const places = [];
  for (let i = 0; i < 20; i++) places.push({ id: 'd' + i, types: ['restaurant'] });
  return { places: places };
});
check('子がまだ飽和するなら未解決として数える',
  deep.logs.some(function(l) { return l.indexOf('4分割で解決した親マス: 0/2') !== -1; }),
  deep.logs.filter(function(l) { return l.indexOf('4分割で解決した親マス') !== -1; })[0] || '(報告なし)');
check('まだ飽和している子マス数を報告する',
  deep.logs.some(function(l) { return l.indexOf('まだ飽和している子マス: 8') !== -1; }),
  deep.logs.filter(function(l) { return l.indexOf('調査した親マス') === 0; })[0] || '(報告なし)');

// 再実行で同じ親を叩き直さない
const satSecond = runSaturatedSurvey(sat.sheets, null, null);
// 親25個ごとに進捗が出ること(880コールの実行で無反応にならないように)
const satMany = runSaturatedSurvey({
  '調査(マス)': createFakeSheet([api.AREA_SURVEY_CELL_HEADERS].concat(
    Array.apply(null, { length: 30 }).map(function(_, i) {
      return [900 + i, 35.80 + i * 0.01, 139.95, 717, 0, 20, '飽和(20件以上)', new Date()];
    })
  ))
}, null, null);
check('親25個ごとに進捗を出す',
  satMany.logs.some(function(l) { return l.indexOf('進捗: 25/30親マス (100コール済み)') !== -1; }),
  satMany.logs.filter(function(l) { return l.indexOf('進捗:') === 0; }).join(' / ') || '(進捗なし)');

check('再実行しても調査済みの親マスは叩き直さない', satSecond.requestCount() === 0,
  satSecond.requestCount() + '回');

// 上限は親単位で刻む(親4コール未満の端数では1親も処理しない)
const satCapped = runSaturatedSurvey(null, { SURVEY_MAX_CALLS: '4' }, null);
check('SURVEY_MAX_CALLS は親単位で刻む(4なら親1つ)', satCapped.requestCount() === 4,
  satCapped.requestCount() + '回');
const satTooSmall = runSaturatedSurvey(null, { SURVEY_MAX_CALLS: '3' }, null);
check('親1つぶんに満たない上限なら何も叩かない', satTooSmall.requestCount() === 0,
  satTooSmall.requestCount() + '回');

console.log('\n' + (failures === 0 ? '✅ すべて通過' : '❌ ' + failures + ' 件失敗') + '\n');
process.exit(failures === 0 ? 0 : 1);
