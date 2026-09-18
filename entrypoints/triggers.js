/**
 * [エントリーポイント/手動実行]
 * crawlAllGrids を毎日自動実行するための時間主導型トリガーを設定する。
 * 初回のみ手動で実行すればよい(既存の同名トリガーがあれば一度削除してから再作成するため、
 * 何度実行してもトリガーが重複しない)。
 *
 * クォータの日次リセット時刻は公式に明示されていないため、深夜帯(3時台)に
 * 実行することで、リセット後できるだけ早いタイミングで未処理分を進める狙い。
 * 「グリッド一覧」が全て完了ステータスになれば、crawlAllGrids 側の早期リターンにより
 * 無駄なAPI呼び出しは発生しない(トリガー自体は動くが即座に終了する)。
 *
 * @returns {void}
 */
function createDailyTrigger() {
  // 同じ関数を実行対象とする既存トリガーがあれば削除(重複作成防止)
  const existingTriggers = ScriptApp.getProjectTriggers();
  existingTriggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'crawlAllGrids') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('crawlAllGrids')
    .timeBased()
    .atHour(3) // 深夜3時台に実行(クォータのリセット後、早めに進めたいための目安)
    .everyDays(1)
    .create();

  Logger.log('crawlAllGrids の日次トリガーを作成しました(毎日3時台に自動実行)。');
}

/**
 * [エントリーポイント/確認用]
 * 現在設定されているトリガーの一覧をログに出力する(設定確認用)。
 * @returns {void}
 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('現在、トリガーは1件も設定されていません。');
    return;
  }
  triggers.forEach(function(trigger) {
    Logger.log(
      '関数: ' + trigger.getHandlerFunction() +
      ' / イベント種別: ' + trigger.getEventType() +
      ' / トリガーID: ' + trigger.getUniqueId()
    );
  });
}
