/**
 * [エントリーポイント/手動実行]
 * 「全飲食店データ」シートのデータ行をすべて削除し、ヘッダーのみの状態に戻す。
 * 座標範囲・グリッド生成ロジックの修正後、ゼロからデータを取り直す際に
 * 最初に1回だけ手動で実行する想定(グリッド一覧は generateGridList 自体が
 * クリアするため、ここでは対象にしない)。
 *
 * @returns {void}
 */
function resetRestaurantData() {
  const scriptProps = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。まだ実行されていない可能性があります。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const dataSheet = spreadsheet.getSheetByName('全飲食店データ');
  if (!dataSheet) {
    Logger.log('全飲食店データシートが見つかりません。');
    return;
  }
  const lastRow = dataSheet.getLastRow();
  if (lastRow > 1) {
    dataSheet.getRange(2, 1, lastRow - 1, dataSheet.getLastColumn()).clearContent();
  }
  Logger.log('全飲食店データをクリアしました(ヘッダーのみ残しています)。');
}
