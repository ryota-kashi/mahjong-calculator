/**
 * 利用者ごとの「追加先データベース」の登録。
 *
 * 登録はSlackユーザーIDごとにスクリプトプロパティへ持つ。
 * 登録していない人には候補を出さず、登録を促す案内だけを見せる。
 */

/**
 * @param {string} userId SlackのユーザーID。
 * @return {string} スクリプトプロパティのキー。
 */
function userPropertyKey_(userId) {
  return USER_PROPERTY_PREFIX + String(userId || '');
}

/**
 * 利用者が登録しているデータベースIDを返す。
 * @param {!Object} config
 * @param {string} userId
 * @return {!Array<string>} 登録順のID。未登録なら空配列。
 */
function readUserDatabaseIds_(config, userId) {
  if (!userId) return [];
  var stored = safeJsonParse_((config.properties || {})[userPropertyKey_(userId)]);
  if (!stored || !stored.ids || !stored.ids.length) return [];
  return stored.ids.map(String);
}

/**
 * 利用者の登録内容を保存する。
 * @param {string} userId
 * @param {!Array<string>} databaseIds
 */
function saveUserDatabaseIds_(userId, databaseIds) {
  var key = userPropertyKey_(userId);
  var properties = PropertiesService.getScriptProperties();
  if (!databaseIds.length) {
    properties.deleteProperty(key);
    return;
  }
  properties.setProperty(key, JSON.stringify({
    ids: databaseIds,
    updatedAt: new Date().toISOString()
  }));
}

/**
 * 登録されたIDを、実在するデータベースの情報に引き当てる。
 * Notion側で共有を外されたものは自然に落ちる。
 * @param {!Array<!Object>} catalog 選択できるデータベース全体。
 * @param {!Array<string>} databaseIds 登録されたID。
 * @return {!Array<!Object>} 登録順に並んだデータベース。
 */
function filterDatabasesByIds_(catalog, databaseIds) {
  var byId = {};
  for (var i = 0; i < catalog.length; i++) {
    byId[normalizeNotionId_(catalog[i].id)] = catalog[i];
  }
  var databases = [];
  for (var j = 0; j < databaseIds.length; j++) {
    var database = byId[normalizeNotionId_(databaseIds[j])];
    if (database) databases.push(database);
  }
  return databases;
}

/**
 * 利用者が選べるデータベースを返す。
 * @param {!Object} config
 * @param {string} userId
 * @return {!Array<!Object>}
 */
function getUserDatabases_(config, userId) {
  var ids = readUserDatabaseIds_(config, userId);
  if (!ids.length) return [];
  return filterDatabasesByIds_(getDatabases_(config), ids);
}

/**
 * 利用者が登録しているデータベースを1件引く。
 * 直前に共有されたばかりで一覧のキャッシュに載っていない場合に備え、
 * 見つからなければ一度だけ取り直す。
 * @param {!Object} config
 * @param {string} userId
 * @param {string} databaseId
 * @return {?Object}
 */
function findUserDatabase_(config, userId, databaseId) {
  var target = normalizeNotionId_(databaseId);
  var found = pickDatabase_(getUserDatabases_(config, userId), target);
  if (found) return found;

  refreshDatabases_(config);
  return pickDatabase_(getUserDatabases_(config, userId), target);
}

/**
 * 登録している利用者の一覧（管理用）。
 * @param {!Object} config
 * @return {!Array<{userId: string, ids: !Array<string>, updatedAt: string}>}
 */
function listRegisteredUsers_(config) {
  var properties = config.properties || {};
  var users = [];
  for (var key in properties) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
    if (key.indexOf(USER_PROPERTY_PREFIX) !== 0) continue;
    var stored = safeJsonParse_(properties[key]) || {};
    users.push({
      userId: key.slice(USER_PROPERTY_PREFIX.length),
      ids: stored.ids || [],
      updatedAt: stored.updatedAt || ''
    });
  }
  return users;
}
