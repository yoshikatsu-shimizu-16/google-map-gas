/**
 * 配列を指定サイズごとの小さい配列の配列に分割するユーティリティ。
 * 密集判定されたタイプグループをさらに細分化する際に使う。
 *
 * @param {Array} arr
 * @param {number} size
 * @returns {Array[]}
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Place オブジェクト1件を「全飲食店データ」シートに追記する。
 * 既に同じ Place ID が existingIds に含まれる場合は何もせず false を返す(重複除去)。
 *
 * @param {Sheet} dataSheet
 * @param {Object} place
 * @param {Set<string>} existingIds
 * @returns {boolean} 新規に追記した場合は true
 */
function addPlaceRow(dataSheet, place, existingIds) {
  if (existingIds.has(place.id)) return false;
  existingIds.add(place.id);

  const openingHoursText = place.regularOpeningHours && place.regularOpeningHours.weekdayDescriptions
    ? place.regularOpeningHours.weekdayDescriptions.join(' / ')
    : '';

  dataSheet.appendRow([
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
  ]);
  return true;
}
