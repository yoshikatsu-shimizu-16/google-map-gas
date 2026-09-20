/**
 * グリッド重複解析の検証スクリプト(ローカル実行用、APIコールなし)。
 *
 *   node tools/verifyGridOverlapAnalysis.js
 *
 * lib/grid/GridOverlapAnalysis.js は SpreadsheetApp に依存しない純関数だけで
 * 構成されているため、GAS にデプロイせずここで検証できる(Issue #24)。
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const sources = ['lib/grid/GridGeometry.js', 'lib/grid/GridOverlapAnalysis.js']
  .map(function(f) { return fs.readFileSync(path.join(repoRoot, f), 'utf8'); })
  .join('\n');

const {
  circleIntersectionArea, overlapFraction, findOverlappingPairs, findRootRadiusMismatches,
  cellCoverRadiusMeters
} = new Function(sources + '\nreturn { circleIntersectionArea, overlapFraction,' +
  ' findOverlappingPairs, findRootRadiusMismatches, cellCoverRadiusMeters };')();

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  -- ' + detail : ''));
  if (!ok) failures++;
}

// =====================================================================
console.log('\n[1] circleIntersectionArea / overlapFraction の基本ケース');
// =====================================================================
check('離れた円の交差面積は0', circleIntersectionArea(1000, 100, 100) === 0);
check('接している円の交差面積はほぼ0',
  circleIntersectionArea(200, 100, 100) < 1, circleIntersectionArea(200, 100, 100));
check('完全に内包される円の交差面積は小さい円の面積そのもの',
  Math.abs(circleIntersectionArea(0, 50, 100) - Math.PI * 50 * 50) < 1e-6);
check('同心円で片方が内包されるとき、重複率は1.0',
  overlapFraction({ lat: 35.8, lng: 139.9, radius: 100 }, { lat: 35.8, lng: 139.9, radius: 200 }) === 1);
check('半径の和より離れた円は重複率0',
  overlapFraction({ lat: 35.8, lng: 139.9, radius: 100 }, { lat: 35.9, lng: 139.9, radius: 100 }) === 0);

// 旧ロジック(親円0.6R、子中心が0.707R離れる)で生成した隣接兄弟円は、
// 中心間距離が半径の和より必ず小さくなり重なる、という docs/Overview.js の指摘を
// 具体的な数値で確認する。
const R = 700;
const childRadius = R * 0.6;
const childOffset = R * 0.707; // 対角方向のオフセット
// 東西南北ではなく対角(NE/NW/SE/SW)配置なので、隣接兄弟(NE-NW)の中心間距離は
// 2 * childOffset * sin(45°)
const siblingDistance = 2 * childOffset * Math.sin(Math.PI / 4);
check('旧ロジックの隣接兄弟円は中心間距離が半径の和より小さい(重なる設計だった)',
  siblingDistance < childRadius * 2,
  '中心間=' + siblingDistance.toFixed(1) + 'm / 半径の和=' + (childRadius * 2).toFixed(1) + 'm');
const siblingFraction = overlapFraction(
  { lat: 0, lng: 0, radius: childRadius },
  { lat: 0, lng: metersToLngDeltaForTest(siblingDistance), radius: childRadius }
);
check('旧ロジックの隣接兄弟円は重複率0ではない(重ならない設計だと誤解しないための確認)',
  siblingFraction > 0.05, (siblingFraction * 100).toFixed(1) + '%');

/** テスト専用の簡易変換(緯度0度なので cos=1、GridGeometry.js の内部定数と重複させない)。 */
function metersToLngDeltaForTest(meters) {
  return meters / 111320;
}

// =====================================================================
console.log('\n[2] findOverlappingPairs');
// =====================================================================
const cellsNoOverlap = [
  { gridId: 1, lat: 35.80, lng: 139.90, radius: 100, tier: 0 },
  { gridId: 2, lat: 35.90, lng: 140.00, radius: 100, tier: 0 }
];
check('重ならないセルは0組', findOverlappingPairs(cellsNoOverlap).length === 0);

const cellsOverlap = [
  { gridId: 10, lat: 35.80, lng: 139.90, radius: 500, tier: 0 },
  { gridId: 11, lat: 35.80, lng: 139.9005, radius: 300, tier: 1 } // 中心が約45m東
];
const overlapPairs = findOverlappingPairs(cellsOverlap, { minFraction: 0.2 });
check('重なるセルは1組検出される', overlapPairs.length === 1);
check('検出結果にグリッドIDが両方含まれる',
  overlapPairs.length === 1 && overlapPairs[0].aId === 10 && overlapPairs[0].bId === 11);
check('fractionは0〜1の範囲', overlapPairs.length === 1 && overlapPairs[0].fraction > 0 && overlapPairs[0].fraction <= 1);

const cellsThreeWay = [
  { gridId: 20, lat: 35.80, lng: 139.90, radius: 500, tier: 0 },
  { gridId: 21, lat: 35.80, lng: 139.9005, radius: 300, tier: 1 },
  { gridId: 22, lat: 35.85, lng: 140.00, radius: 100, tier: 0 } // 遠く離れている
];
const threeWayPairs = findOverlappingPairs(cellsThreeWay, { minFraction: 0.2 });
check('遠いセルはペアに含まれない(3セルで1組だけ検出)', threeWayPairs.length === 1);
check('fractionの降順でソートされる', (function() {
  for (let i = 1; i < threeWayPairs.length; i++) {
    if (threeWayPairs[i - 1].fraction < threeWayPairs[i].fraction) return false;
  }
  return true;
})());

// =====================================================================
console.log('\n[3] findRootRadiusMismatches');
// =====================================================================
const REF_LAT = 35.855;
const GRID_STEP = 0.01;
const correctRadius = cellCoverRadiusMeters(GRID_STEP, REF_LAT);
const cellsRadius = [
  { gridId: 100, lat: REF_LAT, radius: 700, tier: 0 },              // 旧ロジックの決め打ち値
  { gridId: 101, lat: REF_LAT, radius: correctRadius, tier: 0 },    // 現行ロジックの正しい値
  { gridId: 102, lat: REF_LAT, radius: 700, tier: 1 }                // 階層0以外は対象外
];
const radiusMismatches = findRootRadiusMismatches(cellsRadius, GRID_STEP);
check('階層0で決め打ち700mの行だけが不一致として検出される',
  radiusMismatches.length === 1 && radiusMismatches[0].gridId === 100,
  JSON.stringify(radiusMismatches));
check('不一致の差分が正しく計算される(現行値 - 記録値)',
  radiusMismatches.length === 1 && radiusMismatches[0].diff === correctRadius - 700,
  '差=' + (radiusMismatches[0] && radiusMismatches[0].diff));
check('現行ロジックと一致する行は検出されない',
  radiusMismatches.every(function(m) { return m.gridId !== 101; }));
check('階層0以外の行は対象外', radiusMismatches.every(function(m) { return m.gridId !== 102; }));
check('700m決め打ちのズレは対象エリアの緯度帯で十数m規模(実測との整合)',
  Math.abs(correctRadius - 700) >= 10 && Math.abs(correctRadius - 700) <= 30,
  '現行計算値=' + correctRadius + 'm(700mとの差=' + (correctRadius - 700) + 'm)');

console.log('\n' + (failures === 0 ? '✅ すべて通過' : '❌ ' + failures + ' 件失敗') + '\n');
process.exit(failures === 0 ? 0 : 1);
