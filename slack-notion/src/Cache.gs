/**
 * キャッシュ。Slackの3秒制限に間に合わせるため、モーダルを開く経路では
 * できるだけ外部APIを呼ばずキャッシュから引く。
 */

/**
 * @param {string} key
 * @return {?Object}
 */
function readCache_(key) {
  try {
    var raw = CacheService.getScriptCache().get(key);
    return raw ? safeJsonParse_(raw) : null;
  } catch (err) {
    return null;
  }
}

/**
 * @param {string} key
 * @param {!Object} value
 * @param {number} ttlSeconds
 */
function writeCache_(key, value, ttlSeconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    logError_('キャッシュの書き込みに失敗: ' + key, err);
  }
}

var DATABASE_CACHE_KEY = 'notion_databases';

/**
 * 許可リストが設定されていれば、そのデータベースだけに絞る。
 * @param {!Object} config
 * @param {!Array<!Object>} databases
 * @return {!Array<!Object>}
 */
function applyAllowlist_(config, databases) {
  if (!config.databaseAllowlist.length) return databases;
  var allowed = {};
  for (var i = 0; i < config.databaseAllowlist.length; i++) {
    allowed[config.databaseAllowlist[i]] = true;
  }
  return databases.filter(function (database) {
    return allowed[normalizeNotionId_(database.id)] === true;
  });
}

/**
 * データベース一覧を返す。
 * CacheService → スクリプトプロパティ → Notion API の順に見る。
 * @param {!Object} config
 * @return {!Array<!Object>}
 */
function getDatabases_(config) {
  var cached = readCache_(DATABASE_CACHE_KEY);
  if (cached && cached.databases && cached.databases.length) {
    return applyAllowlist_(config, cached.databases);
  }

  var stored = safeJsonParse_(config.databaseCacheRaw);
  if (stored && stored.databases && stored.databases.length) {
    writeCache_(DATABASE_CACHE_KEY, stored, DATABASE_CACHE_TTL_SECONDS);
    return applyAllowlist_(config, stored.databases);
  }

  var refreshed = refreshDatabases_(config);
  return applyAllowlist_(config, refreshed.databases);
}

/**
 * Notionを実際に検索して一覧を作り直し、両方のキャッシュに書く。
 * @param {!Object} config
 * @return {{ok: boolean, error: string, databases: !Array<!Object>}}
 */
function refreshDatabases_(config) {
  var result = searchNotionDatabases_(config);
  if (!result.ok) {
    logError_('Notionのデータベース検索に失敗: ' + result.error, null);
    return result;
  }
  var snapshot = { updatedAt: new Date().toISOString(), databases: result.databases };
  writeCache_(DATABASE_CACHE_KEY, snapshot, DATABASE_CACHE_TTL_SECONDS);
  try {
    PropertiesService.getScriptProperties()
        .setProperty(PROP_KEYS.databaseCache, JSON.stringify(snapshot));
  } catch (err) {
    logError_('データベース一覧の保存に失敗', err);
  }
  return result;
}

/**
 * IDからデータベースを1件引く。キャッシュに無ければ作り直して再度探す。
 * @param {!Object} config
 * @param {string} databaseId
 * @return {?Object}
 */
function findDatabase_(config, databaseId) {
  var target = normalizeNotionId_(databaseId);
  var found = pickDatabase_(getDatabases_(config), target);
  if (found) return found;
  return pickDatabase_(applyAllowlist_(config, refreshDatabases_(config).databases), target);
}

/**
 * @param {!Array<!Object>} databases
 * @param {string} normalizedId
 * @return {?Object}
 */
function pickDatabase_(databases, normalizedId) {
  for (var i = 0; i < databases.length; i++) {
    if (normalizeNotionId_(databases[i].id) === normalizedId) return databases[i];
  }
  return null;
}
