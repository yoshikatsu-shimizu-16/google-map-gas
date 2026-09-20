/**
 * プローブ集合と被覆分析(純関数)の検証スクリプト(ローカル実行用)。
 *
 *   node tools/verifyProbeSetCoverage.js
 *
 * lib/catalog/PlaceTypeProbeSet.js と lib/catalog/PlaceTypeCoverageAnalysis.js は
 * Sheet/Logger/API に一切依存しない純粋な計算ロジックのため、ここでAPIコールも
 * スプレッドシートも使わずに検証できる。auditProbeSetCoverage だけは Sheet/Logger を
 * 読み書きするため、tools/gasStubs.js のスタブ上で動かして確認する。
 */
const { loadDeployedSource, createFakeSheet, installGasGlobals } = require('./gasStubs');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  -- ' + detail : ''));
  if (!ok) failures++;
}

const { source, files } = loadDeployedSource();
console.log('\nデプロイ対象 ' + files.length + ' ファイルを結合して検証します。');

const api = new Function(source + `
  return {
    PLACE_TYPE_PROBE_SET: PLACE_TYPE_PROBE_SET,
    isCoveredByProbeSet: isCoveredByProbeSet,
    parsePlaceTypesCell: parsePlaceTypesCell,
    summarizeProbeCoverage: summarizeProbeCoverage,
    findMinimalProbeCover: findMinimalProbeCover,
    ALL_SEARCHABLE_PLACE_TYPES: ALL_SEARCHABLE_PLACE_TYPES,
    INCLUDED_TYPES_MAX_PER_REQUEST: INCLUDED_TYPES_MAX_PER_REQUEST,
    PLACE_DATA_HEADERS: PLACE_DATA_HEADERS,
    auditProbeSetCoverage: auditProbeSetCoverage
  };
`)();

// =====================================================================
console.log('\n[1] PLACE_TYPE_PROBE_SET そのものの健全性');
// =====================================================================
check('要素数が INCLUDED_TYPES_MAX_PER_REQUEST 以下',
  api.PLACE_TYPE_PROBE_SET.length <= api.INCLUDED_TYPES_MAX_PER_REQUEST,
  api.PLACE_TYPE_PROBE_SET.length + '種 / 上限' + api.INCLUDED_TYPES_MAX_PER_REQUEST + '種');
check('重複がない',
  new Set(api.PLACE_TYPE_PROBE_SET).size === api.PLACE_TYPE_PROBE_SET.length);
check('全要素が ALL_SEARCHABLE_PLACE_TYPES に含まれる(includedTypes は Table A のみという制約)',
  api.PLACE_TYPE_PROBE_SET.every(function(t) { return api.ALL_SEARCHABLE_PLACE_TYPES.indexOf(t) !== -1; }));

// =====================================================================
console.log('\n[2] isCoveredByProbeSet');
// =====================================================================
check("['ramen_restaurant','restaurant','food'] → true",
  api.isCoveredByProbeSet(['ramen_restaurant', 'restaurant', 'food']) === true);
check("['point_of_interest','establishment'] → false",
  api.isCoveredByProbeSet(['point_of_interest', 'establishment']) === false);
check('[] → false', api.isCoveredByProbeSet([]) === false);
check('undefined → false', api.isCoveredByProbeSet(undefined) === false);

// =====================================================================
console.log('\n[3] parsePlaceTypesCell');
// =====================================================================
check("'a, b' → ['a','b']", JSON.stringify(api.parsePlaceTypesCell('a, b')) === JSON.stringify(['a', 'b']));
check("'a,b' → ['a','b']", JSON.stringify(api.parsePlaceTypesCell('a,b')) === JSON.stringify(['a', 'b']));
check("'' → []", JSON.stringify(api.parsePlaceTypesCell('')) === JSON.stringify([]));
check("数値セル(0)は文字列化されて ['0'] になる(空セルとは区別する)",
  JSON.stringify(api.parsePlaceTypesCell(0)) === JSON.stringify(['0']));
check('未定義セル → []', JSON.stringify(api.parsePlaceTypesCell(undefined)) === JSON.stringify([]));
check('null セル → []', JSON.stringify(api.parsePlaceTypesCell(null)) === JSON.stringify([]));

// =====================================================================
console.log('\n[4] findMinimalProbeCover (既知の手製行列)');
// =====================================================================
// 行0-2: 'a' で覆える(3行) / 行3: 'b'のみ / 行4: 'c'のみ / 行5: カタログ型を持たない(uncovered)
const matrixRows = [
  ['a', 'x'], ['a'], ['a', 'b'],
  ['b'],
  ['c'],
  ['point_of_interest']
];
const candidateTypes = ['a', 'b', 'c'];

const cover1 = api.findMinimalProbeCover(matrixRows, candidateTypes, 3);
check("最初に選ばれるのは 'a'(3行を新規被覆する最良の候補)",
  cover1.cover[0] && cover1.cover[0].type === 'a' && cover1.cover[0].newlyCovered === 3,
  JSON.stringify(cover1.cover));
check('選択順が a→b→c になる',
  cover1.cover.map(function(c) { return c.type; }).join(',') === 'a,b,c',
  cover1.cover.map(function(c) { return c.type; }).join(','));
check('累積被覆数が5行(行5はカタログ型を持たないため被覆されない)',
  cover1.coveredCount === 5, 'coveredCount=' + cover1.coveredCount);
check('カタログ型を持たない行(5)が uncoveredRowIndexes に出る',
  cover1.uncoveredRowIndexes.indexOf(5) !== -1, JSON.stringify(cover1.uncoveredRowIndexes));

const cover2 = api.findMinimalProbeCover(matrixRows, candidateTypes, 3);
check('2回実行しても同一の結果になる(決定性)',
  JSON.stringify(cover1) === JSON.stringify(cover2));

const coverLimited = api.findMinimalProbeCover(matrixRows, candidateTypes, 1);
check('maxSize=1 で打ち切られる', coverLimited.cover.length === 1, coverLimited.cover.length + '件');

// 新規被覆数・総ヒット数が完全に同数のタイブレークを確認する専用の行列
const tieRows = [['y'], ['z']];
const tieCover = api.findMinimalProbeCover(tieRows, ['z', 'y'], 2);
check('新規被覆数・総ヒット数が同数のときは辞書順で選ばれる(y→z)',
  tieCover.cover.map(function(c) { return c.type; }).join(',') === 'y,z',
  tieCover.cover.map(function(c) { return c.type; }).join(','));

// =====================================================================
console.log('\n[5] summarizeProbeCoverage');
// =====================================================================
const probeSetForSummary = ['a', 'b'];
const catalogForSummary = ['a', 'b', 'c', 'd'];
const summaryRows = [
  ['a'], ['a'], ['a', 'b'], ['b'], ['c'], ['store', 'point_of_interest']
];
const summary = api.summarizeProbeCoverage(summaryRows, probeSetForSummary, catalogForSummary);
check('coveredCount が4(a / a / a,b / b の4行が被覆される)', summary.coveredCount === 4, 'coveredCount=' + summary.coveredCount);
check("uncoveredRowIndexes に 'c'のみの行(4)と 'store'のみの行(5)が入る",
  summary.uncoveredRowIndexes.indexOf(4) !== -1 && summary.uncoveredRowIndexes.indexOf(5) !== -1,
  JSON.stringify(summary.uncoveredRowIndexes));
check("soleCoverCountByProbeType['a'] が2('a'単独の行が2件)",
  summary.soleCoverCountByProbeType['a'] === 2, JSON.stringify(summary.soleCoverCountByProbeType));
check("hitCountByProbeType['b'] が2('a,b'の行と'b'の行)", summary.hitCountByProbeType['b'] === 2, JSON.stringify(summary.hitCountByProbeType));
check("catalogTypesNeverObserved に 'd' が入る(カタログにあるが1件も出現しない)",
  summary.catalogTypesNeverObserved.indexOf('d') !== -1, JSON.stringify(summary.catalogTypesNeverObserved));
check("observedNonCatalogTypes に 'store' が1件で記録される",
  summary.observedNonCatalogTypes['store'] === 1, JSON.stringify(summary.observedNonCatalogTypes));

// =====================================================================
console.log('\n[6] auditProbeSetCoverage(フェイクシートで通す。APIコールなし)');
// =====================================================================
const stub = installGasGlobals({});
stub.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';

const dataSheet = createFakeSheet([api.PLACE_DATA_HEADERS]);
const nameCol = api.PLACE_DATA_HEADERS.indexOf('店名');
const typesCol = api.PLACE_DATA_HEADERS.indexOf('全タイプ');
const buildRow = function(name, typesCell) {
  const row = api.PLACE_DATA_HEADERS.map(function() { return ''; });
  row[nameCol] = name;
  row[typesCol] = typesCell;
  return row;
};
dataSheet.appendRow(buildRow('被覆される店', api.PLACE_TYPE_PROBE_SET[0] + ', food'));
dataSheet.appendRow(buildRow('未移行の店(全タイプ空)', ''));
dataSheet.appendRow(buildRow('被覆されない店', 'point_of_interest, establishment'));
// スタブの SpreadsheetApp.openById が返す固定 spreadsheet はこの sheets オブジェクトを
// そのまま参照しているため、ここに直接差し込めば getSheetByName('全飲食店データ') で拾える。
stub.sheets['全飲食店データ'] = dataSheet;

api.auditProbeSetCoverage();

const healthLog = stub.logs.filter(function(l) { return l.indexOf('[1. 母集団の健全性]') === 0; })[0];
check('母集団の健全性ログが出力される', !!healthLog, healthLog);
check('「全タイプ」が空の行(1件)は未被覆ではなく判定対象外に数えられる',
  !!healthLog && healthLog.indexOf('判定対象: 2') !== -1, healthLog);

const coverageLog = stub.logs.filter(function(l) { return l.indexOf('[3. 現行プローブ集合の被覆率]') === 0; })[0];
check('被覆率ログが判定対象2行のうち1行被覆になる(空行を分母に含めない)',
  !!coverageLog && coverageLog.indexOf('1/2') !== -1, coverageLog);

// =====================================================================
console.log('\n[7] 旧スキーマのシートを誤読しないこと');
// =====================================================================
// 旧20列スキーマでは3列目が「全タイプ」ではなく「住所」。期待するスキーマの並びを
// そのまま信じて列番号を決めると、住所文字列をタイプ配列として解釈してしまい、
// 「被覆率0%」という無意味な結果が出る(実際に本番シートで起きた)。
const LEGACY_PLACE_HEADERS = [
  '店名', '主タイプ', '住所',
  '電話番号(国内)', 'HP有無', 'HP URL', 'Google Maps URL',
  '評価', '評価件数',
  '営業状況', '通常営業時間', '価格帯',
  'テイクアウト', 'デリバリー', '店内飲食', '予約可',
  '子連れ向き', 'ペット可', '説明文(Editorial)',
  'Place ID'
];
const legacyStub = installGasGlobals({});
legacyStub.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
legacyStub.sheets['全飲食店データ'] = createFakeSheet([
  LEGACY_PLACE_HEADERS,
  ['デニーズ 二十世紀ヶ丘店', 'ファミリーレストラン', '〒271-0085 千葉県松戸市二十世紀が丘中松町２０',
   '047-000-0000', 'なし', '', 'https://maps.google.com/?cid=1', 3.5, 300,
   'OPERATIONAL', '月曜日: 24時間営業', '', '', '', '', '', '', '', '', 'ChIJ_legacy']
]);

api.auditProbeSetCoverage();

const legacyWarning = legacyStub.logs.filter(function(l) { return l.indexOf('列がありません') !== -1; })[0];
check('旧スキーマでは列が無い旨を報告して中断する', !!legacyWarning, legacyWarning);
check('被覆率を算出しない(0%という誤った結果を出さない)',
  legacyStub.logs.every(function(l) { return l.indexOf('[3. 現行プローブ集合の被覆率]') !== 0; }),
  legacyStub.logs.filter(function(l) { return l.indexOf('[3.') === 0; }).join(' / ') || 'なし');
check('places.types が後から追加された項目である旨を案内する',
  legacyStub.logs.some(function(l) { return l.indexOf('places.types') !== -1; }));

// --- 最新スキーマだが「全タイプ」が全行空のケース(移行直後の実態) ---
const emptyTypesStub = installGasGlobals({});
emptyTypesStub.properties['TARGET_SPREADSHEET_ID'] = 'stub-spreadsheet-id';
const emptyTypesSheet = createFakeSheet([api.PLACE_DATA_HEADERS]);
emptyTypesSheet.appendRow(buildRow('移行直後の店', ''));
emptyTypesStub.sheets['全飲食店データ'] = emptyTypesSheet;

api.auditProbeSetCoverage();

check('全行の「全タイプ」が空なら、理由を添えて中断する',
  emptyTypesStub.logs.some(function(l) { return l.indexOf('判定に使える行が0件です') === 0 && l.indexOf('places.types') !== -1; }),
  emptyTypesStub.logs.filter(function(l) { return l.indexOf('判定に使える行が0件です') === 0; })[0]);

console.log('\n' + (failures === 0 ? '✅ すべて通過' : '❌ ' + failures + ' 件失敗') + '\n');
process.exit(failures === 0 ? 0 : 1);
