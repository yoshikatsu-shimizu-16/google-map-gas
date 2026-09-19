/**
 * ===== 検索対象タイプ(includedTypes)の頻度別4グループ =====
 * 出典: Google Maps Platform - Place Types (New) - Food and Drink カテゴリ全166種類
 * https://developers.google.com/maps/documentation/places/web-service/place-types
 *
 * 1リクエストの includedTypes は最大50個までのため、全166種類を1回では指定できない。
 * さらに、単純に50種ずつ機械的に分けるのではなく、日本国内(対象エリア)での出現頻度別に分けている:
 *   TYPE_GROUP_A: 頻出(日本でよく見る一般的なジャンル、39種) → 密集判定の主犯になりやすい
 *   TYPE_GROUP_B: 中頻度(41種)
 *   TYPE_GROUP_C: やや稀(37種)
 *   TYPE_GROUP_D: 非常に稀、日本にはほぼ存在しない各国料理など(49種)
 * B/C/Dは束ねても20件の壁に達することが稀なため、実際にタイプ分割(細分化)が発動するのは
 * ほぼグループAのみになり、無駄なゼロ件リクエストを抑えつつ全タイプを網羅できる設計。
 */
const TYPE_GROUP_A = [
  'restaurant', 'japanese_restaurant', 'family_restaurant', 'fine_dining_restaurant', 'diner',
  'japanese_izakaya_restaurant', 'bar', 'pub', 'ramen_restaurant', 'sushi_restaurant',
  'yakiniku_restaurant', 'yakitori_restaurant', 'cafe', 'coffee_shop', 'bakery',
  'chinese_restaurant', 'korean_restaurant', 'italian_restaurant', 'french_restaurant', 'thai_restaurant',
  'fast_food_restaurant', 'food_court', 'meal_takeaway', 'meal_delivery', 'japanese_curry_restaurant',
  'tonkatsu_restaurant', 'seafood_restaurant', 'pizza_restaurant', 'hamburger_restaurant', 'steak_house',
  'sandwich_shop', 'ice_cream_shop', 'dessert_shop', 'donut_shop', 'cake_shop',
  'buffet_restaurant', 'indian_restaurant', 'vietnamese_restaurant', 'hot_pot_restaurant'
];

const TYPE_GROUP_B = [
  'american_restaurant', 'asian_restaurant', 'asian_fusion_restaurant', 'bar_and_grill', 'barbecue_restaurant',
  'beer_garden', 'bistro', 'breakfast_restaurant', 'brunch_restaurant', 'cafeteria',
  'candy_store', 'cat_cafe', 'chicken_restaurant', 'chinese_noodle_restaurant', 'chocolate_shop',
  'cocktail_bar', 'coffee_stand', 'confectionery', 'deli', 'dessert_restaurant',
  'dim_sum_restaurant', 'dog_cafe', 'dumpling_restaurant', 'juice_shop', 'kebab_shop',
  'korean_barbecue_restaurant', 'mediterranean_restaurant', 'mexican_restaurant', 'noodle_shop', 'pastry_shop',
  'pizza_delivery', 'salad_shop', 'snack_bar', 'soup_restaurant', 'sports_bar',
  'taiwanese_restaurant', 'tea_house', 'vegan_restaurant', 'vegetarian_restaurant', 'western_restaurant',
  'wine_bar'
];

const TYPE_GROUP_C = [
  'acai_shop', 'bagel_shop', 'brazilian_restaurant', 'brewery', 'brewpub',
  'burrito_restaurant', 'cantonese_restaurant', 'chicken_wings_restaurant', 'coffee_roastery', 'european_restaurant',
  'filipino_restaurant', 'fish_and_chips_restaurant', 'fusion_restaurant', 'gastropub', 'german_restaurant',
  'greek_restaurant', 'gyro_restaurant', 'halal_restaurant', 'hawaiian_restaurant', 'hot_dog_restaurant',
  'indonesian_restaurant', 'irish_pub', 'latin_american_restaurant', 'lebanese_restaurant', 'lounge_bar',
  'malaysian_restaurant', 'middle_eastern_restaurant', 'north_indian_restaurant', 'oyster_bar_restaurant', 'pakistani_restaurant',
  'polish_restaurant', 'south_indian_restaurant', 'spanish_restaurant', 'sri_lankan_restaurant', 'taco_restaurant',
  'tapas_restaurant', 'turkish_restaurant'
];

const TYPE_GROUP_D = [
  'afghani_restaurant', 'african_restaurant', 'argentinian_restaurant', 'australian_restaurant', 'austrian_restaurant',
  'bangladeshi_restaurant', 'basque_restaurant', 'bavarian_restaurant', 'belgian_restaurant', 'british_restaurant',
  'burmese_restaurant', 'cajun_restaurant', 'californian_restaurant', 'cambodian_restaurant', 'caribbean_restaurant',
  'chilean_restaurant', 'chocolate_factory', 'colombian_restaurant', 'croatian_restaurant', 'cuban_restaurant',
  'czech_restaurant', 'danish_restaurant', 'dutch_restaurant', 'eastern_european_restaurant', 'ethiopian_restaurant',
  'falafel_restaurant', 'fondue_restaurant', 'hookah_bar', 'hot_dog_stand', 'hungarian_restaurant',
  'irish_restaurant', 'israeli_restaurant', 'mongolian_barbecue_restaurant', 'moroccan_restaurant', 'persian_restaurant',
  'peruvian_restaurant', 'portuguese_restaurant', 'romanian_restaurant', 'russian_restaurant', 'scandinavian_restaurant',
  'shawarma_restaurant', 'soul_food_restaurant', 'south_american_restaurant', 'southwestern_us_restaurant', 'swiss_restaurant',
  'tex_mex_restaurant', 'tibetan_restaurant', 'ukrainian_restaurant', 'winery'
];

const BASE_TYPE_GROUPS = [TYPE_GROUP_A, TYPE_GROUP_B, TYPE_GROUP_C, TYPE_GROUP_D];
const DENSE_SPLIT_CHUNK_SIZE = 6; // 20件に達したグループを、この件数ずつのさらに小さいグループに分割する

/**
 * Food and Drink カテゴリ全166種類のカタログを、頻度別4グループから導出したもの。
 * 4グループが「166種の唯一の真実源」であり、ここで手で列挙し直すと二重管理になるため
 * concat で導出するだけに留めている(要素の追加・削除は必ず TYPE_GROUP_A〜D 側で行う)。
 *
 * includedTypes に指定できるのは Table A(このカタログに含まれるようなタイプ)のみという
 * API制約があるため、プローブ集合(lib/catalog/PlaceTypeProbeSet.js)や被覆分析
 * (lib/catalog/PlaceTypeCoverageAnalysis.js)の候補範囲としても参照される。
 */
const ALL_SEARCHABLE_PLACE_TYPES = TYPE_GROUP_A.concat(TYPE_GROUP_B, TYPE_GROUP_C, TYPE_GROUP_D);

/**
 * 20件の壁に達したタイプグループを、さらに小さいグループの配列に細分化する。
 * グループを分ければそれぞれで別枠の上位20件を確保できるため、
 * 半径を縮めても解決しない「1棟に何十店舗も入る雑居ビル」型の密集に有効。
 *
 * @param {string[]} groupTypes - 20件に達したタイプグループ
 * @returns {string[][]} DENSE_SPLIT_CHUNK_SIZE 件ずつに分けた小グループ
 */
function splitTypeGroupForDenseArea(groupTypes) {
  const subGroups = [];
  for (let i = 0; i < groupTypes.length; i += DENSE_SPLIT_CHUNK_SIZE) {
    subGroups.push(groupTypes.slice(i, i + DENSE_SPLIT_CHUNK_SIZE));
  }
  return subGroups;
}
