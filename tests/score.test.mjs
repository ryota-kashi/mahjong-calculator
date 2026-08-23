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

check('早見表: マスをタップで本体に反映', await page.evaluate(() => {
  resetAll();
  openTableModal();
  pickFromTable(4, 40);
  return { han: state.han, fu: state.fu, score: document.getElementById('score-display').innerText.replace(/\s+/g, ' ') };
}), { han: 4, fu: 40, score: '8,000点 (満貫)' });

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
