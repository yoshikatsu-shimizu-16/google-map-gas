/**
 * ===== プローブ集合(実測のたびに変わる「データ」) =====
 *
 * Places API (New) の includedTypes は primaryType ではなく place の types 配列全体に
 * マッチする。ALL_SEARCHABLE_PLACE_TYPES(166種、PlaceTypeCatalog.js)には既に
 * 'restaurant' / 'cafe' / 'bar' / 'bakery' のような傘型(umbrella)が含まれており、
 * primaryType が 'ramen_restaurant' の店も includedTypes: ['restaurant'] でヒットする。
 * この傘型を中心に少数の集合を組めば、1コールで166種の大半を被覆できる可能性がある。
 *
 * 「集合の中身」は実測(entrypoints/auditProbeSetCoverage.js)のたびに更新されるデータ、
 * 「集合を評価するアルゴリズム」(lib/catalog/PlaceTypeCoverageAnalysis.js)は変わらない
 * ロジックであり、変更理由が異なるためファイルを分けている。
 *
 * ----- 現在の値: 2026-09-20 実測(docs/survey-findings-2026-09.md) -----
 *   独立検証(compareProbeSetWithTypeGroups、API差分): 母集団60件、取りこぼし0件。
 *   シート実測(surveyAllCells、調査(店)7,027件): 被覆率100%。ただしこれは36種の
 *     プローブ自身の検索結果に対する自己参照的な集計であり、地域全体の網羅率を
 *     証明するものではない(docs/survey-next-actions-2026-09-20.md 2-1節)。
 *     独立した根拠として扱えるのは上記の60件のみ。
 *   カタログ166種のうち実在が確認できたのは104種、62種は1度も出現しない。
 *   判断の根拠: 傘型候補(12) + 傘に属さない残余候補(24)の手作業選定。
 *     全要素が ALL_SEARCHABLE_PLACE_TYPES 内・重複なし・36種であることは
 *     tools/verifyProbeSetCoverage.js で確認済み。
 *
 *   傘型候補(12): 他の頻出タイプを types 配列で包含していると期待される一般名
 *   傘外候補(24): 上記の傘に含まれない可能性が高い残余(菓子・パン・喫茶系の専門店など)
 */
const PLACE_TYPE_PROBE_SET = [
  // --- 傘型候補(12) ---
  'restaurant', 'cafe', 'coffee_shop', 'bar', 'pub', 'bakery',
  'meal_takeaway', 'meal_delivery', 'food_court', 'fast_food_restaurant',
  'dessert_shop', 'ice_cream_shop',
  // --- 傘外候補(24) ---
  'candy_store', 'chocolate_shop', 'confectionery', 'pastry_shop', 'cake_shop',
  'donut_shop', 'bagel_shop', 'sandwich_shop', 'deli', 'juice_shop',
  'tea_house', 'coffee_stand', 'coffee_roastery', 'acai_shop', 'salad_shop',
  'snack_bar', 'brewery', 'winery', 'chocolate_factory', 'hot_dog_stand',
  'cat_cafe', 'dog_cafe', 'cafeteria', 'hookah_bar'
];

/**
 * types 配列がプローブ集合のいずれかの要素と交差するかを判定する。
 * includedTypes: PLACE_TYPE_PROBE_SET で1回検索して返ってきた店は、この関数に
 * かけると理屈上は必ず true になるはず(自己検証にも使う。詳細は
 * ProbeFirstCellSearch.js を参照)。
 *
 * @param {string[]|undefined} placeTypes - place.types(未取得なら undefined)
 * @returns {boolean}
 */
function isCoveredByProbeSet(placeTypes) {
  if (!placeTypes || placeTypes.length === 0) return false;
  for (let i = 0; i < placeTypes.length; i++) {
    if (PLACE_TYPE_PROBE_SET.indexOf(placeTypes[i]) !== -1) return true;
  }
  return false;
}
