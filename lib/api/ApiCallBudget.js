/**
 * ===== 1回の実行で使ってよいコール数の上限 =====
 *
 * 月間の無料枠(lib/api/PlacesApiClient.js の MONTHLY_QUOTA_BY_SKU)とは別に、
 * 「この1回の実行でいくつまで使うか」を絞るための仕組み。月間上限は暴走を止める
 * 最後の砦で、こちらは挙動を変えた直後に様子を見るための手綱にあたる。
 *
 * 値の意味は調査系・本番で共通にしている:
 *   未設定 … 上限なし(従来どおり)
 *   0      … 「実行したら何コール要るか」を報告するだけで、リクエストは1件も出さない
 *   N      … N コールまで
 *
 * 読み方の規約が1つなのに実装が複数あると、片方だけ直したときに意味がずれる。
 * そのため読み取りは readApiCallBudget に集約し、各用途はプロパティ名だけを持つ。
 * 用途ごとにプロパティを分けているのは、調査の試行錯誤と本番の収穫では
 * 絞りたい場面が違うため(片方を0にしてももう片方は動かしたい)。
 */

/** 調査系エントリーポイント共通の上限。 */
const SURVEY_MAX_CALLS_PROP = 'SURVEY_MAX_CALLS';

/** 本番クロール(crawlAllGrids)の上限。 */
const CRAWL_MAX_CALLS_PROP = 'CRAWL_MAX_CALLS';

/**
 * 指定したスクリプトプロパティから、1回の実行で使ってよいコール数の上限を読む。
 *
 * 不正な値(数値でない・負数)は、止めるのではなく「上限なし」として警告だけ出す。
 * 日次トリガーで動く処理なので、プロパティの打ち間違いでクロールが丸ごと
 * 止まるより、従来どおり動いて月間上限に守られるほうが安全と判断している。
 *
 * @param {Properties} scriptProps
 * @param {string} propName - SURVEY_MAX_CALLS_PROP または CRAWL_MAX_CALLS_PROP
 * @returns {number|null} 上限。null は上限なし
 */
function readApiCallBudget(scriptProps, propName) {
  const raw = scriptProps.getProperty(propName);
  if (raw === null || raw === '') return null;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) {
    Logger.log(propName + ' の値が不正です: "' + raw + '"。上限なしとして扱います。');
    return null;
  }
  return parsed;
}

/**
 * 調査系エントリーポイントの上限を読む。
 *
 * @param {Properties} scriptProps
 * @returns {number|null} 上限。null は上限なし
 */
function readSurveyMaxCalls(scriptProps) {
  return readApiCallBudget(scriptProps, SURVEY_MAX_CALLS_PROP);
}

/**
 * 本番クロールの上限を読む。
 *
 * @param {Properties} scriptProps
 * @returns {number|null} 上限。null は上限なし
 */
function readCrawlMaxCalls(scriptProps) {
  return readApiCallBudget(scriptProps, CRAWL_MAX_CALLS_PROP);
}
