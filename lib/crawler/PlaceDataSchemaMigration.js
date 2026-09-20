/**
 * ===== 「全飲食店データ」シートのスキーマと後方互換移行 =====
 *
 * 出力列を変更しても既に取得済みの店舗データを捨てずに済むようにするための自己マイグレーション。
 * 再クロールには Enterprise SKU の無料枠(1,000コール/月)を1.5ヶ月ぶん使うため、列構成を
 * 変えるたびに取り直すという選択肢は現実的ではない。crawlAllGrids の冒頭で毎回呼ばれ、
 * 何度実行しても結果が変わらない(冪等)。
 *
 * lib/grid/GridSchemaMigration.js が getLastColumn() を暗黙のバージョン番号として使っているのに対し、
 * こちらは「ヘッダー名の一致」で判定する。列の削除と並べ替えを伴うため列数では区別できないうえ、
 * 名前で突き合わせれば「旧スキーマに同名列があれば引き継ぐ」という移行規則を1つ書くだけで済む。
 *
 * スキーマの変遷:
 *   20列 … 店名 / 主タイプ / 住所 / 電話番号 / HP有無 / HP URL / Google Maps URL / 評価 / 評価件数 /
 *          営業状況 / 通常営業時間 / 価格帯 / テイクアウト / デリバリー / 店内飲食 / 予約可 /
 *          子連れ向き / ペット可 / 説明文(Editorial) / Place ID
 *   17列 … Atmosphere 系7列と HP有無 を削除し、全タイプ / 緯度 / 経度 / HP種別 / HPドメイン を追加
 *          (HP有無 は HP種別 の「なし」に統合。同じ概念を2列で持たない)
 */

/**
 * ヘッダー行が最新スキーマかを判定する。末尾の空セルは無視する。
 *
 * @param {Array} headerRow
 * @returns {boolean}
 */
function isCurrentPlaceDataSchema(headerRow) {
  const names = headerRow.map(function(value) {
    return (value === null || value === undefined) ? '' : String(value).trim();
  });
  while (names.length > 0 && names[names.length - 1] === '') names.pop();
  if (names.length !== PLACE_DATA_HEADERS.length) return false;
  return names.every(function(name, index) { return name === PLACE_DATA_HEADERS[index]; });
}

/**
 * 「全飲食店データ」シートを最新スキーマへ移行する。
 * 旧スキーマに同名の列があれば値をそのまま引き継ぎ、HP種別 / HPドメイン は旧「HP URL」列から
 * 再計算する。緯度 / 経度 / 全タイプ は旧スキーマに存在しないため既存行では空のままになり、
 * 以後に取得される新規行だけが埋まる。
 *
 * @param {Sheet} dataSheet - 「全飲食店データ」シートオブジェクト
 * @returns {void}
 */
function ensurePlaceDataSchemaMigrated(dataSheet) {
  const lastRow = dataSheet.getLastRow();
  const lastCol = dataSheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return; // ヘッダーすら無い

  const headerRow = dataSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (isCurrentPlaceDataSchema(headerRow)) return; // 既に最新スキーマ

  // 旧ヘッダー名 → 列index(0始まり)。同名が複数あれば左を優先する。
  const columnIndexByName = {};
  headerRow.forEach(function(value, index) {
    const name = (value === null || value === undefined) ? '' : String(value).trim();
    if (name && !(name in columnIndexByName)) columnIndexByName[name] = index;
  });
  const websiteUrlIndex = columnIndexByName[PLACE_HEADER_WEBSITE_URL];

  const dataRowCount = Math.max(lastRow - 1, 0);
  const oldRows = dataRowCount > 0
    ? dataSheet.getRange(2, 1, dataRowCount, lastCol).getValues()
    : [];

  const migratedRows = oldRows.map(function(row) {
    const website = classifyWebsite(websiteUrlIndex === undefined ? '' : row[websiteUrlIndex]);
    return PLACE_DATA_HEADERS.map(function(name) {
      if (name === PLACE_HEADER_WEBSITE_CATEGORY) return website.category;
      if (name === PLACE_HEADER_WEBSITE_DOMAIN) return website.domain;
      const index = columnIndexByName[name];
      return index === undefined ? '' : row[index];
    });
  });

  // 列数が減るため、古い値が右端に残らないよう一度まっさらにしてから書き戻す。
  // フィルタは旧い列範囲を掴んだままなので先に外す。
  const existingFilter = dataSheet.getFilter();
  if (existingFilter) existingFilter.remove();
  dataSheet.clearContents();

  dataSheet.getRange(1, 1, 1, PLACE_DATA_HEADERS.length).setValues([PLACE_DATA_HEADERS]);
  if (migratedRows.length > 0) {
    dataSheet.getRange(2, 1, migratedRows.length, PLACE_DATA_HEADERS.length).setValues(migratedRows);
  }

  // 外したフィルタはここで張り直す。crawlAllGrids の末尾にも同じ呼び出しがあるが、
  // 未処理グリッドが残っていない実行はその手前で早期リターンするため末尾に到達しない。
  // 移行は冪等で次回以降はスキップされるので、ここで戻さないとフィルタが永久に消える。
  // 範囲の決め方は lib/crawler/PlaceDataSheetFilter.js に集約しており、この移行で
  // 列数が変わった直後は必ず張り直しになる(旧列の条件は原理的に移せない)。
  ensurePlaceDataFilter(dataSheet);

  Logger.log(
    '全飲食店データシートを ' + lastCol + '列 → ' + PLACE_DATA_HEADERS.length +
    '列のスキーマへ移行しました(' + migratedRows.length + '行を保持、HP種別/HPドメインは再計算)。'
  );
}
