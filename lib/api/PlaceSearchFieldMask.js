/**
 * ===== searchNearby で取得するフィールドの指定 =====
 *
 * Places API (New) は X-Goog-FieldMask で指定した項目だけを返し、この内容によって
 * 課金SKUの段(Essentials / Pro / Enterprise / Enterprise+Atmosphere)が決まる。
 * つまり「どの項目を取るか」はデータ設計であると同時にコスト設計でもあるため、
 * 呼び出しコードに散らさずここに集約している。
 *
 * 並び順と内容は lib/crawler/PlaceRowWriter.js の PLACE_DATA_HEADERS と対応している。
 * 項目を増減するときは両方を合わせて変更すること。
 */
const PLACE_SEARCH_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.regularOpeningHours',
  'places.rating',
  'places.userRatingCount',
  // 'places.reviews', // Demoキーでは取得不可のため無効化
  // 'places.photos',  // Demoキーでは取得不可のため無効化
  'places.editorialSummary',
  'places.priceLevel',
  'places.takeout',
  'places.delivery',
  'places.dineIn',
  'places.reservable',
  'places.goodForChildren',
  'places.allowsDogs',
  'places.businessStatus'
].join(',');
