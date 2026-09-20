/**
 * ===== 「全飲食店データ」シートへの書き込み =====
 *
 * 旧実装は1店舗ごとに appendRow を呼んでおり、Spreadsheet API のラウンドトリップが
 * 店舗数ぶん発生していた。1グリッドで最大80件近く書き込むこともあり、これが GAS の
 * 実行時間(6分)を圧迫して1回の実行で進めるグリッド数を減らす主因になっていた。
 * ここでは行をメモリ上に溜め、グリッド単位で setValues による一括書き込みを行う。
 *
 * 列構成は「評価が高いのに HP を持たない店を見つけて営業をかける」という用途から
 * 逆算している。詳しい経緯は lib/api/PlaceSearchFieldMask.js のコメントを参照。
 */

/**
 * place.types をそのまま並べた列。プローブ集合の被覆監査
 * (entrypoints/auditPlaceTypeSetCoverage.js)がこの列だけを母集団として読むため、
 * 列名をリテラルで散在させず名前で参照できるようにしている。
 */
const PLACE_HEADER_ALL_TYPES = '全タイプ';

/** 派生列(API のフィールドに直接対応しない列)。移行処理からも名前で参照する。 */
const PLACE_HEADER_WEBSITE_CATEGORY = 'HP種別';
const PLACE_HEADER_WEBSITE_DOMAIN = 'HPドメイン';
/** 派生列の計算元になる列。旧スキーマからの移行でも同じ名前で存在する。 */
const PLACE_HEADER_WEBSITE_URL = 'HP URL';

const PLACE_DATA_HEADERS = [
  '店名', '主タイプ', PLACE_HEADER_ALL_TYPES,
  '住所', '緯度', '経度',
  '電話番号(国内)',
  PLACE_HEADER_WEBSITE_CATEGORY, PLACE_HEADER_WEBSITE_DOMAIN, PLACE_HEADER_WEBSITE_URL,
  'Google Maps URL',
  '評価', '評価件数',
  '営業状況', '通常営業時間', '価格帯',
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
  const website = classifyWebsite(place.websiteUri);
  const location = place.location || {};

  return [
    place.displayName ? place.displayName.text : '',
    place.primaryTypeDisplayName ? place.primaryTypeDisplayName.text : (place.primaryType || ''),
    place.types ? place.types.join(', ') : '',
    place.formattedAddress || '',
    location.latitude === undefined ? '' : location.latitude,
    location.longitude === undefined ? '' : location.longitude,
    place.nationalPhoneNumber || '',
    website.category,
    website.domain,
    place.websiteUri || '',
    place.googleMapsUri || '',
    // 「評価0」「評価件数0」は営業対象から外す判断材料になるので、未取得(空)と区別する。
    place.rating === undefined ? '' : place.rating,
    place.userRatingCount === undefined ? '' : place.userRatingCount,
    place.businessStatus || '',
    openingHoursText,
    place.priceLevel || '',
    place.id || ''
  ];
}

/**
 * 行容量が足りないときに一度に追加する行数。
 * シートは既定1000行しかなく、そこを超える範囲に setValues すると GAS が例外を投げる
 * (getRange の座標が不正、としてクロールごと落ちる)。1行ずつ足すと毎回フィルタの
 * 範囲が変わって張り直しになるため、まとめて確保して張り直しの頻度を下げる
 * (lib/crawler/PlaceDataSheetFilter.js の方針を参照)。
 */
const PLACE_DATA_ROW_CAPACITY_CHUNK = 1000;

/**
 * requiredLastRow 行目まで書き込めるよう、シートの行数を必要に応じて拡張する。
 *
 * 追加は末尾(insertRowsAfter)に行う。フィルタ範囲の外に足すことになるため、
 * 直後の ensurePlaceDataFilter で張り直しが発生しフィルタ条件は失われるが、
 * これが起きるのは PLACE_DATA_ROW_CAPACITY_CHUNK 行ぶんの新規店舗を集めたときだけ。
 *
 * @param {Sheet} dataSheet
 * @param {number} requiredLastRow - 書き込みたい最終行
 * @returns {boolean} 拡張した場合 true
 */
function ensurePlaceDataRowCapacity(dataSheet, requiredLastRow) {
  const maxRows = dataSheet.getMaxRows();
  if (requiredLastRow <= maxRows) return false;
  const shortage = requiredLastRow - maxRows;
  dataSheet.insertRowsAfter(maxRows, Math.max(shortage, PLACE_DATA_ROW_CAPACITY_CHUNK));
  return true;
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
      ensurePlaceDataRowCapacity(dataSheet, startRow + buffer.length - 1);
      dataSheet.getRange(startRow, 1, buffer.length, PLACE_DATA_HEADERS.length).setValues(buffer);
      written += buffer.length;
      buffer.length = 0;
    },

    writtenCount: function() { return written; }
  };
}
