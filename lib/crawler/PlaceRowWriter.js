/**
 * ===== 「全飲食店データ」シートへの書き込み =====
 *
 * 旧実装は1店舗ごとに appendRow を呼んでおり、Spreadsheet API のラウンドトリップが
 * 店舗数ぶん発生していた。1グリッドで最大80件近く書き込むこともあり、これが GAS の
 * 実行時間(6分)を圧迫して1回の実行で進めるグリッド数を減らす主因になっていた。
 * ここでは行をメモリ上に溜め、グリッド単位で setValues による一括書き込みを行う。
 */

const PLACE_DATA_HEADERS = [
  '店名', '主タイプ', '住所',
  '電話番号(国内)', 'HP有無', 'HP URL', 'Google Maps URL',
  '評価', '評価件数',
  // 'レビュー抜粋(1件目)', // Demoキーでは取得不可のため無効化
  '営業状況', '通常営業時間', '価格帯',
  'テイクアウト', 'デリバリー', '店内飲食', '予約可',
  '子連れ向き', 'ペット可', '説明文(Editorial)',
  // '写真枚数', // Demoキーでは取得不可のため無効化
  'Place ID'
];

/** Place ID が入る列番号(1始まり)。重複除去のために既存値を読み出すのに使う。 */
const PLACE_ID_COLUMN = PLACE_DATA_HEADERS.length;

/**
 * Place オブジェクト1件をシートの1行に変換する。
 * @param {Object} place
 * @returns {Array} PLACE_DATA_HEADERS と同じ並びの1行
 */
function toPlaceRow(place) {
  const openingHoursText = place.regularOpeningHours && place.regularOpeningHours.weekdayDescriptions
    ? place.regularOpeningHours.weekdayDescriptions.join(' / ')
    : '';

  return [
    place.displayName ? place.displayName.text : '',
    place.primaryTypeDisplayName ? place.primaryTypeDisplayName.text : (place.primaryType || ''),
    place.formattedAddress || '',
    place.nationalPhoneNumber || '',
    place.websiteUri ? 'あり' : 'なし',
    place.websiteUri || '',
    place.googleMapsUri || '',
    place.rating || '',
    place.userRatingCount || '',
    place.businessStatus || '',
    openingHoursText,
    place.priceLevel || '',
    place.takeout === true ? '○' : (place.takeout === false ? '×' : ''),
    place.delivery === true ? '○' : (place.delivery === false ? '×' : ''),
    place.dineIn === true ? '○' : (place.dineIn === false ? '×' : ''),
    place.reservable === true ? '○' : (place.reservable === false ? '×' : ''),
    place.goodForChildren === true ? '○' : '',
    place.allowsDogs === true ? '○' : '',
    place.editorialSummary ? place.editorialSummary.text : '',
    place.id || ''
  ];
}

/**
 * 書き込みをバッファリングするライターを生成する。
 * Place ID をキーに重複を除去するため、隣接グリッドやタイプ分割での重複ヒットは
 * add した時点で弾かれ、シートには書き込まれない。
 *
 * @param {Sheet} dataSheet
 * @param {Set<string>} existingIds - 既にシートに存在する Place ID
 * @returns {{add: function(Object): boolean, flush: function(): void, writtenCount: function(): number}}
 */
function createPlaceRowWriter(dataSheet, existingIds) {
  const buffer = [];
  let written = 0;

  return {
    /** @returns {boolean} 新規として受け付けた場合 true */
    add: function(place) {
      if (!place.id || existingIds.has(place.id)) return false;
      existingIds.add(place.id);
      buffer.push(toPlaceRow(place));
      return true;
    },

    /** 溜まった行を1回の setValues でまとめて書き出す。 */
    flush: function() {
      if (buffer.length === 0) return;
      const startRow = dataSheet.getLastRow() + 1;
      dataSheet.getRange(startRow, 1, buffer.length, PLACE_DATA_HEADERS.length).setValues(buffer);
      written += buffer.length;
      buffer.length = 0;
    },

    writtenCount: function() { return written; }
  };
}
