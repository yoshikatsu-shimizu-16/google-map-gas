/**
 * ===== 調査(マス)の結果を、答えが分かっているコールの省略に使う(Issue #39) =====
 *
 * `surveyAllCells`(Pro段)が既に「このマスは何件だったか」を調べているのに、
 * `crawlAllGrids`(Enterprise段)はそれを見ずに同じマスへもう一度コールしていた。
 *
 *   - 0件だったマス … 店が無いと分かっているので、コールせず完了扱いにする
 *   - 20件(飽和)だったマス … 親がいずれ4分割されると分かっているので、
 *     親のコールを省いていきなり子を生成する(子は次回実行で通常どおり収穫する)
 *   - 1〜19件だったマス … 営業データ(評価・HP等)はPro段には無いため、
 *     この情報だけでは省略できない。通常どおり1コールで収穫する
 *
 * 調査は「グリッド一覧」とは別のタイミングで行われているため、座標が一致するかを
 * 必ず確認してから適用する。生成範囲やステップが変わっていれば同じグリッドIDでも
 * 別の場所を指しうるほか、旧運用では保存半径が現行の計算値と食い違うケースが
 * 実際に確認されている(docs/survey-next-actions-2026-09-20.md 2-3)。半径ではなく
 * 中心座標で一致を確認するのは、座標は生成時に決め打ちで固定され、半径のような
 * 計算式の変遷による食い違いが起きないため。
 */

/** 中心座標が「同じマス」とみなせる誤差(度)。同一生成なら実質完全一致するはずの
 * 値に、浮動小数点の計算順序の違いを吸収する程度の余裕だけ持たせている。 */
const SURVEY_FINDINGS_COORD_TOLERANCE_DEG = 0.000001;

/**
 * 「調査(マス)」シートを読み、グリッドIDごとの調査結果を Map にする。
 *
 * エラー行(取得件数が空)は答えが分かっていないので含めない。同じグリッドIDが
 * 複数行ある場合は最後の行を使う(再調査で上書きされた想定)。
 *
 * @param {Sheet} surveyCellSheet - 「調査(マス)」シート
 * @returns {Map<number, {found: number, lat: number, lng: number}>}
 */
function readSurveyCellFindings(surveyCellSheet) {
  const findings = new Map();
  const lastRow = surveyCellSheet.getLastRow();
  if (lastRow < 2) return findings;

  const idIdx = AREA_SURVEY_CELL_HEADERS.indexOf('グリッドID');
  const latIdx = AREA_SURVEY_CELL_HEADERS.indexOf('中心緯度');
  const lngIdx = AREA_SURVEY_CELL_HEADERS.indexOf('中心経度');
  const foundIdx = AREA_SURVEY_CELL_HEADERS.indexOf('取得件数');

  surveyCellSheet.getRange(2, 1, lastRow - 1, AREA_SURVEY_CELL_HEADERS.length).getValues()
    .forEach(function(row) {
      const gridId = row[idIdx];
      const found = row[foundIdx];
      if (gridId === '' || gridId === null) return;
      if (found === '' || found === null) return; // エラー行(答えが分かっていない)
      findings.set(gridId, { found: found, lat: row[latIdx], lng: row[lngIdx] });
    });
  return findings;
}

/**
 * 「グリッド一覧」の未処理行に調査結果を適用し、答えが分かっているセルのAPIコールを省く。
 *
 * 対象は「処理状況」が `未処理` の行だけで、調査結果に一致するものだけを書き換える。
 * 一致の確認は座標(中心緯度・経度)で行い、同じグリッドIDでも座標がずれていれば
 * 「形状が違う行」として適用しない(docs/survey-next-actions-2026-09-20.md 2-3 の注意点)。
 *
 * gridValues は呼び出し側がこの後の走査でも使う配列なので、書き換えた行はその場で
 * 「処理状況」列を更新する(シートと呼び出し側の認識をその場で一致させるため)。
 *
 * @param {Sheet} gridSheet - 「グリッド一覧」シート
 * @param {Array[]} gridValues - 「グリッド一覧」の2行目以降の値(参照。書き込んだ行は
 *   その場でステータス列を更新する)
 * @param {Map<number, {found: number, lat: number, lng: number}>} surveyFindings -
 *   readSurveyCellFindings の戻り値
 * @param {number} nextGridId - 新規グリッドIDの採番開始値
 * @returns {{nextGridId: number, emptySkipped: number, saturatedSkipped: number,
 *   shapeMismatchSkipped: number}}
 */
function applySurveyFindingsToUnprocessedGrids(gridSheet, gridValues, surveyFindings, nextGridId) {
  let emptySkipped = 0;
  let saturatedSkipped = 0;
  let shapeMismatchSkipped = 0;

  for (let i = 0; i < gridValues.length; i++) {
    const row = gridValues[i];
    if (row[GRID_COL_STATUS - 1] !== '未処理') continue; // 既に手が付いた行は触らない

    const gridId = row[0];
    const finding = surveyFindings.get(gridId);
    if (!finding) continue;

    const lat = row[1];
    const lng = row[2];
    const sameCell =
      Math.abs(lat - finding.lat) <= SURVEY_FINDINGS_COORD_TOLERANCE_DEG &&
      Math.abs(lng - finding.lng) <= SURVEY_FINDINGS_COORD_TOLERANCE_DEG;
    if (!sameCell) {
      // 同じグリッドIDでも指している場所が違う = 生成条件が変わった可能性がある。
      // 参考情報として扱い、答えを流用しない(通常どおり実際に検索して確かめる)。
      shapeMismatchSkipped++;
      continue;
    }

    if (finding.found === 0) {
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue(GRID_STATUS_EMPTY);
      row[GRID_COL_STATUS - 1] = GRID_STATUS_EMPTY;
      emptySkipped++;
      continue;
    }

    if (finding.found >= MAX_RESULT_COUNT) {
      const tier = row[5] || 0;
      const cellSizeDeg = row[7] || GRID_STEP;
      let nextStatus;
      if (tier < MAX_TIER) {
        nextGridId = spawnChildGrids(gridSheet, gridId, lat, lng, cellSizeDeg, tier, nextGridId);
        nextStatus = '密集(分割済み)';
      } else {
        // これ以上の自動細分化は行わず、crawlAllGrids の通常経路と同じく人間の確認に委ねる
        nextStatus = '要確認(上限到達)';
      }
      gridSheet.getRange(i + 2, GRID_COL_STATUS).setValue(nextStatus);
      row[GRID_COL_STATUS - 1] = nextStatus;
      saturatedSkipped++;
      continue;
    }

    // 1〜19件は「店があること」しか分からず、評価・HPなどの営業データはPro段の調査には
    // 無いため、この情報だけでは省略できない。通常どおり1コールで収穫させる。
  }

  return {
    nextGridId: nextGridId,
    emptySkipped: emptySkipped,
    saturatedSkipped: saturatedSkipped,
    shapeMismatchSkipped: shapeMismatchSkipped
  };
}
