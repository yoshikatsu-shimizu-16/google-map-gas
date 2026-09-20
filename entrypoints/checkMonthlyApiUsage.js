/**
 * [エントリーポイント/確認用]
 * 課金SKUごとの月間APIコール数をログ出力する(動作確認用)。
 *
 * 無料枠はSKUごとに別勘定(Pro 5,000/月 / Enterprise 1,000/月)なので、合計値だけを見ても
 * どちらが逼迫しているか分からない。調査(Pro)と収穫(Enterprise)のどちらに余裕があるかを
 * 判断するための表示。
 *
 * 注意: このカウンタはスクリプト単位で、GCPプロジェクトを区別しない。APIキーを別の
 * プロジェクトに差し替えてもカウントは引き継がれる(逆に言えば、キーを替えただけでは
 * 上限に達した状態は解消されない)。
 *
 * @returns {void}
 */
function checkMonthlyApiUsage() {
  const scriptProps = PropertiesService.getScriptProperties();
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');

  Logger.log('===== 今月(' + currentMonth + ')のAPIコール数 =====');
  [
    { sku: API_SKU_PRO, label: '調査(Pro段)      ' },
    { sku: API_SKU_ENTERPRISE, label: '営業(Enterprise段)' }
  ].forEach(function(entry) {
    const quota = MONTHLY_QUOTA_BY_SKU[entry.sku];
    // 月が変わっていればカウンタは次回の呼び出しでリセットされるので、表示上は0として扱う
    const isCurrentMonth = scriptProps.getProperty(quota.monthProp) === currentMonth;
    const used = isCurrentMonth ? parseInt(scriptProps.getProperty(quota.countProp) || '0', 10) : 0;
    Logger.log(
      entry.label + ': ' + used + ' / ' + quota.limit +
      ' (残り ' + Math.max(quota.limit - used, 0) + ')'
    );
  });
}
