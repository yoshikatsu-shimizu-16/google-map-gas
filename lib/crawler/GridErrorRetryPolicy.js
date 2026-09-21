/**
 * ===== 検索に失敗したセルを、いつ諦めるか(純関数) =====
 *
 * Sheet / Logger / API に触らないため、tools/verifyCrawlerOnStubs.js から
 * そのまま呼んで検証できる。
 *
 * 失敗したセルを「完了」にしないのは、一時的な障害(ネットワーク・API側の不調)を
 * 次回の実行で自動的に拾い直すため。ただし無条件に再試行し続けると、恒久的に失敗する
 * 行(座標不正・API側の永続4xxなど)を日次トリガーのたびに叩くことになる。
 * さらにクォータ起因でないエラーは自前の月間カウンタから返却されない
 * (lib/api/PlacesApiClient.js の refundApiQuota のコメントを参照)ので、
 * 壊れた行1つにつき毎日1コールずつ無料枠が減っていく。
 *
 * そこで回数を数え、上限に達したら完了扱いのステータスへ倒して人間の確認に委ねる。
 * 「何回で諦めるか」は運用方針であってシートのスキーマではないため、
 * ステータスの語彙を持つ lib/grid/GridSchemaMigration.js とはファイルを分けている。
 */

/**
 * 同じセルを再試行する上限回数。これを超えたら自動での再試行を打ち切る。
 *
 * 日次トリガーなので、3 は「3日連続で失敗したら諦める」の意味になる。
 * 一時的な不調なら3日のうちに復旧するはずで、それでも直らないなら
 * 自動で叩き続けても解決しない、という判断。
 */
const MAX_GRID_ERROR_RETRIES = 3;

/**
 * 検索に失敗したセルの、次の「処理状況」と「エラー回数」を決める。
 *
 * @param {number|string|null|undefined} currentErrorCount - シートに入っている現在のエラー回数
 *   (列を追加した直後や手で消された場合に備え、数値でない値は0として扱う)
 * @returns {{status: string, errorCount: number, exhausted: boolean}}
 *   exhausted が true なら、これ以上は自動で再試行しない
 */
function nextStateAfterGridError(currentErrorCount) {
  const parsed = parseInt(currentErrorCount, 10);
  const errorCount = (isNaN(parsed) || parsed < 0 ? 0 : parsed) + 1;
  const exhausted = errorCount >= MAX_GRID_ERROR_RETRIES;

  return {
    status: exhausted ? GRID_STATUS_ERROR_EXHAUSTED : GRID_STATUS_ERROR,
    errorCount: errorCount,
    exhausted: exhausted
  };
}
