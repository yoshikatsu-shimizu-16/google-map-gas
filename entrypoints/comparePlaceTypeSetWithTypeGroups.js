/**
 * [エントリーポイント/調査用]
 * 「傘のように他を包含するプレイスタイプ集合(36種)1コールで、頻度別4グループ
 * (A/B/C/D)と同じ店が取れるか」を実地検証する。
 *
 * ねらい: 2026-09-20 の実測では、1セルあたり6.9コールのうち B/C/D が35%、タイプ再分割が50%を
 * 占めていた。Places API (New) の includedTypes は primaryType ではなく place の types 配列
 * 全体にマッチするため、'restaurant' のような、他を包含するプレイスタイプ1つで
 * 'ramen_restaurant' の店もヒットする。これが成立するなら166種を列挙する必要がなくなり、
 * 上記85%の大半が消える。
 *
 * 検証方法: 複数セルを抽出し、各セルで
 *   P = PLACE_TYPE_SEARCH_SET で1コール
 *   U = A/B/C/D で4コール(合算)
 * を取り、U \ P(プレイスタイプ集合が取りこぼした店)を数える。
 *
 * 飽和セルは判定に使わない。P も U も20件で切り捨てられるため、差分が「被覆漏れ」なのか
 * 「20件の壁」なのか区別できないため。P(プレイスタイプ集合)が20件返したセルはその時点で
 * 打ち切る(消費は1コールだけ)。
 *
 * コスト: Pro段(PLACE_SURVEY_FIELD_MASK)なので **Enterprise枠(営業用の1,000/月)を消費しない**。
 * 1セルあたり、飽和なら1コール、判定できれば5コール。
 *
 * 重要: 取得した place を「全飲食店データ」に書き込まない。Pro段には rating も websiteUri も
 * 含まれないため、書き込むと評価とHPが空の行ができる。その行は Place ID で重複除去されるので、
 * 本番のクロールが二度とその店の営業データを取りに行かなくなる。
 * (旧実装は Enterprise段で取得して書き込んでいた。段を下げたのでこの前提が崩れた。)
 *
 * @returns {void}
 */
function comparePlaceTypeSetWithTypeGroups() {
  const startTime = new Date().getTime();
  const MAX_RUNTIME_MS = 4.5 * 60 * 1000;

  const scriptProps = PropertiesService.getScriptProperties();
  const sampleSize = readPlaceTypeSurveySampleSize(scriptProps);
  const apiKey = scriptProps.getProperty('GOOGLE_MAPS_API_KEY');
  const spreadsheetId = scriptProps.getProperty('TARGET_SPREADSHEET_ID');
  if (!spreadsheetId) {
    Logger.log('TARGET_SPREADSHEET_ID が未設定です。先に generateGridList を実行してください。');
    return;
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  const gridSheet = spreadsheet.getSheetByName('グリッド一覧');
  if (!gridSheet) {
    Logger.log('グリッド一覧シートがありません。先に generateGridList を実行してください。');
    return;
  }
  const gridLastRow = gridSheet.getLastRow();
  if (gridLastRow < 2) {
    Logger.log('グリッドが空です。');
    return;
  }

  Logger.log('===== プレイスタイプ集合の被覆検証(Pro段・営業用の枠は使いません) =====');

  const logSheet = ensurePlaceTypeSurveyLogSheet(spreadsheet);
  const testedGridIds = readTestedGridIds(logSheet);
  const gridValues = gridSheet.getRange(2, 1, gridLastRow - 1, GRID_SHEET_COLUMN_COUNT).getValues();
  const targets = selectPlaceTypeSurveyCells(gridValues, testedGridIds, sampleSize);

  if (targets.length === 0) {
    Logger.log('検証対象のセルがありません(サンプル数ぶん検証済み、またはグリッドが足りません)。');
    return;
  }
  Logger.log('検証対象: ' + targets.length + 'セル(消費は1セルあたり 飽和1コール / 判定5コール)');

  const rows = [];
  const missedTypeRows = []; // 漏れた店の types。あとで「足すべきタイプ」を求めるのに使う
  let judged = 0, matched = 0, missedPlaces = 0, comparedPlaces = 0, saturated = 0, failed = 0;
  let stoppedReason = '';

  for (let i = 0; i < targets.length; i++) {
    if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
      stoppedReason = '実行時間の上限に近づいたため中断しました。再実行すると続きから検証します。';
      break;
    }
    const cell = targets[i];
    const outcome = compareOneCell(apiKey, cell);

    if (outcome.status === 'エラー') {
      failed++;
    } else if (outcome.status === '飽和のため判定不能') {
      saturated++;
    } else {
      judged++;
      comparedPlaces += outcome.unionCount;
      missedPlaces += outcome.missed.length;
      if (outcome.missed.length === 0) matched++;
      outcome.missed.forEach(function(place) { missedTypeRows.push(place.types || []); });
    }
    rows.push(toPlaceTypeSurveyRow(cell, outcome));

    if (outcome.quotaExceeded) {
      stoppedReason = '利用上限に達したため中断しました。';
      break;
    }
  }

  if (rows.length > 0) {
    logSheet.getRange(logSheet.getLastRow() + 1, 1, rows.length, PLACE_TYPE_SURVEY_LOG_HEADERS.length).setValues(rows);
  }

  reportPlaceTypeSurveyResult({
    judged: judged, matched: matched, saturated: saturated, failed: failed,
    comparedPlaces: comparedPlaces, missedPlaces: missedPlaces, missedTypeRows: missedTypeRows
  });
  if (stoppedReason) Logger.log('→ ' + stoppedReason);
}

/** 検証ログの列。あとから個別セルの判断根拠を追えるようにしている。 */
const PLACE_TYPE_SURVEY_LOG_HEADERS = [
  'グリッドID', '中心緯度', '中心経度', '検索件数', '4グループ件数', '漏れ件数',
  '判定', '漏れた店', '確認日時'
];

/**
 * 1セルで P(プレイスタイプ集合1コール)と U(A/B/C/D の4コール)を比べる。
 *
 * @param {string} apiKey
 * @param {{gridId: number, lat: number, lng: number, radius: number}} cell
 * @returns {{status: string, placeTypeSetCount: number, unionCount: number, missed: Object[],
 *   quotaExceeded: boolean, note: string}}
 */
function compareOneCell(apiKey, cell) {
  const search = function(includedTypes) {
    return callSearchNearby(apiKey, PLACE_SURVEY_FIELD_MASK, includedTypes, cell.lat, cell.lng, cell.radius);
  };

  const placeTypeSetResult = search(PLACE_TYPE_SEARCH_SET);
  if (!placeTypeSetResult.ok) {
    return { status: 'エラー', placeTypeSetCount: 0, unionCount: 0, missed: [],
      quotaExceeded: placeTypeSetResult.quotaExceeded, note: placeTypeSetResult.errorText.slice(0, 200) };
  }
  if (placeTypeSetResult.places.length >= MAX_RESULT_COUNT) {
    // 20件ちょうど = 切り捨てられている。U も同じく切り捨てられるので差分の意味が読めない。
    return { status: '飽和のため判定不能', placeTypeSetCount: placeTypeSetResult.places.length, unionCount: 0,
      missed: [], quotaExceeded: false, note: 'プレイスタイプ集合の検索が20件に達したため比較を打ち切り(消費1コール)' };
  }

  const placeTypeSetIds = {};
  placeTypeSetResult.places.forEach(function(p) { if (p.id) placeTypeSetIds[p.id] = true; });

  const unionById = {};
  for (let g = 0; g < BASE_TYPE_GROUPS.length; g++) {
    const groupResult = search(BASE_TYPE_GROUPS[g]);
    if (!groupResult.ok) {
      return { status: 'エラー', placeTypeSetCount: placeTypeSetResult.places.length, unionCount: 0, missed: [],
        quotaExceeded: groupResult.quotaExceeded, note: groupResult.errorText.slice(0, 200) };
    }
    groupResult.places.forEach(function(p) { if (p.id) unionById[p.id] = p; });
  }

  const missed = Object.keys(unionById)
    .filter(function(id) { return !placeTypeSetIds[id]; })
    .map(function(id) { return unionById[id]; });

  return {
    status: missed.length === 0 ? '一致' : '漏れあり',
    placeTypeSetCount: placeTypeSetResult.places.length,
    unionCount: Object.keys(unionById).length,
    missed: missed,
    quotaExceeded: false,
    note: ''
  };
}

/**
 * 検証結果を集計して報告する。漏れがあった場合は、プレイスタイプ集合に足せば埋まるタイプも出す。
 *
 * @param {{judged: number, matched: number, saturated: number, failed: number,
 *   comparedPlaces: number, missedPlaces: number, missedTypeRows: Array<string[]>}} summary
 * @returns {void}
 */
function reportPlaceTypeSurveyResult(summary) {
  Logger.log('--- 検証結果 ---');
  Logger.log('判定できたセル: ' + summary.judged +
    ' / 飽和で判定不能: ' + summary.saturated + ' / エラー: ' + summary.failed);
  if (summary.judged === 0) {
    Logger.log('判定できたセルがありません。サンプル数を増やすか、疎なセルを含む範囲で試してください。');
    return;
  }

  Logger.log('完全一致: ' + summary.matched + '/' + summary.judged + 'セル');
  Logger.log('比較した店: ' + summary.comparedPlaces + '件 / プレイスタイプ集合が取りこぼした店: ' + summary.missedPlaces + '件');
  if (summary.comparedPlaces > 0) {
    const covered = summary.comparedPlaces - summary.missedPlaces;
    Logger.log('→ プレイスタイプ集合の被覆率: ' + (covered / summary.comparedPlaces * 100).toFixed(1) + '%');
  }

  if (summary.missedPlaces === 0) {
    Logger.log('取りこぼしはありませんでした。B/C/Dの3コールを省ける見込みがあります。');
    return;
  }

  // 漏れた店を覆うのに足りないタイプを、既存の貪欲法で求める。
  // includedTypes は50個までなので、現在のプレイスタイプ集合との差が追加できる枠。
  const room = INCLUDED_TYPES_MAX_PER_REQUEST - PLACE_TYPE_SEARCH_SET.length;
  const cover = findMinimalPlaceTypeCover(summary.missedTypeRows, ALL_SEARCHABLE_PLACE_TYPES, room);
  Logger.log('プレイスタイプ集合に足すと漏れが埋まるタイプ(残り枠 ' + room + '種):');
  cover.cover.forEach(function(entry) {
    Logger.log('  ' + entry.type + ': 漏れ ' + entry.newlyCovered + '件を新たに被覆');
  });
  if (cover.uncoveredRowIndexes.length > 0) {
    Logger.log('  ※ ' + cover.uncoveredRowIndexes.length +
      '件は Table A のタイプを持たないため、includedTypes では拾えません。');
  }
}

/**
 * 検証するセルを選ぶ。グリッド全体に散らすため等間隔に抽出する
 * (先頭から順に取ると南西の一角だけを見ることになり、結果が地域に偏る)。
 *
 * @param {Array[]} gridValues
 * @param {Set<number>} testedGridIds
 * @param {number} sampleSize
 * @returns {Array<{gridId: number, lat: number, lng: number, radius: number}>}
 */
function selectPlaceTypeSurveyCells(gridValues, testedGridIds, sampleSize) {
  const candidates = gridValues.filter(function(row) { return !testedGridIds.has(row[0]); });
  if (candidates.length === 0) return [];

  const stride = Math.max(Math.floor(candidates.length / sampleSize), 1);
  const picked = [];
  for (let i = 0; i < candidates.length && picked.length < sampleSize; i += stride) {
    const row = candidates[i];
    picked.push({ gridId: row[0], lat: row[1], lng: row[2], radius: row[3] });
  }
  return picked;
}

/**
 * 1回の実行で検証するセル数。未設定なら20。
 *
 * スクリプトプロパティのキー名 'PROBE_SURVEY_SAMPLE_SIZE' は、運用者が既に設定して
 * いる可能性がある値を引き継ぐため、変数・関数名をリネームしたあとも変更していない
 * (MONTHLY_API_CALL_COUNT と同じ理由。README.md を参照)。
 *
 * @param {Properties} scriptProps
 * @returns {number}
 */
function readPlaceTypeSurveySampleSize(scriptProps) {
  const raw = scriptProps.getProperty('PROBE_SURVEY_SAMPLE_SIZE');
  if (raw === null || raw === '') return 20;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    Logger.log('PROBE_SURVEY_SAMPLE_SIZE の値が不正です: "' + raw + '"。既定の20を使います。');
    return 20;
  }
  return parsed;
}

/**
 * 検証ログシートを取得する(無ければヘッダー付きで作る)。
 * @param {Spreadsheet} spreadsheet
 * @returns {Sheet}
 */
function ensurePlaceTypeSurveyLogSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName('調査ログ(傘型)');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('調査ログ(傘型)');
    sheet.appendRow(PLACE_TYPE_SURVEY_LOG_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 検証済みのグリッドIDを読む。再実行時に同じセルを二度叩かないため。
 * @param {Sheet} logSheet
 * @returns {Set<number>}
 */
function readTestedGridIds(logSheet) {
  const ids = new Set();
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return ids;
  logSheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row) {
    if (row[0] !== '' && row[0] !== null) ids.add(row[0]);
  });
  return ids;
}

/**
 * 検証ログの1行を組み立てる。
 * @param {{gridId: number, lat: number, lng: number}} cell
 * @param {Object} outcome
 * @returns {Array}
 */
function toPlaceTypeSurveyRow(cell, outcome) {
  const missedText = outcome.missed.length > 0
    ? outcome.missed.slice(0, 5).map(function(p) {
        return (p.displayName ? p.displayName.text : p.id) + '[' + (p.types || []).join(' ') + ']';
      }).join(' / ')
    : outcome.note;
  return [
    cell.gridId, cell.lat, cell.lng,
    outcome.placeTypeSetCount, outcome.unionCount, outcome.missed.length,
    outcome.status, missedText, new Date()
  ];
}
