/**
 * ===== 「全飲食店データ」シートのフィルタ管理(単一の真実源) =====
 *
 * 旧実装は crawlAllGrids の末尾で毎回 remove() → createFilter() していた。createFilter()
 * は条件なしのフィルタを張るため、運用者が設定したフィルタ条件(HP種別=なし / 評価>=3.8 等)
 * が日次トリガーのたびに消えていた。クロールが全域を巡り終えるまで数ヶ月かかるため、
 * 「毎朝フィルタを設定し直す」運用コストがその間ずっと発生する状態だった。
 *
 * ----- 方針: フィルタ範囲を「シートの全行 × スキーマの列数」に固定する -----
 * 範囲を getLastRow() ではなく getMaxRows() で張ると、行が増えても意図する範囲が
 * 変わらない。範囲が一致している限り張り直さない = 運用者の条件がそのまま残る。
 *
 * 張り直しが必要になるのは次の2つだけ:
 *   1. フィルタが存在しない(初回、または運用者が手で外した)
 *   2. 範囲が意図と違う(スキーマ移行で列数が変わった / 行容量を増やした)
 *
 * 2 のうち行容量の拡張は PlaceRowWriter が数百〜千行単位でまとめて行うため(同ファイルの
 * PLACE_DATA_ROW_CAPACITY_CHUNK を参照)、条件が失われるのは「数百件の新規店舗を集めて
 * 容量を使い切ったとき」に限られる。毎日必ず消える旧実装とは頻度の桁が違う。
 *
 * フィルタ操作をこのファイルに集約しているのは、以前は crawlAllGrids の末尾と
 * PlaceDataSchemaMigration の2箇所に別々の再作成ロジックがあり、どちらが最終的な
 * 範囲を決めるのかがコードから読み取れなかったため。
 */

/**
 * 「全飲食店データ」シートに意図どおりのフィルタが張られている状態を保証する。
 * 既に一致していれば何もしない(運用者が設定したフィルタ条件を壊さない)。
 *
 * @param {Sheet} dataSheet - 「全飲食店データ」シート
 * @returns {boolean} 張り直した場合 true、条件を保ったまま触らなかった場合 false
 */
function ensurePlaceDataFilter(dataSheet) {
  const intendedNumRows = dataSheet.getMaxRows();
  const intendedNumCols = PLACE_DATA_HEADERS.length;

  const existingFilter = dataSheet.getFilter();
  if (existingFilter) {
    const range = existingFilter.getRange();
    const matches = range.getRow() === 1 &&
      range.getColumn() === 1 &&
      range.getNumRows() === intendedNumRows &&
      range.getNumColumns() === intendedNumCols;
    if (matches) return false; // 条件を保つため、あえて触らない
    existingFilter.remove();
  }

  dataSheet.getRange(1, 1, intendedNumRows, intendedNumCols).createFilter();
  return true;
}
