/**
 * ===== 検索戦略の切り替え(新旧の単一の真実源) =====
 *
 * プロパティ名・既定値・不正値の扱いをここに集約する。crawlAllGrids はこのファイルの
 * 関数を通してのみ現在の戦略を知り、プロパティ名の文字列やデフォルト値をコード中に
 * 直接書かない。
 *
 * 既定は SEARCH_STRATEGY_TYPE_GROUPS(旧方式)。プローブ集合はまだ実測で裏取りされて
 * いないため、`clasp push` した時点では挙動が変わらないことを優先している。
 * 検証(entrypoints/auditProbeSetCoverage.js)が済んだらスクリプトプロパティを
 * `probe` に変えるだけで有効化でき、`type_groups` に戻せば push なしで即座に
 * ロールバックできる。
 */
const SEARCH_STRATEGY_PROP = 'SEARCH_STRATEGY';
const SEARCH_STRATEGY_PROBE = 'probe';
const SEARCH_STRATEGY_TYPE_GROUPS = 'type_groups';

/**
 * スクリプトプロパティから現在の検索戦略を読み取る。
 * 未設定なら既定(type_groups)。不正な値が入っていた場合は警告ログを出したうえで
 * 既定へフォールバックする(意図しない値でクロールが止まらないようにするため)。
 *
 * @returns {string} SEARCH_STRATEGY_PROBE または SEARCH_STRATEGY_TYPE_GROUPS
 */
function getSearchStrategy() {
  const scriptProps = PropertiesService.getScriptProperties();
  const raw = scriptProps.getProperty(SEARCH_STRATEGY_PROP);

  if (!raw) return SEARCH_STRATEGY_TYPE_GROUPS;
  if (raw === SEARCH_STRATEGY_PROBE || raw === SEARCH_STRATEGY_TYPE_GROUPS) return raw;

  Logger.log(
    'スクリプトプロパティ ' + SEARCH_STRATEGY_PROP + ' の値が不正です: "' + raw + '"。' +
    '既定の ' + SEARCH_STRATEGY_TYPE_GROUPS + ' を使用します。'
  );
  return SEARCH_STRATEGY_TYPE_GROUPS;
}

/**
 * ログ出力用に、現在の検索戦略を日本語1行で説明する。
 * @param {string} strategy - getSearchStrategy() の戻り値
 * @returns {string}
 */
function describeSearchStrategy(strategy) {
  if (strategy === SEARCH_STRATEGY_PROBE) {
    return 'プローブ優先(SEARCH_STRATEGY=' + SEARCH_STRATEGY_PROBE + ')';
  }
  return 'タイプグループ(SEARCH_STRATEGY=' + SEARCH_STRATEGY_TYPE_GROUPS + '、既定)';
}
