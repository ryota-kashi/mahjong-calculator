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
  duePropertyName: 'NOTION_DUE_PROPERTY',
  assigneePropertyName: 'NOTION_ASSIGNEE_PROPERTY',
  priorityPropertyName: 'NOTION_PRIORITY_PROPERTY',
  notionUserCache: 'NOTION_USER_CACHE',
  geminiApiKey: 'GEMINI_API_KEY',
  geminiModel: 'GEMINI_MODEL',
  geminiThinkingBudget: 'GEMINI_THINKING_BUDGET',
  databaseCache: 'DATABASE_CACHE'
};

/** タスク名と期限の抽出に使うモデル。プロパティで上書きできる。 */
var DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * 思考トークンの上限。抽出だけなので既定では思考させない（そのぶん速い）。
 * -1 を設定すると thinkingConfig 自体を送らない（モデルの既定に任せる）。
 */
var DEFAULT_THINKING_BUDGET = 0;

/** Notion API のバージョン。プロパティで上書きできる。 */
var DEFAULT_NOTION_VERSION = '2022-06-28';

/** ショートカットの callback_id（Slackアプリのマニフェストと合わせる）。 */
var SHORTCUT_CALLBACK_ID = 'add_to_notion';
var SETTINGS_SHORTCUT_CALLBACK_ID = 'manage_notion_databases';

/** タスク追加モーダルの callback_id / block_id / action_id。 */
var MODAL_CALLBACK_ID = 'create_notion_task';
var DATABASE_BLOCK_ID = 'database';
var DATABASE_ACTION_ID = 'database_select';

/** 設定モーダルの callback_id / block_id / action_id。 */
var SETTINGS_MODAL_CALLBACK_ID = 'save_notion_databases';
var SETTINGS_BLOCK_ID = 'databases';
var SETTINGS_ACTION_ID = 'databases_select';
var OPEN_SETTINGS_ACTION_ID = 'open_settings';

/** 作成後の修正モーダル。 */
var EDIT_ACTION_ID = 'edit_task';
var EDIT_MODAL_CALLBACK_ID = 'edit_notion_task';
var EDIT_TITLE_BLOCK_ID = 'task_title';
var EDIT_TITLE_ACTION_ID = 'task_title_input';
var EDIT_DUE_BLOCK_ID = 'task_due';
var EDIT_DUE_ACTION_ID = 'task_due_input';

/** 利用者ごとの登録内容を入れるスクリプトプロパティの接頭辞。 */
var USER_PROPERTY_PREFIX = 'USER_DATABASES_';

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
    duePropertyName: String(props[PROP_KEYS.duePropertyName] || '').trim(),
    assigneePropertyName: String(props[PROP_KEYS.assigneePropertyName] || '').trim(),
    priorityPropertyName: String(props[PROP_KEYS.priorityPropertyName] || '').trim(),
    geminiApiKey: String(props[PROP_KEYS.geminiApiKey] || '').trim(),
    geminiModel: String(props[PROP_KEYS.geminiModel] || '').trim() || DEFAULT_GEMINI_MODEL,
    geminiThinkingBudget: readThinkingBudget_(props[PROP_KEYS.geminiThinkingBudget]),
    databaseCacheRaw: props[PROP_KEYS.databaseCache] || '',
    notionUserCacheRaw: props[PROP_KEYS.notionUserCache] || '',
    // 利用者ごとの登録内容を引くために、読み込んだプロパティをそのまま持っておく。
    // doPost で1回だけ読むので、ここから引く限り追加の呼び出しは発生しない。
    properties: props
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
 * @param {?string} value スクリプトプロパティの値。
 * @return {number} 思考トークンの上限。負値なら送らない。
 */
function readThinkingBudget_(value) {
  var text = String(value == null ? '' : value).trim();
  if (!text) return DEFAULT_THINKING_BUDGET;
  var budget = parseInt(text, 10);
  return isNaN(budget) ? DEFAULT_THINKING_BUDGET : budget;
}

/**
 * NotionのIDはハイフンあり/なしの両方が使われるので、比較用に正規化する。
 * @param {string} id
 * @return {string} 小文字・ハイフンなしのID。
 */
function normalizeNotionId_(id) {
  return String(id || '').trim().toLowerCase().replace(/-/g, '');
}
