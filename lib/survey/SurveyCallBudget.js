/**
 * ===== 調査系エントリーポイントが1回の実行で使ってよいコール数 =====
 *
 * 調査は複数のエントリーポイントに分かれているが、運用者が気にするのは
 * 「今回いくつ使うのか」の1点なので、上限の指定はプロパティ1つに統一している。
 *
 * 0 を指定すると「数えるだけで叩かない」試算モードになる。請求先を紐付けたキーに
 * 切り替えた直後など、消費量を確定させてから実行したい場面のために用意している。
 */
const SURVEY_MAX_CALLS_PROP = 'SURVEY_MAX_CALLS';

/**
 * 1回の実行で使ってよいコール数の上限を読む。
 *
 * @param {Properties} scriptProps
 * @returns {number|null} 上限。null は上限なし
 */
function readSurveyMaxCalls(scriptProps) {
  const raw = scriptProps.getProperty(SURVEY_MAX_CALLS_PROP);
  if (raw === null || raw === '') return null;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) {
    Logger.log(SURVEY_MAX_CALLS_PROP + ' の値が不正です: "' + raw + '"。上限なしとして扱います。');
    return null;
  }
  return parsed;
}
