/**
 * 設定。秘密情報はコードに書かず、すべてスクリプトプロパティに保存する。
 * 設定方法は slack-notion/README.md を参照。
 */

var PROP_KEYS = {
  slackBotToken: 'SLACK_BOT_TOKEN',
  slackVerificationToken: 'SLACK_VERIFICATION_TOKEN',
  webhookSecret: 'WEBHOOK_SECRET',
  notionToken: 'NOTION_TOKEN',
  notionVersion: 'NOTION_VERSION',
  databaseAllowlist: 'NOTION_DATABASE_ALLOWLIST',
  urlPropertyName: 'NOTION_URL_PROPERTY',
  databaseCache: 'DATABASE_CACHE'
};

/** Notion API のバージョン。プロパティで上書きできる。 */
var DEFAULT_NOTION_VERSION = '2022-06-28';

/** ショートカットの callback_id（Slackアプリのマニフェストと合わせる）。 */
var SHORTCUT_CALLBACK_ID = 'add_to_notion';

/** モーダルの callback_id / block_id / action_id。 */
var MODAL_CALLBACK_ID = 'create_notion_task';
var DATABASE_BLOCK_ID = 'database';
var DATABASE_ACTION_ID = 'database_select';

/** Notion のタイトルは長すぎると読みにくいので切り詰める。 */
var TITLE_MAX_LENGTH = 100;

/** Notion の rich_text 1つあたりの上限は2000文字。余裕を持って分割する。 */
var RICH_TEXT_CHUNK_SIZE = 1900;

/** Slack のセレクトは最大100件。 */
var MAX_SELECT_OPTIONS = 100;

/** データベース一覧のキャッシュ有効期間（秒）。 */
var DATABASE_CACHE_TTL_SECONDS = 600;

/** モーダルを開いてから送信されるまでの猶予（秒）。 */
var CONTEXT_CACHE_TTL_SECONDS = 3600;

/** ユーザー名キャッシュの有効期間（秒）。 */
var USER_CACHE_TTL_SECONDS = 21600;

/**
 * スクリプトプロパティを設定オブジェクトに変換する。
 * @param {!Object<string,string>} props PropertiesService から読んだ生の値。
 * @return {!Object} 設定。
 */
function readConfig_(props) {
  props = props || {};
  var allowlist = String(props[PROP_KEYS.databaseAllowlist] || '')
      .split(',')
      .map(function (id) { return normalizeNotionId_(id); })
      .filter(function (id) { return !!id; });

  return {
    slackBotToken: String(props[PROP_KEYS.slackBotToken] || '').trim(),
    slackVerificationToken: String(props[PROP_KEYS.slackVerificationToken] || '').trim(),
    webhookSecret: String(props[PROP_KEYS.webhookSecret] || '').trim(),
    notionToken: String(props[PROP_KEYS.notionToken] || '').trim(),
    notionVersion: String(props[PROP_KEYS.notionVersion] || '').trim() || DEFAULT_NOTION_VERSION,
    databaseAllowlist: allowlist,
    urlPropertyName: String(props[PROP_KEYS.urlPropertyName] || '').trim(),
    databaseCacheRaw: props[PROP_KEYS.databaseCache] || ''
  };
}

/**
 * 必須設定が揃っているか調べる。
 * @param {!Object} config
 * @return {!Array<string>} 不足しているプロパティ名。
 */
function missingConfigKeys_(config) {
  var missing = [];
  if (!config.slackBotToken) missing.push(PROP_KEYS.slackBotToken);
  if (!config.slackVerificationToken) missing.push(PROP_KEYS.slackVerificationToken);
  if (!config.notionToken) missing.push(PROP_KEYS.notionToken);
  return missing;
}

/**
 * NotionのIDはハイフンあり/なしの両方が使われるので、比較用に正規化する。
 * @param {string} id
 * @return {string} 小文字・ハイフンなしのID。
 */
function normalizeNotionId_(id) {
  return String(id || '').trim().toLowerCase().replace(/-/g, '');
}
