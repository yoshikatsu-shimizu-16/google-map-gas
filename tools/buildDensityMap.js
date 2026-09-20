/**
 * ===== セルごとの飲食店密度を、Googleを1コールも使わずに見積もる(ローカル実行) =====
 *
 *   node tools/buildDensityMap.js            キャッシュがあれば使う
 *   node tools/buildDensityMap.js --refresh  Overpass から取り直す
 *
 * 現在の探索は「探してみて20件出たら割る」という事後対応で、その判定のたびに
 * Google のコールを払っている(2026-09-20 の実測では全コールの50%がこの再分割)。
 * 先に密度が分かっていればセルサイズを事前に決められるので、その入力を作る。
 *
 * セルの切り方・採番は entrypoints/generateGridList.js と完全に一致させる必要がある
 * (ここで出した番号をそのまま「グリッド一覧」の行に対応付けるため)。そのため
 * 範囲と刻み幅は定数を書き写さず lib/grid/TargetArea.js から読み込む。
 *
 * 注意: OSM の網羅性は Google に劣る。件数そのものではなく「0件か」「密集か」の
 * 判定に使う。また、ここで数えるのはセル矩形の中のPOIだが、実際の検索は矩形を覆う
 * 円(半径717m)で行うため、円は隣のセルにはみ出す。0件セルでも隣の店が返ることがある。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetchOsmFoodPoisViaCurl } = require('./fetchOsmFoodPois');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * グリッドの定義を GAS のソースからそのまま読み込む。
 * 範囲・刻み幅・半径の算出をローカル側で二重管理しないため。
 *
 * @returns {{TARGET_AREA_BOUNDS: Object, GRID_STEP: number, cellCoverRadiusMeters: Function}}
 */
function loadGridDefinition() {
  const source = ['lib/grid/TargetArea.js', 'lib/grid/GridGeometry.js', 'lib/survey/CellDensityIndex.js']
    .map(function(f) { return fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'); })
    .join('\n');
  return new Function(source + `
    return {
      TARGET_AREA_BOUNDS: TARGET_AREA_BOUNDS,
      GRID_STEP: GRID_STEP,
      cellCoverRadiusMeters: cellCoverRadiusMeters,
      countPoisByCell: countPoisByCell,
      countPoisWithinRadius: countPoisWithinRadius
    };
  `)();
}

/**
 * 階層0のセル一覧を生成する。採番は generateGridList と同じ
 * (行優先・1始まり。gridId = 行index × 列数 + 列index + 1)。
 *
 * @param {Object} bounds
 * @param {number} step
 * @param {Function} radiusOf
 * @returns {{cells: Array<Object>, latSteps: number, lngSteps: number}}
 */
function buildCells(bounds, step, radiusOf) {
  const latSteps = Math.round((bounds.latMax - bounds.latMin) / step);
  const lngSteps = Math.round((bounds.lngMax - bounds.lngMin) / step);

  const cells = [];
  for (let i = 0; i < latSteps; i++) {
    for (let j = 0; j < lngSteps; j++) {
      const centerLat = bounds.latMin + i * step + step / 2;
      const centerLng = bounds.lngMin + j * step + step / 2;
      cells.push({
        gridId: i * lngSteps + j + 1,
        row: i,
        col: j,
        centerLat: centerLat,
        centerLng: centerLng,
        radius: radiusOf(step, centerLat),
        osmCount: 0
      });
    }
  }
  return { cells: cells, latSteps: latSteps, lngSteps: lngSteps };
}

/**
 * 共有の countPoisByCell(「行_列」→件数)の結果を各セルに書き戻す。
 *
 * @param {Array<Object>} cells
 * @param {Object<string, number>} countByCell
 * @returns {number} 割り当てられた POI 数(bbox の外縁ぶんは入らない)
 */
function applyCounts(cells, countByCell) {
  let assigned = 0;
  cells.forEach(function(c) {
    c.osmCount = countByCell[c.row + '_' + c.col] || 0;
    assigned += c.osmCount;
  });
  return assigned;
}

/**
 * 件数の分布を、探索コストの観点で意味のある区切りで集計する。
 * 20件が Nearby Search の1コールの上限なので、そこを境にコストが変わる。
 *
 * @param {Array<Object>} cells
 * @returns {Array<{label: string, cells: number, pois: number}>}
 */
function summarizeDistribution(cells) {
  const buckets = [
    { label: '0件(探索不要の可能性)', test: function(n) { return n === 0; } },
    { label: '1〜4件', test: function(n) { return n >= 1 && n <= 4; } },
    { label: '5〜19件(1コールで収まる)', test: function(n) { return n >= 5 && n <= 19; } },
    { label: '20〜49件(要分割)', test: function(n) { return n >= 20 && n <= 49; } },
    { label: '50件以上(要細分化)', test: function(n) { return n >= 50; } }
  ];
  return buckets.map(function(b) {
    const matched = cells.filter(function(c) { return b.test(c.osmCount); });
    return {
      label: b.label,
      cells: matched.length,
      pois: matched.reduce(function(sum, c) { return sum + c.osmCount; }, 0)
    };
  });
}

/** 数値を右詰めする(表の桁を揃えるため)。 */
function pad(value, width) {
  return String(value).padStart(width);
}

/** Nearby Search が1コールで返す上限。これを超えると必ず分割が要る。 */
const MAX_RESULTS_PER_CALL = 20;

/**
 * 密度が事前に分かっている場合の、そのセルに必要なコール数を見積もる。
 *
 * 20件に収まるまで四分木で割り、各子セルを1コールずつで済ませる前提
 * (= 傘型1コールで全タイプを covered できる、という仮説が成立した場合)。
 * 仮説が崩れた場合はここに「1セルあたりのタイプ分割数」を掛ける必要がある。
 *
 * @param {number} count - 想定される店舗数
 * @returns {number} コール数
 */
function estimateDensityDrivenCalls(count) {
  if (count === 0) return 0; // 事前に除外できる
  let cellsNeeded = 1;
  while (count / cellsNeeded >= MAX_RESULTS_PER_CALL) cellsNeeded *= 4;
  return cellsNeeded;
}

function main() {
  const refresh = process.argv.indexOf('--refresh') !== -1;
  const { TARGET_AREA_BOUNDS, GRID_STEP, cellCoverRadiusMeters,
          countPoisByCell, countPoisWithinRadius } = loadGridDefinition();

  console.log('\n===== セル別 飲食店密度の見積もり(OpenStreetMap / APIコール0) =====');
  console.log('対象範囲: 北緯 ' + TARGET_AREA_BOUNDS.latMin + '〜' + TARGET_AREA_BOUNDS.latMax +
    ' / 東経 ' + TARGET_AREA_BOUNDS.lngMin + '〜' + TARGET_AREA_BOUNDS.lngMax);

  const { pois, fromCache, timestamp } = fetchOsmFoodPoisViaCurl(TARGET_AREA_BOUNDS, { refresh: refresh });
  console.log('OSM POI: ' + pois.length + '件' +
    (fromCache ? '(キャッシュ)' : '(Overpass から取得)') + ' / OSMデータ時点: ' + timestamp);

  const { cells, latSteps, lngSteps } = buildCells(TARGET_AREA_BOUNDS, GRID_STEP, cellCoverRadiusMeters);
  const assigned = applyCounts(cells, countPoisByCell(pois, TARGET_AREA_BOUNDS, GRID_STEP));
  console.log('セル: ' + latSteps + '行 × ' + lngSteps + '列 = ' + cells.length + 'マス' +
    ' / 割り当て済みPOI: ' + assigned + '件\n');

  console.log('--- 件数の分布 ---');
  const distribution = summarizeDistribution(cells);
  distribution.forEach(function(b) {
    const share = (b.cells / cells.length * 100).toFixed(1);
    console.log('  ' + b.label.padEnd(26) + pad(b.cells, 4) + 'マス (' + pad(share, 5) + '%)  POI ' + pad(b.pois, 5) + '件');
  });

  const empty = distribution[0].cells;
  console.log('\n--- 探索コストへの含意 ---');
  console.log('  0件のマスが ' + empty + '/' + cells.length + ' (' + (empty / cells.length * 100).toFixed(1) + '%)。');
  console.log('  ここを事前に除外できれば、その分のコールがまるごと不要になる。');

  const dense = cells.filter(function(c) { return c.osmCount >= 20; });
  console.log('  20件以上のマスは ' + dense.length + '。ここだけ事前に細かく割れば、');
  console.log('  「20件出てから割り直す」ための探りコールが不要になる。');

  // 実際の検索は矩形ではなく「矩形を覆う円」で行い、円は隣にはみ出す。セルを飛ばして
  // よいかの判定はこちらでないと誤る(矩形が空でも、隣の店が円に入れば結果は返る)。
  const emptyInCircle = cells.filter(function(c) {
    return countPoisWithinRadius(pois, c.centerLat, c.centerLng, c.radius) === 0;
  });
  console.log('  ただし検索範囲は半径' + cells[0].radius + 'mの円で、隣にはみ出す。');
  console.log('  円の中まで見て0件なのは ' + emptyInCircle.length + 'マス' +
    '(矩形基準の ' + empty + 'マスより少ない)。');
  console.log('  entrypoints/surveyEmptyCells.js が Pro枠で実地確認するのはこの ' +
    emptyInCircle.length + 'マス。');

  // --- コスト試算 ---
  // 現行の実績値。2026-09-20 の実行ログ(15マス着手 / 103コール)から。
  // ベース51 + タイプ分割52 で、1マスあたり 6.9 コール。
  const MEASURED_CALLS_PER_CELL = 103 / 15;
  const currentTotal = Math.round(cells.length * MEASURED_CALLS_PER_CELL);
  const densityDrivenTotal = cells.reduce(function(sum, c) {
    return sum + estimateDensityDrivenCalls(c.osmCount);
  }, 0);

  console.log('\n--- コール数の試算(Enterprise枠 1,000/月 に対して) ---');
  console.log('  現行(実測 6.9コール/マス × ' + cells.length + 'マス): ' + pad(currentTotal, 5) + ' コール' +
    '  → 完走まで約 ' + (currentTotal / 1000).toFixed(1) + ' ヶ月');
  console.log('  密度駆動(0件は除外、20件に収まるまで事前分割): ' + pad(densityDrivenTotal, 5) + ' コール' +
    '  → 完走まで約 ' + (densityDrivenTotal / 1000).toFixed(1) + ' ヶ月');
  console.log('  削減率: ' + (100 - densityDrivenTotal / currentTotal * 100).toFixed(0) + '%');
  console.log('  ※ 密度駆動の試算は「傘型1コールで全タイプを覆える」という仮説の上に立つ。');
  console.log('     仮説が崩れた場合、1セルあたりのコール数を掛け直す必要がある(Phase 1 で検証)。');

  console.log('\n--- 密集している上位15マス ---');
  cells.slice().sort(function(a, b) { return b.osmCount - a.osmCount; }).slice(0, 15)
    .forEach(function(c) {
      console.log('  グリッド' + pad(c.gridId, 4) + ': ' + pad(c.osmCount, 4) + '件  ' +
        c.centerLat.toFixed(4) + ',' + c.centerLng.toFixed(4) +
        '  https://www.google.com/maps?q=' + c.centerLat.toFixed(5) + ',' + c.centerLng.toFixed(5));
    });

  const outFile = path.join(os.tmpdir(), 'density-map.csv');
  const header = 'グリッドID,中心緯度,中心経度,半径m,OSM件数\n';
  const body = cells.map(function(c) {
    return [c.gridId, c.centerLat.toFixed(6), c.centerLng.toFixed(6), c.radius, c.osmCount].join(',');
  }).join('\n');
  fs.writeFileSync(outFile, header + body + '\n');
  console.log('\nセル別の一覧を書き出しました: ' + outFile);
}

try {
  main();
} catch (err) {
  console.error('\n失敗しました: ' + err.message);
  process.exit(1);
}
