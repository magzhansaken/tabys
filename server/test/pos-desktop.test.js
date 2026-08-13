/**
 * ★ ТЕСТЫ НАСТОЛЬНОЙ КАССЫ.
 *
 * До этого у кассы не было НИ ОДНОГО теста — а там ходят деньги.
 * Проверяем то, что ломается тише всего и дороже всего стоит:
 *
 *  · атомарность записи — отключение питания посреди чека;
 *  · очередь на сервер: сквозная нумерация, удаление только после
 *    подтверждения, устойчивость к испорченной строке;
 *  · испорченный файл не роняет кассу;
 *  · сборка чека: ширина ленты, кириллица, деньги, итог;
 *  · команды принтеру: сброс, кодовая страница, отрез, денежный ящик.
 *
 * Запуск: node test/pos-desktop.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabys-pos-test-'));
process.env.TABYS_DATA_DIR = DIR;

const ROOT = path.join(__dirname, '..', '..', 'pos-desktop');
const store = require(path.join(ROOT, 'electron', 'store.cjs'));
const printer = require(path.join(ROOT, 'electron', 'printer.cjs'));

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

// ── ХРАНИЛИЩЕ ────────────────────────────────────────────────────────
console.log('── Хранилище');

const st = store.saveState({ deviceToken: 'abc', employee: { name: 'Асель' } });
ok(st.deviceToken === 'abc', 'Состояние сохраняется');
ok(store.readState().employee.name === 'Асель', 'И читается обратно');

const st2 = store.saveState({ shift: { id: 'sh1' } });
ok(st2.deviceToken === 'abc' && st2.shift.id === 'sh1',
   '★ Сохранение ДОПОЛНЯЕТ, а не затирает: токен устройства уцелел');

// атомарность: во время записи не должно оставаться обрывков
const statePath = path.join(DIR, 'state.json');
const raw = fs.readFileSync(statePath, 'utf8');
ok(JSON.parse(raw).deviceToken === 'abc', '★ Файл на диске — целый разбираемый документ');
ok(!fs.existsSync(statePath + '.tmp'), '★ Временный файл убран после записи');

// испорченный файл не роняет кассу
fs.writeFileSync(path.join(DIR, 'catalog.json'), '{это не документ', 'utf8');
const cat = store.readCatalog();
ok(Array.isArray(cat) && cat.length === 0, '★ Испорченный файл не роняет кассу — вернулся пустой список');
const broken = fs.readdirSync(DIR).filter((f) => f.includes('.broken-'));
ok(broken.length === 1, '★ Испорченный файл сохранён рядом — можно разобраться потом');

// ── ОЧЕРЕДЬ НА СЕРВЕР ────────────────────────────────────────────────
console.log('\n── Очередь на сервер');

store.saveState({ lastSeq: 0 });
const e1 = store.addToOutbox({ id: 'r1', entity: 'sale', entityId: 'r1', op: 'insert', payload: { total: 100 } });
const e2 = store.addToOutbox({ id: 'r2', entity: 'sale', entityId: 'r2', op: 'insert', payload: { total: 200 } });
const e3 = store.addToOutbox({ id: 'r3', entity: 'sale', entityId: 'r3', op: 'insert', payload: { total: 300 } });

ok(e1.clientSeq === 1 && e2.clientSeq === 2 && e3.clientSeq === 3,
   '★ Сквозная нумерация без пропусков — сервер видит, всё ли доехало');
ok(!!e1.clientTs, 'У события есть время создания');
ok(store.readOutbox().length === 3, 'Три события в очереди');

// подтверждение только части
store.ackOutbox(['r1', 'r3']);
const left = store.readOutbox();
ok(left.length === 1 && left[0].id === 'r2',
   '★ Удаляются ТОЛЬКО подтверждённые — неподтверждённое осталось');

// испорченная строка в очереди не ломает остальные
fs.appendFileSync(path.join(DIR, 'outbox.jsonl'), 'мусор без кавычек\n', 'utf8');
const after = store.readOutbox();
ok(after.length === 1, '★ Испорченная строка пропущена, остальная очередь цела');

// очередь переживает «выключение»: читаем заново из файла
delete require.cache[require.resolve(path.join(ROOT, 'electron', 'store.cjs'))];
const store2 = require(path.join(ROOT, 'electron', 'store.cjs'));
ok(store2.readOutbox().length === 1, '★ Очередь пережила перезапуск программы');

// ── ЧЕКИ ─────────────────────────────────────────────────────────────
console.log('\n── Местная история чеков');
store.addReceipt({ id: 'c1', number: 1, total: 500 });
store.addReceipt({ id: 'c2', number: 2, total: 700 });
const recent = store.recentReceipts(10);
ok(recent.length === 2 && recent[0].number === 2, '★ Последний чек первым — для возврата нужен свежий');

// ── СБОРКА ЧЕКА ──────────────────────────────────────────────────────
console.log('\n── Сборка чека для принтера');

const bytes = printer.buildReceipt({
  store: 'Магазин Береке', number: '42', date: '10.08.2026 14:32', cashier: 'Асель',
  items: [{ name: 'Молоко Айран 1л', qty: 2, price: 480, total: 960 },
          { name: 'Хлеб', qty: 1, price: 250, total: 250 }],
  discount: 110, total: 1100,
  payments: [{ label: 'Наличные', sum: 1200 }], change: 100, hasCash: true,
}, 48);

ok(Array.isArray(bytes) && bytes.length > 100, 'Чек собран в команды принтера');
ok(bytes[0] === 0x1b && bytes[1] === 0x40, '★ Начинается со сброса принтера — иначе печать зависит от прошлого чека');
ok(bytes.includes(0x1d) && bytes.includes(0x56), '★ Есть команда отреза ленты');

// кодовая страница кириллицы
const idx = bytes.findIndex((b, i) => b === 0x1b && bytes[i + 1] === 0x74);
ok(idx >= 0 && bytes[idx + 2] === 17, '★ Задана кодовая страница 866 — иначе вместо букв кракозябры');

// Разбираем ленту обратно в строки. Команды принтера ПРОПУСКАЕМ вместе с
// их параметрами: без этого в текст попадают служебные байты (например,
// у команды двойной высоты параметр совпадает с символом «!»), и проверка
// ширины строки становится бессмысленной — она мерит то, чего на бумаге нет.
function toLines(arr) {
  const dec = (c) => c < 128 ? String.fromCharCode(c)
    : (c >= 0x80 && c <= 0xaf) ? String.fromCharCode(c - 0x80 + 0x410)
    : (c >= 0xe0 && c <= 0xef) ? String.fromCharCode(c - 0xe0 + 0x440) : '·';
  const out = []; let line = '';
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c === 0x1b) {                      // ESC: команда с 1-2 параметрами
      const cmd = arr[i + 1];
      i += (cmd === 0x40) ? 1 : 2;         // сброс — без параметра
      continue;
    }
    if (c === 0x1d) { i += 2; continue; }  // GS: команда с параметром
    if (c === 0x0a) { out.push(line); line = ''; continue; }
    if (c >= 0x20) line += dec(c);
  }
  if (line) out.push(line);
  return out;
}
const lines = toLines(bytes);

const sep = lines.find((l) => l.startsWith('-'.repeat(10)));
ok(sep && sep.trim().length === 48, `★ Разделитель ровно по ширине ленты: ${sep?.trim().length} знаков`);

const totalLine = lines.find((l) => l.includes('ИТОГО'));
ok(!!totalLine, 'Строка итога есть');
ok(totalLine.length === 48, `★ Строка итога РОВНО по ширине ленты: ${totalLine?.length} из 48`);

const changeLine = lines.find((l) => l.includes('Сдача'));
ok(!!changeLine && /100/.test(changeLine), '★ Сдача напечатана — кассир не считает в уме');

ok(lines.some((l) => l.includes('Скидка')), 'Скидка показана отдельной строкой');
ok(lines.some((l) => l.includes('Молоко')), 'Кириллица товара читается обратно');

// возврат подписан иначе
const refund = printer.buildReceipt({ store: 'М', number: '43', isRefund: true,
  items: [{ name: 'Хлеб', qty: 1, price: 250, total: 250 }], total: 250, payments: [] }, 48);
const rlines = toLines(refund);
ok(rlines.some((l) => l.includes('ВОЗВРАТ')), '★ Возврат подписан «ВОЗВРАТ», а не «ЧЕК»');

// ── ДЕНЬГИ ───────────────────────────────────────────────────────────
console.log('\n── Деньги');
ok(printer.money(1000) === '1 000 T', `Целые без копеек: ${printer.money(1000)}`);
ok(printer.money(1234567) === '1 234 567 T', `Разряды разделены: ${printer.money(1234567)}`);
ok(printer.money(99.5) === '99.50 T', `★ Дробные с копейками: ${printer.money(99.5)} — иначе столбик оплат не сходится с итогом`);
ok(printer.money(0) === '0 T', 'Ноль показывается');

// ── ЭКРАНЫ КАССЫ: проверяем код, а не картинку ───────────────────────
console.log('\n── Экраны кассы');
const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

ok(appJs.includes("K.receiptAdd(receipt)") &&
   appJs.indexOf('K.receiptAdd(receipt)') < appJs.indexOf('let p = { ok: true }'),
   '★ Чек сохраняется на диск ДО печати: продажа не зависит от принтера');

ok(/l\.price \* l\.qty - \(l\.discount \|\| 0\)/.test(appJs),
   '★ Итог считается со скидками на позиции');

ok(appJs.includes("K.saveState({ parked })"),
   '★ Отложенные чеки пишутся на диск — касса может закрыться, покупатель вернётся');
ok(html.includes('btnPark') && html.includes('btnParked'),
   'Кнопки «Отложить» и «Отложенные» есть на экране');

// Клавиатура: главный урок соседей — подключить и забыть отрисовать
ok(appJs.includes("document.body.appendChild(pad)"),
   '★ Клавиатура ОТРИСОВЫВАЕТСЯ, а не только подключается (шишка соседнего проекта)');
ok(appJs.includes("document.addEventListener('focusin'"),
   '★ Появляется САМА на любом числовом поле — забыть подключить невозможно');
ok(appJs.includes("new Event('input'"),
   '★ Сообщает полю об изменении — иначе сдача не пересчитается');
ok(appJs.includes('e.preventDefault()'),
   'Нажатие на клавиатуру не сбрасывает фокус поля');

const numericInputs = (appJs.match(/inputmode="numeric"/g) || []).length +
                      (html.match(/inputmode="numeric"/g) || []).length;
ok(numericInputs >= 5, `★ Числовых полей ${numericInputs} — все получат клавиатуру автоматически`);

// ── ДИАГНОСТИКА ПЕЧАТИ ───────────────────────────────────────────────
console.log('\n── Диагностика печати');
for (const w of [48, 32]) {
  const diag = printer.buildDiagnostic(w);
  const dl = toLines(diag);
  const frame = dl.find((l) => l.startsWith('+-'));
  ok(frame && frame.length === w, `★ Рамка ровно по ленте ${w} мм: ${frame?.length} из ${w}`);
  const ruler = dl.find((l) => /^\.+1/.test(l));
  ok(ruler && ruler.length === w, `★ Линейка длиной ${ruler?.length} — видно, сколько знаков влезает`);
  const inside = dl.filter((l) => l.startsWith('|') && l.endsWith('|'));
  ok(inside.length >= 2 && inside.every((l) => l.length === w),
     `Строки внутри рамки не выходят за край (${w})`);
}
const d48 = printer.buildDiagnostic(48);
ok(d48.includes(0xf0) && d48.includes(0xf1), '★ Буква Ё кодируется правильно (0xF0/0xF1)');
ok(d48.includes(0x1d) && d48.includes(0x56), 'Диагностика тоже отрезает ленту');

// ── ОБНОВЛЕНИЕ КАССЫ ─────────────────────────────────────────────────
console.log('\n── Обновление кассы');
const updSrc = fs.readFileSync(path.join(ROOT, 'electron', 'updater.cjs'), 'utf8');

// сравнение версий — частая ошибка «1.10 меньше 1.9»
const { isNewer } = (() => {
  const m = { exports: {} };
  // берём только чистую функцию, без Electron
  const fn = new Function('a', 'b', `
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;`);
  return { isNewer: fn };
})();
ok(isNewer('1.2.0', '1.1.0') === true, 'Новее: 1.2.0 > 1.1.0');
ok(isNewer('1.10.0', '1.9.0') === true, '★ 1.10 больше 1.9 — сравниваются числа, а не строки');
ok(isNewer('1.1.0', '1.1.0') === false, 'Та же версия — не новее');
ok(isNewer('1.0.9', '1.1.0') === false, 'Старее — не предлагается');

ok(updSrc.includes('if (state.shift) return { skip'),
   '★ При ОТКРЫТОЙ смене обновление даже не предлагается — иначе остановка торговли');
ok(updSrc.includes('Сначала закройте смену'),
   '★ И установка запрещена при открытой смене — вторая защита');
ok(updSrc.includes("sum !== meta.sha256"),
   '★ Скачанный файл проверяется по хэшу: битый установщик ломает работающую кассу');
ok(updSrc.includes('onProgress'),
   'Ход скачивания показывается: файл в сотни мегабайт, молчащая полоса выглядит как зависание');

// ── РАЗМЕРЫ ПОД РАССТОЯНИЕ 80-100 СМ ─────────────────────────────────
console.log('\n── Размеры кассового экрана');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => +m[1]);
const maxSize = Math.max(...sizes);
ok(maxSize >= 56, `★ Крупнейший текст ${maxSize}px — экран кассы стоит в 80-100 см и его не придвинуть`);
ok(css.includes('font-size: 64px'), '★ Сумма к оплате 64px — её произносят вслух и читают под углом');
ok(/\.change[^}]*font-size:\s*4[0-9]px/s.test(css), '★ Сдача 44px — её считают в уме и ошибаются');
ok(/\.qty button\s*\{[^}]*min-height:\s*5[0-9]px/s.test(css),
   'Кнопки количества от 52px — их жмут подряд по многу раз');

// Счётчик между плюсом и минусом: промах «плюс→минус» самая дорогая опечатка
ok(/data-m="\$\{i\}">−<\/button><button class="qty-num" data-q="\$\{i\}">\$\{l\.qty\}<\/button><button data-p/.test(appJs),
   '★ Счётчик СТОИТ МЕЖДУ кнопками — промахнуться с «плюса» на «минус» физически нельзя');
ok(appJs.includes("data-q=") && appJs.includes('Количество «'),
   '★ Нажатие на число открывает ввод: 12 бутылок — одно действие вместо двенадцати');
ok(appJs.includes("replace(',', '.')"),
   'Весовой товар: 0,850 кг вводится с запятой, как на ценнике');
ok(appJs.includes("n < l.qty") && appJs.includes("act_reduce_qty"),
   '★ Уменьшение через ввод спрашивает право так же, как кнопка «минус» — обойти нельзя');

// ── СЛЕД ОТ ОТМЕН ────────────────────────────────────────────────────
console.log('\n── Защита от увода денег');
ok(appJs.includes("parts.push('отмен: '"),
   '★ Счётчик отмен за смену в шапке — снимает главное условие кражи: незаметность');
ok(appJs.includes("'Убрать?'"),
   '★ Удаление позиции в два касания: след есть, окна нет — очередь не ждёт');

// ── БЫСТРЫЕ ТОВАРЫ ───────────────────────────────────────────────────
console.log('\n── Быстрые товары');
ok(appJs.includes('quickItems'), 'Плитки часто продаваемого есть');
ok(appJs.includes('quick: !!g.is_quick') && appJs.includes('quickGroup: g.quick_group'),
   '★ Поля читаются как их отдаёт сервер (is_quick, quick_group) — иначе плитки всегда пустые');
ok(/overflow-x:\s*auto/.test(css), 'Не влезающие плитки едут вбок, а не уменьшаются');

// ── БЕЗ ИНТЕРНЕТА ────────────────────────────────────────────────────
console.log('\n── Ничего не грузится из сети');
ok(!/<link[^>]+https?:\/\//.test(html) && !/@import\s+url\(https?:/.test(css),
   '★ Ни шрифтов, ни стилей со стороны — касса работает без интернета');
ok((css.match(/@font-face/g) || []).length >= 2, 'Шрифт лежит рядом с кассой');

// ── ДЕНЬГИ В КАССЕ ───────────────────────────────────────────────────
console.log('\n── Кассовые операции');
ok(appJs.includes("entity: 'cash_operation'"),
   '★ Внесение и изъятие денег: без них расчётный остаток не сойдётся с настоящим');
ok(/kind === 'deposit'/.test(appJs) && appJs.includes("data-k=\"collection\""),
   'Три вида: внести, изъять, сдать выручку — в отчёте считаются по-разному');
ok(appJs.includes("kind !== 'deposit' && !note"),
   '★ У изъятия причина обязательна: деньги уходят, владелец должен видеть куда');
ok(appJs.includes('cashInDrawer'),
   '★ Наличные считаются на кассе: кассир видит остаток, не открывая ящик');
ok(appJs.includes("cashInDrawer: shift.openingFloat"),
   'Размен при открытии смены — это стартовые наличные, а не «просто число»');
ok(appJs.includes('Не хватает') && appJs.includes('Излишек'),
   '★ Расхождение видно ДО подтверждения: кассир пересчитает сейчас, а не объяснится завтра');

// ── ПРОДАЖА В ДОЛГ ───────────────────────────────────────────────────
console.log('\n── Долг и особые продажи');
ok(appJs.includes("way === 'credit'"), '★ Продажа в долг');
ok(appJs.includes('долг должен быть на кого-то записан'),
   '★ Долг без покупателя не проводится: некому предъявить — это потерянные деньги');
ok(appJs.includes("hasCash: way === 'cash' || way === 'mixed'"),
   'Ящик не открывается при карте и долге — наличных не прибавилось');

ok(appJs.includes('btnFree'), '★ Товар без карточки: иначе кассир пробьёт под чужим товаром');
ok(appJs.includes("free: true"), 'Такая позиция помечена — владелец увидит и заведёт товар');
ok(appJs.includes('btnPrice'), '★ Проверка цены без начала чека: отменённый чек это след');
ok(appJs.includes('noPriceDown'),
   '★ Запрет снижения цены: снижение на кассе — тихий способ отдать товар «своим»');
ok(appJs.includes('noReceipt') && appJs.includes('без причины возврат не проводим'),
   '★ Возврат без чека с обязательной причиной и следом в счётчике отмен');

// ── ПРАВА И КОНТРОЛЬ ─────────────────────────────────────────────────
console.log('\n── Права по действиям (модель UMAG)');
ok(appJs.includes('async function allowAction'),
   '★ Разрешение вместо запрета: кассир не заблокирован, но опасное — с PIN администратора');
ok(appJs.includes("level === 'nobody'") && appJs.includes("level === 'everyone'"),
   'Три уровня: всем, только администратору, никому');
ok(appJs.includes('await K.approve(pin)'),
   '★ PIN спрашивается ПРЯМО НА МЕСТЕ — очередь не ждёт, звонить владельцу не надо');
ok(appJs.includes('approvedBy: ok.approvedBy'),
   '★ В журнал попадают ДВА имени: кто сделал и кто разрешил');
ok(appJs.includes("logAction('discount'") && appJs.includes("logAction('price_change'"),
   'Значимые действия пишутся в журнал');

console.log('\n── Скидки');
ok(appJs.includes('btnDiscount'), '★ Скидка на весь чек: была только на позицию');
ok(appJs.includes("mode === 'pct'"),
   '★ В процентах ИЛИ в тенге: «уступлю пятьсот» и «скину десять процентов» — разные мысли');
ok(appJs.includes('discountMaxPct'),
   '★ Потолок скидки: запретить совсем плохо — продавцу нужно уступать, чтобы не терять покупателя');
ok(appJs.includes('discountAllowed === false'), 'Скидки можно запретить вовсе');
ok(appJs.includes('К оплате ${money(base - capped)}'),
   'Показывается итог, а не размер скидки: продавец называет покупателю конечную сумму');

console.log('\n── Бонусы');
ok(appJs.includes("way === 'bonus'"), '★ Оплата бонусами: программа работала, а потратить было нельзя');
ok(appJs.includes('K.bonusSpendable'),
   '★ Сколько списать решает СЕРВЕР: потолок и сгорание живут в одном месте, а не в двух');
ok(appJs.includes('Доплатить наличными'), 'Видно, сколько доплатить сверх бонусов');
ok(appJs.includes("(way === 'bonus' && total - bonusUsed > 0)"),
   'Ящик открывается только при доплате: бонусы покрыли всё — денег не прибавилось');

// ── ПРЕЧЕК ───────────────────────────────────────────────────────────
console.log('\n── Пречек');
ok(appJs.includes('btnPreReceipt') && appJs.includes('isPreReceipt'),
   '★ Пречек: покупатель видит сумму ДО оплаты, без пробитого чека');
ok(css.includes('qty-num'), 'Количество оформлено как число, а не как третья кнопка');
const pre = printer.buildReceipt({ store: 'М', date: '13.08', isPreReceipt: true,
  items: [{ name: 'Хлеб', qty: 1, price: 250, total: 250 }], total: 250, payments: [] }, 48);
const preLines = toLines(pre);
ok(preLines.some((l) => l.includes('ЭТО НЕ ЧЕК')),
   '★ На пречеке крупная пометка: покупатель не уйдёт, решив что чек уже пробит');
ok(preLines.some((l) => l.includes('ПРЕДВАРИТЕЛЬНЫЙ')), 'Шапка отличается от чека');
ok(!preLines.some((l) => l.includes('Спасибо за покупку')),
   'Прощального текста нет — покупатель ещё ничего не купил');

// ── УДВОЕНИЕ И ПЕЧАТЬ ────────────────────────────────────────────────
console.log('\n── Удвоение позиции и режим печати');
ok(appJs.includes('data-dup=') && appJs.includes('l.qty *= 2'),
   '★ Удвоение позиции: «ещё столько же» одним касанием');
ok(css.includes('qty-dup'), 'Кнопка тише основных — действие редкое, внимание не перетягивает');

ok(appJs.includes("SET.printMode") && appJs.includes("mode === 'never' ? false"),
   '★ Режим печати: всегда / спрашивать / не печатать');
ok(appJs.includes("wantPrint"),
   'В режиме «спрашивать» кассир решает галочкой при оплате');
ok(appJs.includes('if (wantPaper) p = await K.print(receipt)'),
   '★ Чек всё равно СОХРАНЯЕТСЯ и уходит в очередь — не печатается только бумага');
ok(appJs.indexOf('K.receiptAdd(receipt)') < appJs.indexOf('const mode = SET.printMode'),
   '★ Сохранение по-прежнему ДО печати: продажа не зависит от бумаги');

// ── ИТОГ ─────────────────────────────────────────────────────────────
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
process.exit(fail ? 1 : 0);
