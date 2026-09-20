/**
 * [エントリーポイント/確認用]
 * 現在の月間APIコール数と検索方式(SEARCH_STRATEGY)を確認用にログ出力する(動作確認用)。
 * 検索方式を併記するのは、コール数だけを見てもバーンレートの解釈を誤らないため
 * (probe方式は1セルあたりのコール数が type_groups より少ない)。
 * @returns {void}
 */
function checkMonthlyApiUsage() {
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const savedMonth = scriptProps.getProperty(QUOTA_PROP_MONTH);
  const count = savedMonth === currentMonth ? (scriptProps.getProperty(QUOTA_PROP_COUNT) || '0') : '0';
  Logger.log('今月(' + currentMonth + ')のAPIコール数: ' + count + ' / ' + MONTHLY_API_CALL_LIMIT);
  Logger.log('[検索方式] ' + describeSearchStrategy(getSearchStrategy()));
}
