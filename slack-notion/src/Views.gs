/**
 * Slackのモーダル（Block Kit）の組み立て。すべて純粋関数。
 */

/**
 * データベースを選ぶモーダル。
 * @param {!Array<!Object>} databases
 * @param {string} privateMetadata view_submission に引き継ぐ情報（JSON文字列）。
 * @param {string} previewText 追加されるメッセージのプレビュー。
 * @return {!Object}
 */
function buildTaskModal_(databases, privateMetadata, previewText) {
  var options = databases.slice(0, MAX_SELECT_OPTIONS).map(function (database) {
    return {
      text: { type: 'plain_text', text: truncate_(database.title, 75), emoji: true },
      value: database.id
    };
  });

  var blocks = [];
  var preview = truncate_(slackTextToPlain_(previewText).replace(/\s+/g, ' ').trim(), 300);
  if (preview) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '> ' + preview }
    });
  }
  blocks.push({
    type: 'input',
    block_id: DATABASE_BLOCK_ID,
    label: { type: 'plain_text', text: '追加先のデータベース', emoji: true },
    element: {
      type: 'static_select',
      action_id: DATABASE_ACTION_ID,
      placeholder: { type: 'plain_text', text: 'データベースを選択', emoji: true },
      options: options
    }
  });
  if (databases.length > MAX_SELECT_OPTIONS) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '最近更新された' + MAX_SELECT_OPTIONS + '件のみ表示しています。' +
            '`NOTION_DATABASE_ALLOWLIST` で候補を絞れます。'
      }]
    });
  }

  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Notionに追加', emoji: true },
    submit: { type: 'plain_text', text: '追加', emoji: true },
    close: { type: 'plain_text', text: 'キャンセル', emoji: true },
    blocks: blocks
  };
}

/**
 * 選択肢が出せないときに理由を伝えるモーダル。
 * @param {string} title
 * @param {string} message
 * @return {!Object}
 */
function buildNoticeModal_(title, message) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: truncate_(title, 24), emoji: true },
    close: { type: 'plain_text', text: '閉じる', emoji: true },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }]
  };
}

/**
 * モーダル内にエラーを表示するレスポンス。
 * @param {string} message
 * @return {!Object}
 */
function buildValidationError_(message) {
  var errors = {};
  errors[DATABASE_BLOCK_ID] = truncate_(message, 2000);
  return { response_action: 'errors', errors: errors };
}

/**
 * view_submission から選ばれたデータベースIDを取り出す。
 * @param {!Object} view
 * @return {string}
 */
function readSelectedDatabaseId_(view) {
  var state = (view && view.state && view.state.values) || {};
  var block = state[DATABASE_BLOCK_ID] || {};
  var action = block[DATABASE_ACTION_ID] || {};
  var selected = action.selected_option || {};
  return String(selected.value || '');
}
