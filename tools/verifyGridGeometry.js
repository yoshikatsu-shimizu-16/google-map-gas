/**
 * グリッド幾何の検証スクリプト(ローカル実行用、APIコールなし)。
 *
 *   node tools/verifyGridGeometry.js
 *
 * lib/grid/GridGeometry.js は SpreadsheetApp に依存しない純関数だけで構成されているため、
 * GAS にデプロイせずここで検証できる。子グリッド分割の被覆漏れはモンテカルロ法で確認する。
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
// GAS は全ファイルを単一のグローバルスコープに結合するため、ここでも同じ形で読み込む
const sources = ['lib/grid/GridGeometry.js', 'lib/grid/TargetArea.js']
  .map(function(f) { return fs.readFileSync(path.join(repoRoot, f), 'utf8'); })
  .join('\n');

// GAS のグローバルスコープ結合を再現し、検証に使う識別子だけを取り出す
const {
  METERS_PER_DEGREE_LAT, cellCoverRadiusMeters, cellSizeDegFromCoverRadius,
  GRID_STEP, TARGET_AREA_BOUNDS
} = new Function(sources + '\nreturn { METERS_PER_DEGREE_LAT, cellCoverRadiusMeters,' +
  ' cellSizeDegFromCoverRadius, GRID_STEP, TARGET_AREA_BOUNDS };')();

const SAMPLES = 300000;
const REF_LAT = 35.855; // 対象エリアの中心緯度
let failures = 0;

function check(label, ok, detail) {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  -- ' + detail : ''));
  if (!ok) failures++;
}

/** セル矩形内に一様に点を打ち、いずれの子円にも入らない点の割合を返す。 */
function uncoveredFractionInCell(cellSizeDeg, centerLat, children) {
  const halfLat = METERS_PER_DEGREE_LAT * cellSizeDeg / 2;
  const halfLng = METERS_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180) * cellSizeDeg / 2;
  let miss = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const x = (Math.random() * 2 - 1) * halfLng; // 東方向(m)
    const y = (Math.random() * 2 - 1) * halfLat; // 北方向(m)
    const covered = children.some(function(c) {
      return Math.hypot(x - c.x, y - c.y) <= c.r;
    });
    if (!covered) miss++;
  }
  return miss / SAMPLES;
}

/** 半径Rの親円内に一様に点を打ち、いずれの子円にも入らない点の割合を返す。 */
function uncoveredFractionInDisk(R, children) {
  let miss = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const th = Math.random() * 2 * Math.PI;
    const rr = R * Math.sqrt(Math.random());
    const x = rr * Math.cos(th), y = rr * Math.sin(th);
    const covered = children.some(function(c) { return Math.hypot(x - c.x, y - c.y) <= c.r; });
    if (!covered) miss++;
  }
  return miss / SAMPLES;
}

console.log('\n[1] 検索半径の導出');
const r0 = cellCoverRadiusMeters(GRID_STEP, REF_LAT);
check('階層0 (0.01度) の半径が717m(半対角716.5mを切り上げ)', r0 === 717, 'r=' + r0);
const tierRadii = [0, 1, 2, 3].map(function(t) {
  return cellCoverRadiusMeters(GRID_STEP / Math.pow(2, t), REF_LAT);
});
check('階層0→3 で半径が概ね半分ずつになる', tierRadii.join(',') === '717,359,180,90', tierRadii.join(' -> ') + ' m');

console.log('\n[2] 半径 → セルサイズ の逆算(旧スキーマ移行で使用)');
[GRID_STEP, GRID_STEP / 2, GRID_STEP / 4].forEach(function(size) {
  const back = cellSizeDegFromCoverRadius(cellCoverRadiusMeters(size, REF_LAT), REF_LAT);
  check('セルサイズ ' + size + ' 度が誤差0.5%以内で復元できる',
    Math.abs(back - size) / size < 0.005, '復元値=' + back.toFixed(6));
});

console.log('\n[3] 四分木分割の被覆(新実装)');
const childSize = GRID_STEP / 2;
const offLat = METERS_PER_DEGREE_LAT * (childSize / 2);
const offLng = METERS_PER_DEGREE_LAT * Math.cos(REF_LAT * Math.PI / 180) * (childSize / 2);
const childR = cellCoverRadiusMeters(childSize, REF_LAT);
const quadChildren = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(function(q) {
  return { y: q[0] * offLat, x: q[1] * offLng, r: childR };
});
console.log('       子中心オフセット: 緯度±' + offLat.toFixed(1) + 'm / 経度±' + offLng.toFixed(1) + 'm, 子半径 ' + childR + 'm');
const quadMiss = uncoveredFractionInCell(GRID_STEP, REF_LAT, quadChildren);
check('親セル矩形が完全に被覆される', quadMiss === 0, '未被覆 ' + (100 * quadMiss).toFixed(4) + '%');

console.log('\n[4] 旧実装の被覆漏れ(リグレッション検知用の対照)');
const oldR = 700, oldChildR = Math.round(oldR * 0.6), oldOff = oldR / 2;
const oldChildren = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(function(q) {
  return { y: q[0] * oldOff, x: q[1] * oldOff, r: oldChildR };
});
const oldMissDisk = uncoveredFractionInDisk(oldR, oldChildren);
const centerHole = Math.hypot(oldOff, oldOff) - oldChildR;
check('旧実装は親円に被覆漏れがある(これが修正対象)', oldMissDisk > 0.03,
  '未被覆 ' + (100 * oldMissDisk).toFixed(2) + '% / 中心の穴 半径' + centerHole.toFixed(1) + 'm');

console.log('\n[5] 階層0のグリッド数');
const latSteps = Math.round((TARGET_AREA_BOUNDS.latMax - TARGET_AREA_BOUNDS.latMin) / GRID_STEP);
const lngSteps = Math.round((TARGET_AREA_BOUNDS.lngMax - TARGET_AREA_BOUNDS.lngMin) / GRID_STEP);
check('17行 × 22列 = 374セル', latSteps * lngSteps === 374, latSteps + '行 x ' + lngSteps + '列 = ' + (latSteps * lngSteps));

console.log('\n' + (failures === 0 ? '✅ すべて通過' : '❌ ' + failures + ' 件失敗') + '\n');
process.exit(failures === 0 ? 0 : 1);
