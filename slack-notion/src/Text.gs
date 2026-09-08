/**
 * 文字列まわりの純粋関数。外部サービスに触らないのでそのままテストできる。
 */

/**
 * Slack独自のマークアップを素のテキストに直す。
 * <@U123|taro> → @taro、<http://ex.com|例> → 例 など。
 * @param {string} text Slackのメッセージ本文。
 * @return {string}
 */
function slackTextToPlain_(text) {
  if (!text) return '';
  return String(text)
      .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
      .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
      .replace(/<!subteam\^[A-Z0-9]+>/g, '@group')
      .replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, '@$2')
      .replace(/<@([UW][A-Z0-9]+)>/g, '@$1')
      .replace(/<#([CG][A-Z0-9]+)\|([^>]+)>/g, '#$2')
      .replace(/<#([CG][A-Z0-9]+)>/g, '#$1')
      .replace(/<([^|>\s]+)\|([^>]+)>/g, '$2')
      .replace(/<((?:https?|mailto|tel):[^>\s]+)>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
}

/**
 * 文字列を指定長で切り詰める。切ったときは末尾に … を付ける。
 * @param {string} text
 * @param {number} maxLength
 * @return {string}
 */
function truncate_(text, maxLength) {
  var value = String(text == null ? '' : text);
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 1)) + '…';
}

/**
 * メッセージ本文からタスク名を組み立てる。最初の空でない行を使う。
 * @param {string} text Slackのメッセージ本文。
 * @param {string} fallback 本文が空のとき（ファイルのみの投稿など）に使う名前。
 * @return {string}
 */
function buildTaskTitle_(text, fallback) {
  var lines = slackTextToPlain_(text).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+/g, ' ').trim();
    if (line) return truncate_(line, TITLE_MAX_LENGTH);
  }
  return truncate_(fallback || 'Slackメッセージ', TITLE_MAX_LENGTH);
}

/**
 * メッセージへの固定リンクを組み立てる。
 * chat.getPermalink を呼ばずに済むよう、ペイロードの情報だけで作る。
 * @param {string} teamDomain payload.team.domain。
 * @param {string} channelId payload.channel.id。
 * @param {string} ts payload.message.ts。
 * @param {string=} threadTs payload.message.thread_ts。
 * @return {string} 組み立てられない場合は空文字。
 */
function buildPermalink_(teamDomain, channelId, ts, threadTs) {
  if (!teamDomain || !channelId || !ts) return '';
  var url = 'https://' + teamDomain + '.slack.com/archives/' + channelId +
      '/p' + String(ts).replace('.', '');
  if (threadTs && threadTs !== ts) {
    url += '?thread_ts=' + encodeURIComponent(threadTs) +
        '&cid=' + encodeURIComponent(channelId);
  }
  return url;
}

/**
 * 長い本文をNotionのrich_text上限に収まる塊に分ける。改行を優先して切る。
 * @param {string} text
 * @param {number} size
 * @return {!Array<string>}
 */
function chunkText_(text, size) {
  var value = String(text == null ? '' : text);
  if (!value) return [];
  var chunks = [];
  while (value.length > size) {
    var cut = value.lastIndexOf('\n', size);
    if (cut <= 0) cut = size;
    chunks.push(value.slice(0, cut));
    value = value.slice(cut).replace(/^\n/, '');
  }
  if (value) chunks.push(value);
  return chunks;
}

/**
 * SlackのタイムスタンプをJSTなどの読める日時に変換する。
 * @param {string} ts "1717000000.123456" 形式。
 * @param {string} timeZone スクリプトのタイムゾーン。
 * @param {!Object} formatter Utilities 相当（テストで差し替える）。
 * @return {string} 変換できない場合は空文字。
 */
function formatSlackTimestamp_(ts, timeZone, formatter) {
  var seconds = Number(String(ts || '').split('.')[0]);
  if (!seconds || !isFinite(seconds)) return '';
  return formatter.formatDate(new Date(seconds * 1000), timeZone, 'yyyy/MM/dd HH:mm');
}

/**
 * 本文中でメンションされているSlackユーザーIDを、出てきた順に返す。
 * @param {string} text Slackの生の本文（<@U123> を含む）。
 * @return {!Array<string>}
 */
function extractMentionedUserIds_(text) {
  var ids = [];
  var pattern = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
  var matched;
  while ((matched = pattern.exec(String(text || '')))) {
    if (ids.indexOf(matched[1]) === -1) ids.push(matched[1]);
  }
  return ids;
}

/**
 * JSON.parse の例外を握りつぶす版。
 * @param {string} text
 * @return {?Object}
 */
function safeJsonParse_(text) {
  try {
    var parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}
