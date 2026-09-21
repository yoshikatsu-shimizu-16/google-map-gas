/**
 * ===== 「グリッド一覧」シートのスキーマと後方互換移行 =====
 *
 * generateGridList を再実行すると進捗(処理状況)がリセットされてしまうため、
 * 既に処理済みのグリッドを保持したまま新しい列を追加するための自己マイグレーション。
 * crawlAllGrids の冒頭で毎回呼ばれ、何度実行しても結果が変わらない(冪等)。
 *
 * スキーマの変遷:
 *   5列 … グリッドID / 中心緯度 / 中心経度 / 半径(m) / 処理状況
 *   7列 … + 階層 / 親グリッドID                        (密集エリアの自動細分化に対応)
 *   8列 … + セルサイズ(度)                             (半径を導出値にするため)
 *   9列 … + エラー回数                                 (恒久エラーの再試行を打ち切るため)
 */

const GRID_SHEET_HEADERS = [
  'グリッドID', '中心緯度', '中心経度', '半径(m)', '処理状況', '階層', '親グリッドID', 'セルサイズ(度)',
  'エラー回数'
];
const GRID_SHEET_COLUMN_COUNT = GRID_SHEET_HEADERS.length;

/** 列番号(1始まり)。getRange に直接渡せるようにしている。 */
const GRID_COL_STATUS = 5;
const GRID_COL_ERROR_COUNT = 9;

/**
 * 「処理状況」列のうち、そのセルの探索が終わったことを表す値。
 * crawlAllGrids はこれをスキップ判定に、surveyEmptyCells は調査対象の絞り込みに使う。
 * 片方にだけ新しいステータスを足すと、完了済みのセルを二度叩くか永久に飛ばすかの
 * どちらかが起きるため、一覧はここ1箇所に置く。
 */
/**
 * グループA(頻出39種)が0件だったためB/C/Dを省略したセル。
 * 「Googleで探して何も見つからなかった」ことの記録でもあるため、
 * surveyEmptyCells がOSMの予測の答え合わせに使う。
 *
 * **旧方式(A/B/C/D)の時代にしか書かれない。** 通常経路をプレイスタイプ集合1コールに
 * 統一した現在、新しくこの値が付くことはなく、過去の行にだけ残っている。
 * 現行の0件セルは GRID_STATUS_EMPTY。
 */
const GRID_STATUS_EMPTY_BY_GROUP_A = '処理済み(A=0のため省略)';

/**
 * プレイスタイプ集合1コールの結果が0件だったセル。
 *
 * 1〜19件のセルと同じ「処理済み(プローブ)」にまとめてしまうと、**1コール払って得た
 * 「Googleに聞いてもここには店が無い」という一番確実な情報がシートに残らない**。
 * この情報は、探索計画から恒久的に外してよいセルを選ぶ根拠になる
 * (実測では638マス中64マスが0件、分割マスまで含めると331マス。
 * docs/survey-findings-2026-09.md 2-3)。
 *
 * 「0件」と「1件以上取れた」はどちらも探索完了なので、両方とも GRID_DONE_STATUSES に入る。
 * 分けているのは再探索の要否ではなく、後から読み分けられるようにするため。
 */
const GRID_STATUS_EMPTY = '処理済み(0件)';

/**
 * 検索に失敗したセル。完了ではないので、次回の実行で再試行される。
 * 一時的な障害(ネットワーク・API側の不調)を自動で拾い直すための状態。
 */
const GRID_STATUS_ERROR = 'エラー';

/**
 * 再試行の上限まで失敗し続けたセル。完了扱いにして再試行を打ち切る。
 *
 * 「完了」ではなく「これ以上は自動で触らない」という意味なので、名前を
 * `要確認(上限到達)` と揃えて人間の確認に回す。これが無いと、恒久的に失敗する行
 * (座標不正・API側の永続4xxなど)を日次トリガーのたびに叩き続けることになる。
 * しかもクォータ起因でないエラーは自前カウンタから返却されない
 * (lib/api/PlacesApiClient.js の refundApiQuota を参照)ため、
 * 壊れた行1つにつき毎日1コールずつ無料枠が減っていく。
 */
const GRID_STATUS_ERROR_EXHAUSTED = '要確認(エラー継続)';

const GRID_DONE_STATUSES = [
  '処理済み', GRID_STATUS_EMPTY_BY_GROUP_A, GRID_STATUS_EMPTY, '処理済み(プローブ)',
  '密集(タイプ分割済み)', '密集(分割済み)', '要確認(上限到達)',
  GRID_STATUS_ERROR_EXHAUSTED
];

/**
 * 「Googleで探して店が1件も見つからなかった」ことを表すステータスの一覧。
 * 書かれた時代によって値が違う(旧方式=グループA省略 / 現行=プレイスタイプ集合0件)ため、
 * 0件セルを数える側が両方を意識しなくて済むようにここでまとめる。
 */
const GRID_EMPTY_STATUSES = [GRID_STATUS_EMPTY_BY_GROUP_A, GRID_STATUS_EMPTY];

/**
 * 「グリッド一覧」シートを最新スキーマへ移行する。既存の値は一切書き換えない。
 *
 * @param {Sheet} gridSheet - 「グリッド一覧」シートオブジェクト
 * @returns {void}
 */
function ensureGridSchemaMigrated(gridSheet) {
  const lastCol = gridSheet.getLastColumn();
  if (lastCol >= GRID_SHEET_COLUMN_COUNT) return; // 既に最新スキーマ

  const lastRow = gridSheet.getLastRow();
  const dataRowCount = Math.max(lastRow - 1, 0);

  // --- 5列 → 7列: 「階層」「親グリッドID」を追加し、既存行は 階層0・親なし とみなす ---
  if (lastCol < 7) {
    gridSheet.getRange(1, 6, 1, 2).setValues([['階層', '親グリッドID']]);
    if (dataRowCount > 0) {
      const fill = [];
      for (let i = 0; i < dataRowCount; i++) fill.push([0, '']);
      gridSheet.getRange(2, 6, dataRowCount, 2).setValues(fill);
    }
    Logger.log('グリッド一覧シートに「階層」「親グリッドID」列を追加しました(既存データは保持)。');
  }

  // --- 7列 → 8列: 「セルサイズ(度)」を追加し、既存行に埋め戻す ---
  // 既に8列あるシートでこのブロックを走らせ直すと、同じ値を書き戻すだけの無駄な
  // 書き込みとログが出るため、列数で判定して飛ばす。
  if (lastCol < 8) {
    gridSheet.getRange(1, 8, 1, 1).setValues([['セルサイズ(度)']]);
    if (dataRowCount > 0) {
      // 中心緯度・半径・階層を読み、セルサイズを復元する。
      // 階層0 は定義上 GRID_STEP。階層1以上(旧ロジックが半径×0.6で生成した行)は
      // 保存済みの半径から逆算する。
      const rows = gridSheet.getRange(2, 1, dataRowCount, 7).getValues();
      const cellSizes = [];
      const legacyChildTierUpdates = []; // 旧ロジックの子行を MAX_TIER に固定するための書き換え対象
      rows.forEach(function(row, idx) {
        const centerLat = row[1];
        const radius = row[3];
        const tier = row[5] || 0;
        if (tier === 0 || !radius) {
          cellSizes.push([GRID_STEP]);
          return;
        }
        cellSizes.push([cellSizeDegFromCoverRadius(radius, centerLat)]);
        if (tier < MAX_TIER) legacyChildTierUpdates.push(idx);
      });
      gridSheet.getRange(2, 8, dataRowCount, 1).setValues(cellSizes);

      // 旧ロジック(親円を0.6倍4つの円で覆う方式)が生成した tier≥1 の行は、
      // 逆算したセルサイズが「実際に検索した円」の外接正方形でしかなく、円そのものの
      // 形状とは一致しない。もしこの行がまだ飽和と判定され、新ロジックの矩形四分木分割
      // (spawnChildGrids)にかけると、子の円が旧検索円の約19%を覆えなくなる
      // (被覆漏れがまた発生する)。これを避けるため、これらの行は階層を MAX_TIER に
      // 固定し、以後は自動細分化せず「要確認(上限到達)」に倒す。
      if (legacyChildTierUpdates.length > 0) {
        legacyChildTierUpdates.forEach(function(idx) {
          gridSheet.getRange(2 + idx, 6, 1, 1).setValue(MAX_TIER);
        });
        Logger.log(
          '旧ロジックが生成した子グリッド ' + legacyChildTierUpdates.length +
          '件の階層を MAX_TIER(' + MAX_TIER + ') に固定しました' +
          '(円ベースの旧半径を矩形分割すると被覆漏れが起きるため、以後は自動細分化しません)。'
        );
      }
    }
    Logger.log('グリッド一覧シートに「セルサイズ(度)」列を追加しました(既存データは保持)。');
  }

  // --- 8列 → 9列: 「エラー回数」を追加し、既存行は0から数え直す ---
  // 過去に何回失敗したかは記録が無いので復元できない。0 から数え直すため、
  // 既に『エラー』で止まっている行は上限ぶんだけ再試行されることになるが、
  // 一時障害だった可能性もあるので、そのほうが安全側。
  gridSheet.getRange(1, 9, 1, 1).setValues([['エラー回数']]);
  if (dataRowCount > 0) {
    const zeros = [];
    for (let i = 0; i < dataRowCount; i++) zeros.push([0]);
    gridSheet.getRange(2, 9, dataRowCount, 1).setValues(zeros);
  }
  Logger.log('グリッド一覧シートに「エラー回数」列を追加しました(既存データは保持)。');
}
