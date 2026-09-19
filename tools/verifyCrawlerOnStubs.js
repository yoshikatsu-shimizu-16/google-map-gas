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
        rating: 4.1
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
    cellCoverRadiusMeters: cellCoverRadiusMeters,
    GRID_SHEET_HEADERS: GRID_SHEET_HEADERS,
    GRID_STEP: GRID_STEP
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

const ids = data.slice(1).map(function(r) { return r[19]; });
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

console.log('\n' + (failures === 0 ? '✅ すべて通過' : '❌ ' + failures + ' 件失敗') + '\n');
process.exit(failures === 0 ? 0 : 1);
