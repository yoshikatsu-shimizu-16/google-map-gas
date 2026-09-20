/**
 * ===== 「OSMが飲食店0件と見たセル」の一覧を GAS 用のソースとして書き出す =====
 *
 *   node tools/generateEmptyCellPrediction.js
 *
 * Apps Script の UrlFetchApp からは overpass-api.de へ到達できない
 * ("Address unavailable"。共用サーバーがデータセンターからのアクセスを弾いていると思われる)。
 * そこで OSM の取得と判定はローカルで済ませ、結果だけを lib/survey/EmptyCellPrediction.js
 * というソースにして clasp push で持ち込む。GAS は実行時にネットワークへ出ない。
 *
 * 判定は「セル矩形」ではなく「実際の検索円」で行う。searchNearby は矩形を覆う円で探すため、
 * 矩形が空でも隣の店が円に入れば結果が返る。矩形基準で判定すると飛ばしすぎる。
 */
const fs = require('fs');
const path = require('path');
const { fetchOsmFoodPoisViaCurl } = require('./fetchOsmFoodPois');
const { loadGridDefinition, buildCells } = require('./buildDensityMap');

const OUT_FILE = path.join(__dirname, '..', 'lib', 'survey', 'EmptyCellPrediction.js');

function main() {
  const refresh = process.argv.indexOf('--refresh') !== -1;
  const { TARGET_AREA_BOUNDS, GRID_STEP, cellCoverRadiusMeters, countPoisWithinRadius } = loadGridDefinition();

  const { pois, timestamp } = fetchOsmFoodPoisViaCurl(TARGET_AREA_BOUNDS, { refresh: refresh });
  const { cells } = buildCells(TARGET_AREA_BOUNDS, GRID_STEP, cellCoverRadiusMeters);

  const emptyCells = cells.filter(function(c) {
    return countPoisWithinRadius(pois, c.centerLat, c.centerLng, c.radius) === 0;
  });
  const gridIds = emptyCells.map(function(c) { return c.gridId; });

  fs.writeFileSync(OUT_FILE, renderSource({
    gridIds: gridIds,
    totalCells: cells.length,
    poiCount: pois.length,
    osmTimestamp: timestamp,
    bounds: TARGET_AREA_BOUNDS,
    step: GRID_STEP,
    radius: cells[0].radius
  }));

  console.log('書き出しました: ' + path.relative(path.join(__dirname, '..'), OUT_FILE));
  console.log('  対象セル ' + cells.length + ' のうち、検索円の中にOSMのPOIが0件なのは ' +
    gridIds.length + ' セル (' + (gridIds.length / cells.length * 100).toFixed(1) + '%)');
  console.log('  OSMデータ時点: ' + osmTimestampLabel(timestamp));
  console.log('\n次: clasp push で GAS に反映し、surveyEmptyCells で実地確認する');
}

/** ISO8601 をそのまま出す(将来フォーマットを変えたくなったときの差し替え点)。 */
function osmTimestampLabel(timestamp) {
  return timestamp;
}

/**
 * 生成するソースの中身を組み立てる。
 * 手で編集されないよう、由来と再生成コマンドを先頭に書く。
 *
 * @param {{gridIds: number[], totalCells: number, poiCount: number, osmTimestamp: string,
 *   bounds: Object, step: number, radius: number}} data
 * @returns {string}
 */
function renderSource(data) {
  const perLine = 12;
  const lines = [];
  for (let i = 0; i < data.gridIds.length; i += perLine) {
    lines.push('  ' + data.gridIds.slice(i, i + perLine).join(', ') + ',');
  }
  if (lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');

  return `/**
 * ===== OSMが「飲食店0件」と見たグリッドID(自動生成。手で編集しない) =====
 *
 * 再生成: node tools/generateEmptyCellPrediction.js
 *
 * このファイルだけが GAS にデプロイされる。OSM の取得と判定はローカルで行う
 * (Apps Script の UrlFetchApp からは overpass-api.de へ到達できないため)。
 *
 * ----- 生成時の条件 -----
 *   OSMデータ時点 : ${data.osmTimestamp}
 *   対象範囲      : 北緯 ${data.bounds.latMin}〜${data.bounds.latMax} / 東経 ${data.bounds.lngMin}〜${data.bounds.lngMax}
 *   セルサイズ    : ${data.step} 度 (検索円の半径 ${data.radius}m)
 *   OSM POI 総数  : ${data.poiCount} 件
 *   判定          : 検索円の中に飲食系POIが1件も無いセル
 *   結果          : ${data.totalCells} セル中 ${data.gridIds.length} セル (${(data.gridIds.length / data.totalCells * 100).toFixed(1)}%)
 *
 * グリッドIDは entrypoints/generateGridList.js の採番(行優先・1始まり)に対応する。
 * 対象範囲かセルサイズを変えたら採番がずれるため、下の定数で照合している
 * (entrypoints/surveyEmptyCells.js が不一致を検知して中断する)。
 *
 * OSM の網羅性は Google に劣るので、この一覧だけを根拠にセルを除外してはいけない。
 * surveyEmptyCells で1セル1コールずつ裏を取ってから判断すること。
 */

/** 生成時の対象範囲とセルサイズ。現在の設定と食い違っていればグリッドIDが無意味になる。 */
const EMPTY_CELL_PREDICTION_BOUNDS = { latMin: ${data.bounds.latMin}, latMax: ${data.bounds.latMax}, lngMin: ${data.bounds.lngMin}, lngMax: ${data.bounds.lngMax} };
const EMPTY_CELL_PREDICTION_STEP = ${data.step};

const OSM_EMPTY_GRID_IDS = [
${lines.join('\n')}
];
`;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\n失敗しました: ' + err.message);
    process.exit(1);
  }
}
