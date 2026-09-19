/**
 * ===== HP(ウェブサイト)の種別判定 =====
 *
 * Places API が返す websiteUri は「その店に紐づく URL」であって「自社ホームページ」とは
 * 限らない。実データでは HP ありと判定された店の約3割が Instagram / Facebook のページで、
 * これらは自前の集客導線を持たない = LP 制作の見込み客そのものである。
 * あり/なしの2値では営業リストとして使えないため、ホスト名から種別を導出する。
 *
 * チェーン店の店舗ページ(shop.dennys.jp / map.mcdonalds.co.jp など)はここでは判定しない。
 * チェーン名を列挙し始めると際限なくメンテが必要になる一方、「同じドメインが複数の店舗に
 * 現れている」という事実はシート上で見れば分かる。そのため HPドメイン を別列として出し、
 * チェーンかどうかは運用者がピボットで判断する方針にしている。
 */

const WEBSITE_CATEGORY_NONE = 'なし';
const WEBSITE_CATEGORY_SNS = 'SNSのみ';
const WEBSITE_CATEGORY_GOURMET_PORTAL = 'グルメポータル';
const WEBSITE_CATEGORY_SIMPLE_PAGE = '簡易ページ';
const WEBSITE_CATEGORY_OWN_SITE = '自社HP';

/**
 * SNS のプロフィールページ。実質 HP なしとして扱いたい最優先の見込み客。
 *
 * 短縮ドメイン(lin.ee / fb.me / instagr.am / youtu.be)は本体ドメインのサブドメインでは
 * ないため、個別に挙げないと「自社HP」に倒れてしまう。特に lin.ee は LINE 公式アカウントの
 * 標準的なリンク形式で、まさにこの機能が拾いたい層がそのまま漏れる。
 */
const SNS_DOMAINS = [
  'instagram.com', 'instagr.am',
  'facebook.com', 'fb.com', 'fb.me',
  'x.com', 'twitter.com',
  'tiktok.com',
  'line.me', 'lin.ee',
  'youtube.com', 'youtu.be',
  'lit.link', 'linktr.ee', 'note.com'
];

/** 第三者のグルメ/予約/デリバリーポータル。自社導線を持たない見込み客。 */
const GOURMET_PORTAL_DOMAINS = [
  'tabelog.com', 'gnavi.co.jp', 'hotpepper.jp', 'r.recruit.co.jp', 'retty.me',
  'hitosara.com', 'ikyu.com', 'ozmall.co.jp', 'tablecheck.com', 'toreta.in',
  'ubereats.com', 'demae-can.com', 'menu.inc', 'wolt.com',
  'localplace.jp', 'itp.ne.jp', 'ekiten.jp', 'loco.yahoo.co.jp',
  'navitime.co.jp', 'goo.ne.jp', 'saidomenu.com'
];

/** ノーコード/ブログ系の簡易ページ。自作で止まっている準見込み客。 */
const SIMPLE_PAGE_DOMAINS = [
  'sites.google.com', 'peraichi.com', 'goope.jp', 'wixsite.com', 'wix.com',
  'jimdofree.com', 'jimdo.com', 'ameblo.jp', 'hatenablog.com', 'hateblo.jp',
  'blogspot.com', 'crayonsite.com', 'crayonsite.net', 'webnode.jp',
  'studio.site', 'fc2.com', 'jugem.jp', 'livedoor.jp'
];

/**
 * URL からホスト名を取り出す。GAS には URL クラスがないため正規表現で処理する。
 * 先頭の www. とポート番号は落とし、小文字に正規化する。
 *
 * @param {string} url
 * @returns {string} ホスト名。取り出せない場合は空文字
 */
function extractWebsiteHostname(url) {
  const withProtocol = url.match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^/?#]+)/);
  const host = withProtocol ? withProtocol[1] : url.split(/[/?#]/)[0];
  if (!host || host.indexOf('.') === -1) return '';
  return host.replace(/:\d+$/, '').replace(/^www\./i, '').toLowerCase();
}

/**
 * ホスト名が対象ドメインそのもの、またはそのサブドメインかを判定する。
 * ドット境界で見るため notfacebook.com は facebook.com に一致しない。
 *
 * @param {string} hostname
 * @param {string[]} domains
 * @returns {boolean}
 */
function matchesAnyDomain(hostname, domains) {
  return domains.some(function(domain) {
    return hostname === domain || hostname.slice(-(domain.length + 1)) === '.' + domain;
  });
}

/**
 * websiteUri を営業リスト向けの種別とドメインに変換する。
 *
 * @param {string|undefined} websiteUri - Places API の places.websiteUri
 * @returns {{category: string, domain: string}}
 */
function classifyWebsite(websiteUri) {
  const url = websiteUri ? String(websiteUri).trim() : '';
  if (!url) return { category: WEBSITE_CATEGORY_NONE, domain: '' };

  const hostname = extractWebsiteHostname(url);
  // URL は入っているがホスト名として解釈できない(まず起きない)。値がある事実は残す。
  if (!hostname) return { category: WEBSITE_CATEGORY_OWN_SITE, domain: '' };

  if (matchesAnyDomain(hostname, SNS_DOMAINS)) {
    return { category: WEBSITE_CATEGORY_SNS, domain: hostname };
  }
  if (matchesAnyDomain(hostname, GOURMET_PORTAL_DOMAINS)) {
    return { category: WEBSITE_CATEGORY_GOURMET_PORTAL, domain: hostname };
  }
  if (matchesAnyDomain(hostname, SIMPLE_PAGE_DOMAINS)) {
    return { category: WEBSITE_CATEGORY_SIMPLE_PAGE, domain: hostname };
  }
  return { category: WEBSITE_CATEGORY_OWN_SITE, domain: hostname };
}
