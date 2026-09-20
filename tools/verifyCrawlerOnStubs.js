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
    MAX_TIER: MAX_TIER
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
console.log('\n[6] フィルタ条件の保持と行容量(Issue #5)');
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

console.log('\n' + (failures === 0 ? '✅ すべて通過' : '❌ ' + failures + ' 件失敗') + '\n');
process.exit(failures === 0 ? 0 : 1);
