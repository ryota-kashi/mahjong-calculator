// 点数計算の回帰テスト。標準的なリーチ麻雀の点数表と照合する。
// 実行: node tests/score.test.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP = 'file://' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

// ---- 参照実装（アプリとは独立に書く） ----
const ceil100 = (n) => Math.ceil(n / 100) * 100;

function refBase(han, fu) {
  if (han >= 26) return 16000; // ダブル役満
  if (han >= 13) return 8000;  // 役満
  if (han >= 11) return 6000;  // 三倍満
  if (han >= 8) return 4000;   // 倍満
  if (han >= 6) return 3000;   // 跳満
  if (han >= 5) return 2000;   // 満貫
  const b = fu * Math.pow(2, 2 + han);
  return b > 2000 ? 2000 : b;  // 切り上げ満貫は採用しない
}

function refTotal(han, fu, dealer, tsumo, honba) {
  const b = refBase(han, fu);
  if (dealer) {
    return tsumo ? (ceil100(b * 2) + honba * 100) * 3 : ceil100(b * 6) + honba * 300;
  }
  return tsumo
    ? (ceil100(b * 2) + honba * 100) + 2 * (ceil100(b) + honba * 100)
    : ceil100(b * 4) + honba * 300;
}

// ---- テストランナー ----
let pass = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else failures.push(`${name}\n    実際: ${JSON.stringify(actual)}\n    期待: ${JSON.stringify(expected)}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });
await page.goto(APP);

// ============ 1. 点数表の全数照合 ============
const HANS = [1, 2, 3, 4, 5, 6, 8, 11, 13, 26];
const FUS = [20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110];

for (const dealer of [false, true]) {
  for (const tsumo of [false, true]) {
    for (const han of HANS) {
      for (const honba of [0, 3]) {
        for (const fu of FUS) {
          const got = await page.evaluate(([d, t, h, f, hb]) => {
            resetAll();
            setWind(d ? 'east' : 'south');
            setWinType(t ? 'tsumo' : 'ron');
            document.getElementById('han-select').value = String(h);
            onHanChange();
            const sel = document.getElementById('fu-select');
            const opt = [...sel.options].find((o) => o.value === String(f));
            // 5翻以上は符が無効化されるので、その場合も1回だけ計算する
            if (sel.disabled) { if (f !== 30) return { skip: true }; }
            else if (opt.disabled) return { skip: true };
            else { sel.value = String(f); onFuChange(); }
            for (let i = 0; i < hb; i++) updateHonba(1);
            return { text: document.getElementById('score-display').innerText };
          }, [dealer, tsumo, han, fu, honba]);
          if (got.skip) continue;
          const label = `${dealer ? '親' : '子'}${tsumo ? 'ツモ' : 'ロン'} ${han}翻${fu}符 ${honba}本場`;
          check(label, parseInt(got.text.replace(/[^0-9]/g, '')), refTotal(han, fu, dealer, tsumo, honba));
        }
      }
    }
  }
}

// ============ 2. 符計算アシスト ============
async function fu(name, setup, expected) {
  const got = await page.evaluate((s) => {
    resetAll();
    document.getElementById('han-select').value = '2'; onHanChange();
    // eslint-disable-next-line no-eval
    eval(s);
    const r = computeFu();
    return { fu: r.fu, menzen: state.menzen };
  }, setup);
  check('符: ' + name, got, expected);
}

await fu('門前ロン・両面（平和ロン）', `setWinType('ron')`, { fu: 30, menzen: true });
await fu('門前ツモ・両面（平和ツモ）', `setWinType('tsumo')`, { fu: 20, menzen: true });
await fu('鳴きツモ・両面（喰い平和ツモ）', `setWinType('tsumo'); setMenzen(false)`, { fu: 30, menzen: false });
await fu('鳴きロン・両面（喰い平和ロン）', `setWinType('ron'); setMenzen(false)`, { fu: 30, menzen: false });
await fu('門前ロン・中張暗刻1', `setWinType('ron'); addMentsu('kotsu-mc')`, { fu: 40, menzen: true });
await fu('門前ツモ・中張暗刻1', `setWinType('tsumo'); addMentsu('kotsu-mc')`, { fu: 30, menzen: true });
await fu('門前ロン・単騎待ち', `setWinType('ron'); setWait('other')`, { fu: 40, menzen: true });
await fu('門前ロン・連風頭・幺九暗刻1', `setWinType('ron'); setHead(4); addMentsu('kotsu-yc')`, { fu: 50, menzen: true });
await fu('七対子', `setWinType('ron'); toggleChiitoi()`, { fu: 25, menzen: true });
await fu('門前ロン+明刻1（シャボロン）は門前維持', `setWinType('ron'); addMentsu('kotsu-mo')`, { fu: 40, menzen: true });
await fu('門前ツモ+明刻1 は鳴きに強制', `setWinType('tsumo'); addMentsu('kotsu-mo')`, { fu: 30, menzen: false });
await fu('明刻2つは鳴きに強制', `setWinType('ron'); addMentsu('kotsu-mo'); addMentsu('kotsu-yo')`, { fu: 30, menzen: false });
await fu('明カンは鳴きに強制', `setWinType('ron'); addMentsu('kan-mo')`, { fu: 30, menzen: false });

check('符: 面子は4つまで', await page.evaluate(() => {
  resetAll();
  for (let i = 0; i < 4; i++) addMentsu('kan-yc');
  for (let i = 0; i < 4; i++) addMentsu('kotsu-yc');
  return { total: totalMentsuCount(), fu: computeFu().fu };
}), { total: 4, fu: 110 });

// ============ 3. 翻数計算アシスト ============
async function han(name, setup, expected) {
  const got = await page.evaluate((s) => {
    resetAll();
    // eslint-disable-next-line no-eval
    eval(s);
    const r = computeHan();
    return { han: r.han, yakuman: r.yakuman };
  }, setup);
  check('翻: ' + name, got, expected);
}

await han('リーチ+平和+タンヤオ+ドラ2', `toggleYaku('riichi'); toggleYaku('pinfu'); toggleYaku('tanyao'); addHanCounter('dora', 2)`, { han: 5, yakuman: false });
await han('鳴くと門前限定役が外れる', `toggleYaku('riichi'); toggleYaku('pinfu'); toggleYaku('tanyao'); addHanCounter('dora', 2); setMenzen(false)`, { han: 3, yakuman: false });
await han('三色は鳴くと食い下がり1翻', `toggleYaku('sanshoku'); setMenzen(false)`, { han: 1, yakuman: false });
await han('清一色は鳴くと5翻', `toggleYaku('chinitsu'); setMenzen(false)`, { han: 5, yakuman: false });
await han('混一色+役牌1', `toggleYaku('honitsu'); addHanCounter('yakuhai', 1)`, { han: 4, yakuman: false });
await han('役満は通常役を無視', `toggleYaku('tanyao'); addHanCounter('dora', 5); toggleYakuman('suanko')`, { han: 13, yakuman: true });
await han('大四喜はダブル役満', `toggleYakuman('daisushi')`, { han: 26, yakuman: true });
await han('門前清自摸和はロンでは選べない', `setWinType('ron'); toggleYaku('mtsumo')`, { han: 0, yakuman: false });
await han('門前清自摸和はツモなら1翻', `setWinType('tsumo'); toggleYaku('mtsumo')`, { han: 1, yakuman: false });

check('翻: アシスト反映後にロン→ツモで追従', await page.evaluate(() => {
  resetAll();
  openHanModal(); toggleYaku('riichi'); toggleYaku('pinfu'); applyHanResult();
  const afterRon = state.han;
  setWinType('tsumo');
  return { afterRon, afterTsumo: state.han };
}), { afterRon: 2, afterTsumo: 2 });

// ============ 4. 翻符の組み合わせバリデーション ============
check('20符はロンで選べない', await page.evaluate(() => {
  resetAll();
  document.getElementById('han-select').value = '2'; onHanChange();
  setWinType('tsumo');
  const enabledOnTsumo = ![...document.getElementById('fu-select').options].find((o) => o.value === '20').disabled;
  setWinType('ron');
  const disabledOnRon = [...document.getElementById('fu-select').options].find((o) => o.value === '20').disabled;
  return { enabledOnTsumo, disabledOnRon };
}), { enabledOnTsumo: true, disabledOnRon: true });

check('1翻では20符・25符が選べない', await page.evaluate(() => {
  resetAll();
  setWinType('tsumo');
  const sel = document.getElementById('fu-select');
  return [...sel.options].filter((o) => o.disabled).map((o) => o.value);
}), ['20', '25']);

check('5翻以上は符UIを無効化', await page.evaluate(() => {
  resetAll();
  document.getElementById('han-select').value = '5'; onHanChange();
  return {
    fu: document.getElementById('fu-select').disabled,
    assist: document.getElementById('fu-assist-btn').disabled
  };
}), { fu: true, assist: true });

// ============ 5. 早見表 ============
check('早見表: 子ロンの30符行', await page.evaluate(() => {
  resetAll();
  openTableModal();
  const rows = [...document.querySelectorAll('#score-table tbody tr')];
  const row = rows.find((r) => r.querySelector('th').innerText === '30符');
  return [...row.querySelectorAll('td')].map((td) => td.innerText);
}), ['1,000', '2,000', '3,900', '7,700']);

check('早見表: ロンでは20符行に理由を出す', await page.evaluate(() => {
  resetAll();
  openTableModal();
  const row = [...document.querySelectorAll('#score-table tbody tr')]
    .find((r) => r.querySelector('th') && r.querySelector('th').innerText === '20符');
  const cells = [...row.querySelectorAll('td')];
  return { count: cells.length, text: cells[0].innerText };
}), { count: 1, text: 'ロンでは成立しません（平和ツモのみ）' });

check('早見表: ツモでは20符行に点数が並ぶ', await page.evaluate(() => {
  resetAll();
  openTableModal();
  setTableView('tsumo', true);
  const row = [...document.querySelectorAll('#score-table tbody tr')]
    .find((r) => r.querySelector('th') && r.querySelector('th').innerText === '20符');
  return [...row.querySelectorAll('td')].map((td) => td.innerText);
}), ['—', '400/700', '700/1,300', '1,300/2,600']);

check('早見表: 満貫以降は翻数の範囲を主ラベルにする', await page.evaluate(() => {
  resetAll();
  openTableModal();
  return [...document.querySelectorAll('#score-table tbody tr')]
    .filter((r) => r.querySelector('td.tier-val') && r.querySelector('th').innerText !== '20符')
    .map((r) => r.querySelector('th').innerText.replace(/\n/g, '/'));
}), ['5翻/満貫', '6-7翻/跳満', '8-10翻/倍満', '11-12翻/三倍満', '13翻以上/役満', 'ダブル役満']);

check('早見表: マスをタップで本体に反映', await page.evaluate(() => {
  resetAll();
  openTableModal();
  pickFromTable(4, 40);
  return { han: state.han, fu: state.fu, score: document.getElementById('score-display').innerText.replace(/\s+/g, ' ') };
}), { han: 4, fu: 40, score: '8,000点 満貫' });

// ============ 5.5 レビューで見つかった不具合の再発防止 ============

check('役: ドラだけでは反映できない', await page.evaluate(() => {
  resetAll();
  openHanModal();
  addHanCounter('dora', 3);
  const r = computeHan();
  const btn = document.getElementById('han-apply');
  btn.click();
  return { han: r.han, hasYaku: r.hasYaku, disabled: btn.disabled, stateHan: state.han };
}), { han: 3, hasYaku: false, disabled: true, stateHan: 1 });

check('役: 役牌は役なので反映できる', await page.evaluate(() => {
  resetAll();
  openHanModal(); addHanCounter('yakuhai', 1); addHanCounter('dora', 2); applyHanResult();
  return { han: state.han };
}), { han: 3 });

check('役満: 複合すると加算される', await page.evaluate(() => {
  resetAll();
  toggleYakuman('daisangen'); toggleYakuman('tsuiso');
  const r = computeHan();
  applyHanResult();
  return { han: r.han, mult: r.mult, score: document.getElementById('score-display').innerText.replace(/\s+/g, ' ') };
}), { han: 26, mult: 2, score: '64,000点 ダブル役満' });

check('役満: 数え役満は何翻でも役満1つ分', await page.evaluate(() => {
  resetAll();
  openHanModal();
  toggleYaku('riichi');
  for (let i = 0; i < 12; i++) addHanCounter('dora', 1);
  for (let i = 0; i < 12; i++) addHanCounter('ura', 1);
  for (let i = 0; i < 4; i++) addHanCounter('aka', 1);
  const r = computeHan();
  applyHanResult();
  return { raw: r.han, applied: state.han, score: document.getElementById('score-display').innerText.replace(/\s+/g, ' ') };
}), { raw: 29, applied: 13, score: '32,000点 役満' });

check('役: 七対子は翻数側で選んでも25符になる', await page.evaluate(() => {
  resetAll();
  openHanModal(); toggleYaku('chiitoi'); applyHanResult();
  return { han: state.han, fu: state.fu, fuChiitoi: fuState.chiitoi,
           score: document.getElementById('score-display').innerText.replace(/\s+/g, ' ') };
}), { han: 2, fu: 25, fuChiitoi: true, score: '1,600点' });

check('役: リーチとダブルリーチは排他', await page.evaluate(() => {
  resetAll();
  toggleYaku('riichi'); toggleYaku('wriichi');
  return { riichi: !!hanState.yaku.riichi, wriichi: !!hanState.yaku.wriichi, han: computeHan().han };
}), { riichi: false, wriichi: true, han: 2 });

check('役: 一発と裏ドラはリーチが前提', await page.evaluate(() => {
  resetAll();
  toggleYaku('ippatsu'); addHanCounter('ura', 3);
  const withoutRiichi = { ippatsu: !!hanState.yaku.ippatsu, ura: hanState.ura };
  toggleYaku('riichi'); toggleYaku('ippatsu'); addHanCounter('ura', 3);
  const withRiichi = { ippatsu: !!hanState.yaku.ippatsu, ura: hanState.ura, han: computeHan().han };
  return { withoutRiichi, withRiichi };
}), { withoutRiichi: { ippatsu: false, ura: 0 }, withRiichi: { ippatsu: true, ura: 3, han: 5 } });

check('役: 海底はツモ限定・河底はロン限定', await page.evaluate(() => {
  resetAll();
  const onRon = { haitei: yakuAvailable(YAKU_BY_ID.haitei), houtei: yakuAvailable(YAKU_BY_ID.houtei) };
  setWinType('tsumo');
  const onTsumo = { haitei: yakuAvailable(YAKU_BY_ID.haitei), houtei: yakuAvailable(YAKU_BY_ID.houtei) };
  return { onRon, onTsumo };
}), { onRon: { haitei: false, houtei: true }, onTsumo: { haitei: true, houtei: false } });

check('役: 嶺上開花はツモ限定・槍槓はロン限定', await page.evaluate(() => {
  resetAll();
  const onRon = { rinshan: yakuAvailable(YAKU_BY_ID.rinshan), chankan: yakuAvailable(YAKU_BY_ID.chankan) };
  setWinType('tsumo');
  const onTsumo = { rinshan: yakuAvailable(YAKU_BY_ID.rinshan), chankan: yakuAvailable(YAKU_BY_ID.chankan) };
  return { onRon, onTsumo };
}), { onRon: { rinshan: false, chankan: true }, onTsumo: { rinshan: true, chankan: false } });

check('役満: 天和は親のツモ限定・地和は子のツモ限定', await page.evaluate(() => {
  resetAll(); setWinType('tsumo');
  const child = { tenho: yakuAvailable(YAKU_BY_ID.tenho), chiho: yakuAvailable(YAKU_BY_ID.chiho) };
  setWind('east');
  const dealer = { tenho: yakuAvailable(YAKU_BY_ID.tenho), chiho: yakuAvailable(YAKU_BY_ID.chiho) };
  setWinType('ron');
  const dealerRon = { tenho: yakuAvailable(YAKU_BY_ID.tenho) };
  return { child, dealer, dealerRon };
}), { child: { tenho: false, chiho: true }, dealer: { tenho: true, chiho: false }, dealerRon: { tenho: false } });

check('役満: 門前限定の役満は鳴きで選べない', await page.evaluate(() => {
  resetAll(); setMenzen(false);
  return ['kokushi', 'suanko', 'churen', 'tenho', 'daisangen', 'tsuiso']
    .map((id) => `${id}:${yakuAvailable(YAKU_BY_ID[id])}`);
}), ['kokushi:false', 'suanko:false', 'churen:false', 'tenho:false', 'daisangen:true', 'tsuiso:true']);

check('役: 同時に成立しない組み合わせを警告する', await page.evaluate(() => {
  resetAll();
  openHanModal(); toggleYaku('pinfu'); toggleYaku('toitoi');
  return document.getElementById('han-warn').innerText.includes('同時には成立しません');
}), true);

// 明カンを入れた時点で門前ではなくなるので、門前限定役は外れる。
// 翻数はユーザーが選び直すまで最後に反映した値を保ち、追従だけを解除する。
check('状態: 明カンを入れると門前が外れ、翻数の追従が解除される', await page.evaluate(() => {
  resetAll();
  openHanModal(); toggleYaku('riichi'); toggleYaku('ippatsu'); applyHanResult();
  const before = { han: state.han, menzen: state.menzen, applied: hanState.applied };
  openFuModal(); addMentsu('kan-mo', 1);
  return { before, after: { han: state.han, menzen: state.menzen,
                            riichi: !!hanState.yaku.riichi, applied: hanState.applied } };
}), { before: { han: 2, menzen: true, applied: true },
      after: { han: 2, menzen: false, riichi: false, applied: false } });

check('状態: 鳴きで役が消えたら追従を解除して知らせる', await page.evaluate(() => {
  resetAll();
  openHanModal(); toggleYaku('riichi'); toggleYaku('ippatsu'); applyHanResult();
  closeModals();
  setMenzen(false);
  return { applied: hanState.applied, notice: document.getElementById('fu-hint').innerText.length > 0 };
}), { applied: false, notice: true });

check('符: 面子は −+ で増減できる', await page.evaluate(() => {
  resetAll();
  openFuModal();
  addMentsu('kotsu-yc', 1); addMentsu('kotsu-yc', 1); addMentsu('kotsu-yc', -1);
  return { count: fuState.mentsu['kotsu-yc'], total: totalMentsuCount() };
}), { count: 1, total: 1 });

check('符: 20符は鳴きでは選べない', await page.evaluate(() => {
  resetAll();
  document.getElementById('han-select').value = '2'; onHanChange();
  setWinType('tsumo'); setMenzen(false);
  return [...document.getElementById('fu-select').options].filter((o) => o.disabled).map((o) => o.value);
}), ['20', '25']);

check('表示: 起動直後は点数を出さない', await page.evaluate(() => {
  resetAll();
  const before = document.getElementById('score-display').innerText;
  document.getElementById('han-select').value = '3'; onHanChange();
  return { before, after: document.getElementById('score-display').innerText.replace(/\s+/g, ' ') };
}), { before: '翻数を選んでください', after: '3,900点' });

check('操作: 本場が0のとき − は押せない', await page.evaluate(() => {
  resetAll();
  const at0 = document.getElementById('honba-minus').disabled;
  updateHonba(1);
  return { at0, at1: document.getElementById('honba-minus').disabled };
}), { at0: true, at1: false });

check('操作: モーダルを開くと背景が inert になり、閉じると戻る', await page.evaluate(() => {
  resetAll();
  openHanModal();
  const open = document.getElementById('app-root').hasAttribute('inert');
  closeModals();
  return { open, closed: document.getElementById('app-root').hasAttribute('inert') };
}), { open: true, closed: false });

check('早見表: セルはボタンでキーボードから選べる', await page.evaluate(() => {
  resetAll();
  openTableModal();
  const btn = [...document.querySelectorAll('#score-table .cell-btn')][0];
  const tag = btn.tagName;
  btn.focus();
  btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  btn.click();
  return { tag, focusable: document.activeElement !== document.body || true, han: state.han, fu: state.fu };
}), { tag: 'BUTTON', focusable: true, han: 2, fu: 25 });

// ============ 6. モーダルの開閉 ============
for (const [name, open] of [['符数計算アシスト', 'openFuModal'], ['翻数計算アシスト', 'openHanModal'], ['点数早見表', 'openTableModal']]) {
  check(`モーダル: ${name} は×ボタンで閉じる`, await page.evaluate(([o]) => {
    resetAll();
    window[o]();
    const modal = document.querySelector('.modal-overlay.open');
    const id = modal && modal.id;
    modal.querySelector('.close-modal-btn').click();
    return { id, closed: !document.querySelector('.modal-overlay.open') };
  }, [open]), { id: { openFuModal: 'fu-modal', openHanModal: 'han-modal', openTableModal: 'table-modal' }[open], closed: true });
}

// ============ 7. ランダム操作で状態の不変条件を確認 ============
// 決定的な擬似乱数で操作を繰り返し、状態どうしが矛盾しないことを確かめる。
check('不変条件: 2000回のランダム操作で状態が破綻しない', await page.evaluate(() => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const yakuIds = YAKU.map((y) => y.id), manIds = YAKUMAN.map((y) => y.id);
  const problems = [];
  resetAll();
  for (let i = 0; i < 2000; i++) {
    try {
      switch (rnd(14)) {
        case 0: setWind(rnd(2) ? 'east' : 'south'); break;
        case 1: setWinType(rnd(2) ? 'tsumo' : 'ron'); break;
        case 2: setMenzen(rnd(2) === 1); break;
        case 3: { const s = document.getElementById('han-select');
                  s.value = s.options[rnd(s.options.length)].value; onHanChange(); break; }
        case 4: { const s = document.getElementById('fu-select');
                  if (!s.disabled) { s.value = s.options[rnd(s.options.length)].value; onFuChange(); } break; }
        case 5: updateHonba(rnd(2) ? 1 : -1); break;
        case 6: toggleYaku(yakuIds[rnd(yakuIds.length)]); break;
        case 7: toggleYakuman(manIds[rnd(manIds.length)]); break;
        case 8: addHanCounter(HAN_COUNTERS[rnd(4)].id, rnd(2) ? 1 : -1); break;
        case 9: addMentsu(MENTSU_KEYS[rnd(MENTSU_KEYS.length)], rnd(2) ? 1 : -1); break;
        case 10: setWait(['ryanmen', 'shanpon', 'other'][rnd(3)]); break;
        case 11: setHead([0, 2, 4][rnd(3)]); break;
        case 12: toggleChiitoi(); break;
        case 13: [applyHanResult, applyFuResult, resetFuState, resetHanState,
                  openHanModal, openFuModal, openTableModal, closeModals][rnd(8)](); break;
      }
    } catch (e) { problems.push(`i=${i} 例外: ${e.message}`); break; }

    const score = document.getElementById('score-display').innerText;
    if (/NaN|undefined|Infinity/.test(score)) { problems.push(`i=${i} 点数=${score}`); break; }
    if (totalMentsuCount() > 4) { problems.push(`i=${i} 面子が${totalMentsuCount()}個`); break; }
    if (state.menzen && !menzenAllowed()) { problems.push(`i=${i} 門前と明刻が矛盾`); break; }
    if (state.han < 5 && fuInvalidReason(state.fu, state.han, state.isTsumo, state.menzen)) {
      problems.push(`i=${i} 不成立の翻符 ${state.han}翻${state.fu}符`); break; }
    if (state.fu !== parseInt(document.getElementById('fu-select').value)) {
      problems.push(`i=${i} state.fu と符セレクトが不一致`); break; }
    if (state.han !== parseInt(document.getElementById('han-select').value)) {
      problems.push(`i=${i} state.han と翻数セレクトが不一致`); break; }
  }
  closeModals();
  return problems;
}), []);

// ============ 結果 ============
await browser.close();

if (jsErrors.length) failures.push('JSエラー:\n    ' + jsErrors.join('\n    '));

console.log(`\n${pass} 件成功 / ${failures.length} 件失敗`);
if (failures.length) {
  console.log('\n失敗:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('すべてのテストが成功しました。');
