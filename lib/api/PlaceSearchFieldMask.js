/**
 * ===== searchNearby で取得するフィールドの指定 =====
 *
 * Places API (New) は X-Goog-FieldMask で指定した項目だけを返し、この内容によって
 * 課金SKUの段(Essentials / Pro / Enterprise / Enterprise + Atmosphere)が決まる。
 * つまり「どの項目を取るか」はデータ設計であると同時にコスト設計でもあるため、
 * 呼び出しコードに散らさずここに集約している。
 *
 * 段ごとの無料枠(月)と単価、およびこのプロジェクトでの扱い:
 *
 *   Pro             5,000コール / $32  … id, displayName, primaryType, formattedAddress,
 *                                        location, types, googleMapsUri, businessStatus
 *   Enterprise      1,000コール / $35  … websiteUri, rating, userRatingCount,
 *                                        nationalPhoneNumber, regularOpeningHours, priceLevel
 *   Ent+Atmosphere  1,000コール / $40  … takeout, delivery, dineIn, reservable,
 *                                        goodForChildren, allowsDogs, editorialSummary
 *
 * このプロジェクトの目的は「評価が高いのに HP を持たない店を見つけて営業をかける」ことで、
 * その中核である websiteUri / rating / userRatingCount / nationalPhoneNumber が
 * すべて Enterprise 段にある。したがって:
 *
 *   - Pro に落とすことはできない(落とすと目的そのものが果たせない)。
 *   - Enterprise の無料枠も 1,000/月 なので、Atmosphere 系を捨てても枠は増えない。
 *     それでも捨てているのは、単価が $40 → $35 に下がるうえ、実データでの充足率が
 *     ペット可 1% / 説明文 6% / 子連れ向き 33% と低く、最上位 SKU に見合わないため。
 *   - 逆に Pro 段の項目(location, types)は何個足してもコストが増えない。無料なので取る。
 *
 * 探索(id のみ)と詳細取得(Place Details)を分離する案は採用していない。rating と
 * websiteUri を全店ぶん見ないとターゲットを選べず、詳細を全店に打つことになるため。
 * searchNearby は1コールで最大20件ぶんの Enterprise データを返すので、分離すると
 * 無料枠の消化が約1.5ヶ月から約3.5ヶ月に悪化する。
 *
 * 内容は lib/crawler/PlaceRowWriter.js の PLACE_DATA_HEADERS と対応している(並び順は
 * シート側の見やすさを優先しているため一致しない)。項目を増減するときは両方を合わせ、
 * lib/crawler/PlaceDataSchemaMigration.js のスキーマ変遷コメントも更新すること。
 */
const PLACE_SEARCH_FIELD_MASK = [
  // --- Pro 段(この構成では実質無料。増やしてもコストは変わらない) ---
  'places.id',
  'places.displayName',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.formattedAddress',
  'places.location',
  'places.googleMapsUri',
  'places.businessStatus',
  // 'places.photos',  // Demoキーでは取得不可のため無効化
  // --- Enterprise 段(ターゲット選定の中核。ここが課金段を決めている) ---
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.nationalPhoneNumber',
  'places.regularOpeningHours',
  'places.priceLevel'
  // --- Enterprise + Atmosphere 段は使わない(上のコメント参照) ---
].join(',');
