/**
 * [エントリーポイント/確認用]
 * 現在の月間APIコール数を確認用にログ出力する(動作確認用)。
 * @returns {void}
 */
function checkMonthlyApiUsage() {
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const savedMonth = scriptProps.getProperty(QUOTA_PROP_MONTH);
  const count = savedMonth === currentMonth ? (scriptProps.getProperty(QUOTA_PROP_COUNT) || '0') : '0';
  Logger.log('今月(' + currentMonth + ')のAPIコール数: ' + count + ' / ' + MONTHLY_API_CALL_LIMIT);
}
