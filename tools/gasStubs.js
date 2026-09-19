/**
 * Google Apps Script のグローバル(Logger / PropertiesService / SpreadsheetApp / UrlFetchApp 等)を
 * ローカルの Node で再現するスタブ。ネットワークアクセスもスプレッドシートも使わない。
 *
 * GAS には型チェックもコンパイルもなく、識別子の取り違えはデプロイして実行するまで
 * 分からない。tools/verifyCrawlerOnStubs.js がこのスタブの上で実際にエントリーポイントを
 * 動かし、デプロイ前に検出できるようにしている。
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * .claspignore のホワイトリストを読み、GAS へアップロードされる全 .js を
 * 単一のグローバルスコープに結合したソースを返す(GAS の実行モデルと同じ)。
 * @returns {{source: string, files: string[]}}
 */
function loadDeployedSource() {
  const files = fs.readFileSync(path.join(REPO_ROOT, '.claspignore'), 'utf8')
    .split('\n')
    .filter(function(line) { return line.startsWith('!') && line.endsWith('.js'); })
    .map(function(line) { return line.slice(1); });
  const source = files
    .map(function(f) { return fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'); })
    .join('\n');
  return { source: source, files: files };
}

/**
 * メモリ上の2次元配列で動く Sheet のスタブ。
 * @param {Array[]} [initialRows] - 初期の行(ヘッダーを含む)
 */
function createFakeSheet(initialRows) {
  const cells = (initialRows || []).map(function(r) { return r.slice(); });
  const ensure = function(row, col) {
    while (cells.length < row) cells.push([]);
    const target = cells[row - 1];
    while (target.length < col) target.push('');
  };

  const sheet = {
    clear: function() { cells.length = 0; return sheet; },
    appendRow: function(values) { cells.push(values.slice()); return sheet; },
    getLastRow: function() { return cells.length; },
    getLastColumn: function() {
      return cells.reduce(function(max, r) { return Math.max(max, r.length); }, 0);
    },
    setFrozenRows: function() { return sheet; },
    getFilter: function() { return null; },
    getRange: function(row, col, numRows, numCols) {
      const nr = numRows || 1;
      const nc = numCols || 1;
      return {
        setValue: function(v) { ensure(row, col); cells[row - 1][col - 1] = v; },
        setValues: function(values) {
          values.forEach(function(r, i) {
            ensure(row + i, col + r.length - 1);
            r.forEach(function(v, j) { cells[row + i - 1][col + j - 1] = v; });
          });
        },
        getValues: function() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            ensure(row + i, col + nc - 1);
            out.push(cells[row + i - 1].slice(col - 1, col - 1 + nc));
          }
          return out;
        },
        createFilter: function() { return {}; }
      };
    },
    rows: function() { return cells; }
  };
  return sheet;
}

/**
 * GAS のグローバルを globalThis に差し込む。
 *
 * @param {Object} [options]
 * @param {function(Object): {places: Object[]}} [options.respondToSearch]
 *   searchNearby のリクエストボディを受け取り、返す places を決める関数。
 * @returns {{sheets: Object, logs: string[], properties: Object, requestCount: function(): number}}
 */
function installGasGlobals(options) {
  const opts = options || {};
  const sheets = {};
  const logs = [];
  const properties = {};
  let requestCount = 0;

  const spreadsheet = {
    getSheetByName: function(name) { return sheets[name] || null; },
    insertSheet: function(name) { sheets[name] = createFakeSheet(); return sheets[name]; },
    getId: function() { return 'stub-spreadsheet-id'; },
    getUrl: function() { return 'https://example.invalid/stub'; }
  };

  global.Logger = { log: function(m) { logs.push(String(m)); } };
  global.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(k) { return k in properties ? properties[k] : null; },
        setProperty: function(k, v) { properties[k] = String(v); }
      };
    }
  };
  global.SpreadsheetApp = {
    openById: function() { return spreadsheet; },
    create: function() { return spreadsheet; }
  };
  global.Session = { getScriptTimeZone: function() { return 'Asia/Tokyo'; } };
  global.Utilities = { formatDate: function() { return '2026-09'; } };
  global.UrlFetchApp = {
    fetch: function(url, opt) {
      requestCount++;
      const body = JSON.parse(opt.payload);
      const result = opts.respondToSearch ? opts.respondToSearch(body) : { places: [] };
      return {
        getResponseCode: function() { return result.responseCode || 200; },
        getContentText: function() { return JSON.stringify({ places: result.places || [] }); }
      };
    }
  };

  return {
    sheets: sheets,
    logs: logs,
    properties: properties,
    requestCount: function() { return requestCount; }
  };
}

module.exports = { loadDeployedSource, createFakeSheet, installGasGlobals, REPO_ROOT };
