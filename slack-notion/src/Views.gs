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
  var options = databases.slice(0, MAX_SELECT_OPTIONS).map(databaseToOption_);

  var blocks = [];
  var preview = truncate_(slackTextToPlain_(previewText).replace(/\s+/g, ' ').trim(), 300);
  if (preview) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '> ' + preview }
    });
  }
  var element = {
    type: 'static_select',
    action_id: DATABASE_ACTION_ID,
    placeholder: { type: 'plain_text', text: 'データベースを選択', emoji: true },
    options: options
  };
  // 登録が1件だけなら選ぶ手間をなくす。
  if (options.length === 1) element.initial_option = options[0];
  blocks.push({
    type: 'input',
    block_id: DATABASE_BLOCK_ID,
    label: { type: 'plain_text', text: '追加先のデータベース', emoji: true },
    element: element
  });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '候補は ⚡ メニューの「Notion DBの設定」で変えられます。'
    }]
  });

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
 * 追加先データベースを登録する設定モーダル。
 * @param {!Array<!Object>} catalog 選べるデータベース全体。
 * @param {!Array<string>} selectedIds 現在の登録内容。
 * @return {!Object}
 */
function buildSettingsModal_(catalog, selectedIds) {
  var options = catalog.slice(0, MAX_SELECT_OPTIONS).map(databaseToOption_);

  // initial_options は options に含まれる値しか渡せない。
  // 共有を外されたデータベースがここで自然に落ちる。
  var byId = {};
  options.forEach(function (option) { byId[normalizeNotionId_(option.value)] = option; });
  var initialOptions = [];
  (selectedIds || []).forEach(function (id) {
    var option = byId[normalizeNotionId_(id)];
    if (option) initialOptions.push(option);
  });

  var element = {
    type: 'multi_static_select',
    action_id: SETTINGS_ACTION_ID,
    placeholder: { type: 'plain_text', text: 'データベースを選択', emoji: true },
    options: options
  };
  if (initialOptions.length) element.initial_options = initialOptions;

  var blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'メッセージの […] →「Notionに追加」で選べるデータベースを登録します。\n' +
            'ここでの登録は *あなた個人* のもので、ほかの人には影響しません。'
      }
    },
    {
      type: 'input',
      block_id: SETTINGS_BLOCK_ID,
      optional: true,
      label: { type: 'plain_text', text: 'よく使うデータベース', emoji: true },
      element: element
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'Notionのインテグレーションに共有されているデータベースだけが表示されます。' +
            'すべて外すと登録を解除できます。'
      }]
    }
  ];
  if (catalog.length > MAX_SELECT_OPTIONS) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '最近更新された' + MAX_SELECT_OPTIONS + '件のみ表示しています。'
      }]
    });
  }

  return {
    type: 'modal',
    callback_id: SETTINGS_MODAL_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Notion DBの設定', emoji: true },
    submit: { type: 'plain_text', text: '保存', emoji: true },
    close: { type: 'plain_text', text: 'キャンセル', emoji: true },
    blocks: blocks
  };
}

/**
 * 保存後に見せる確認モーダル。
 * @param {!Array<!Object>} databases 登録されたデータベース。
 * @return {!Object}
 */
function buildSettingsSavedModal_(databases) {
  var blocks;
  if (databases.length) {
    var names = databases.map(function (database) {
      return '• ' + database.title;
    }).join('\n');
    blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✅ ' + databases.length + '件のデータベースを登録しました。\n' + truncate_(names, 2500)
        }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'メッセージの […] →「Notionに追加」から使えます。'
        }]
      }
    ];
  } else {
    blocks = [{
      type: 'section',
      text: { type: 'mrkdwn', text: '登録を解除しました。追加先の候補は表示されなくなります。' }
    }];
  }
  return {
    type: 'modal',
    title: { type: 'plain_text', text: '保存しました', emoji: true },
    close: { type: 'plain_text', text: '閉じる', emoji: true },
    blocks: blocks
  };
}

/**
 * 未登録の人に見せる案内モーダル。ここから設定モーダルを開ける。
 * @return {!Object}
 */
function buildRegistrationNoticeModal_() {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: '追加先が未登録です', emoji: true },
    close: { type: 'plain_text', text: '閉じる', emoji: true },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'まだ追加先のNotionデータベースを登録していません。\n' +
              '下のボタンから、よく使うデータベースを登録してください。'
        }
      },
      {
        type: 'actions',
        block_id: 'registration_notice',
        elements: [{
          type: 'button',
          action_id: OPEN_SETTINGS_ACTION_ID,
          style: 'primary',
          text: { type: 'plain_text', text: 'データベースを登録', emoji: true }
        }]
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'あとから ⚡ メニューの「Notion DBの設定」でも変更できます。'
        }]
      }
    ]
  };
}

/**
 * 作成完了の通知。あとから直せるよう「修正する」ボタンを付ける。
 * @param {string} text 本文（mrkdwn）。
 * @param {!Object} target {pageId, databaseId, title, dueDate}
 * @return {!Array<!Object>}
 */
function buildCreatedBlocks_(text, target) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text } },
    {
      type: 'actions',
      block_id: 'created_task',
      elements: [{
        type: 'button',
        action_id: EDIT_ACTION_ID,
        text: { type: 'plain_text', text: '修正する', emoji: true },
        value: JSON.stringify({
          p: target.pageId,
          d: target.databaseId,
          t: truncate_(target.title || '', TITLE_MAX_LENGTH),
          u: target.dueDate || ''
        })
      }]
    }
  ];
}

/**
 * タスク名と期限を直すモーダル。
 * @param {!Object} current {pageId, databaseId, title, dueDate, responseUrl}
 * @param {boolean} hasDueProperty 追加先に日付列があるか。
 * @return {!Object}
 */
function buildEditModal_(current, hasDueProperty) {
  var blocks = [{
    type: 'input',
    block_id: EDIT_TITLE_BLOCK_ID,
    label: { type: 'plain_text', text: 'タスク名', emoji: true },
    element: {
      type: 'plain_text_input',
      action_id: EDIT_TITLE_ACTION_ID,
      initial_value: truncate_(current.title || '', TITLE_MAX_LENGTH),
      max_length: TITLE_MAX_LENGTH
    }
  }];

  if (hasDueProperty) {
    var datepicker = {
      type: 'datepicker',
      action_id: EDIT_DUE_ACTION_ID,
      placeholder: { type: 'plain_text', text: '期限を選択', emoji: true }
    };
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(current.dueDate || ''))) {
      datepicker.initial_date = current.dueDate;
    }
    blocks.push({
      type: 'input',
      block_id: EDIT_DUE_BLOCK_ID,
      optional: true,
      label: { type: 'plain_text', text: '期限', emoji: true },
      element: datepicker
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '空にして保存すると期限を消せます。' }]
    });
  }

  return {
    type: 'modal',
    callback_id: EDIT_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      p: current.pageId,
      d: current.databaseId,
      r: current.responseUrl || ''
    }),
    title: { type: 'plain_text', text: 'タスクを修正', emoji: true },
    submit: { type: 'plain_text', text: '保存', emoji: true },
    close: { type: 'plain_text', text: 'キャンセル', emoji: true },
    blocks: blocks
  };
}

/**
 * 修正モーダルの入力を読む。
 * @param {!Object} view
 * @return {{title: string, dueDate: string}}
 */
function readEditedTask_(view) {
  var state = (view && view.state && view.state.values) || {};
  var title = (((state[EDIT_TITLE_BLOCK_ID] || {})[EDIT_TITLE_ACTION_ID]) || {}).value || '';
  var due = (((state[EDIT_DUE_BLOCK_ID] || {})[EDIT_DUE_ACTION_ID]) || {}).selected_date || '';
  return {
    title: String(title).replace(/\s+/g, ' ').trim(),
    dueDate: String(due || '')
  };
}

/**
 * データベースをセレクトの選択肢に変換する。
 * @param {!Object} database
 * @return {!Object}
 */
function databaseToOption_(database) {
  return {
    text: { type: 'plain_text', text: truncate_(database.title, 75), emoji: true },
    value: database.id
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

/**
 * 設定モーダルから、登録されたデータベースIDを取り出す。
 * @param {!Object} view
 * @return {!Array<string>}
 */
function readRegisteredDatabaseIds_(view) {
  var state = (view && view.state && view.state.values) || {};
  var block = state[SETTINGS_BLOCK_ID] || {};
  var action = block[SETTINGS_ACTION_ID] || {};
  var selected = action.selected_options || [];
  return selected.map(function (option) {
    return String((option && option.value) || '');
  }).filter(function (value) { return !!value; });
}
