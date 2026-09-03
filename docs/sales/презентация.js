const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.lang = 'kk-KZ';

// ЦВЕТА: тёмно-зелёный тенге и золото — деньги, доверие, Казахстан
const C = { dark:'0F3D2E', green:'1B6B4A', gold:'C9A227', light:'F4F6F3', white:'FFFFFF',
            text:'1A1A1A', muted:'6B7770', card:'E8EFE9' };
const F = { h:'Cambria', b:'Calibri' };

const notes = (s, t) => s.addNotes(t);

// ─── 1. ТИТУЛ ────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.dark };
  s.addShape(pres.shapes.OVAL, { x: 7.6, y: -1.2, w: 4.2, h: 4.2, fill: { color: C.green } });
  s.addText('Табыс', { x: 0.7, y: 1.4, w: 7, h: 1.2, fontFace: F.h, fontSize: 60, bold: true,
    color: C.gold, isTextBox: true, margin: 0 });
  s.addText('Дүкеніңіз үшін толық есеп жүйесі', { x: 0.7, y: 2.6, w: 7.5, h: 0.6,
    fontFace: F.b, fontSize: 24, color: C.white, isTextBox: true, margin: 0 });
  s.addText('Касса · Қойма · Есептер · Kaspi · Салық — бір жерде',
    { x: 0.7, y: 3.3, w: 8, h: 0.5, fontFace: F.b, fontSize: 16, color: 'B8C9BF',
      isTextBox: true, margin: 0 });
  s.addText('Айына 6 900 ₸-ден · Орнату тегін · 14 күн сынақ',
    { x: 0.7, y: 4.5, w: 8, h: 0.4, fontFace: F.b, fontSize: 14, color: C.gold,
      isTextBox: true, margin: 0, italic: true });
  notes(s, 'Табыс — Қазақстан дүкендері үшін жасалған. Кассадан бастап салыққа дейін бір жүйеде.');
}

// ─── 2. ПРОБЛЕМА ─────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.white };
  s.addText('Дүкен иесінің күнделікті қиындығы', { x: 0.6, y: 0.4, w: 9, h: 0.7,
    fontFace: F.h, fontSize: 32, bold: true, color: C.dark, isTextBox: true, margin: 0 });
  const боли = [
    ['Түсім қайда кетті?', 'Кассир қанша сатты, қайтарым қанша — кешке дейін белгісіз'],
    ['Тауар қалды ма?', 'Сатып алушы сұрайды, сатушы қоймаға жүгіреді'],
    ['Салық қалай есептеледі?', 'Тоқсан сайын бухгалтерге ақша, декларация қолмен'],
    ['Kaspi-де тапсырыстар', 'Сайтта бір қалдық, дүкенде басқа — қателік'],
  ];
  боли.forEach((b, i) => {
    const y = 1.35 + i * 0.95;
    s.addShape(pres.shapes.OVAL, { x: 0.6, y: y + 0.05, w: 0.55, h: 0.55, fill: { color: C.gold } });
    s.addText(String(i + 1), { x: 0.6, y: y + 0.05, w: 0.55, h: 0.55, fontFace: F.b, fontSize: 18,
      bold: true, color: C.dark, align: 'center', valign: 'middle', isTextBox: true, margin: 0 });
    s.addText(b[0], { x: 1.35, y: y - 0.02, w: 8, h: 0.4, fontFace: F.b, fontSize: 20, bold: true,
      color: C.text, isTextBox: true, margin: 0 });
    s.addText(b[1], { x: 1.35, y: y + 0.36, w: 8, h: 0.4, fontFace: F.b, fontSize: 14,
      color: C.muted, isTextBox: true, margin: 0 });
  });
  notes(s, 'Әр дүкен иесі осы төрт сұрақпен күн сайын кездеседі.');
}

// ─── 3. КАССА ────────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.light };
  s.addText('Касса — кассирге ыңғайлы', { x: 0.6, y: 0.4, w: 9, h: 0.7,
    fontFace: F.h, fontSize: 30, bold: true, color: C.dark, isTextBox: true, margin: 0 });
  const функ = [
    ['Интернетсіз жұмыс', 'Байланыс үзілсе де сатады, чек басады, ауысымды жабады. Чектер өзі кетеді'],
    ['Штрих-код пен таразы', 'Салмақ штрих-кодтан алынады — кассир енгізбейді'],
    ['Таңбалау (Data Matrix)', 'Темекі, алкоголь: кодсыз төлемге жібермейді'],
    ['Жас тексеру', 'Алкоголь мен темекіге туған жылды өзі көрсетеді'],
    ['Кейінге қалдыру', 'Сатып алушы ақшаға кетті — касса бос'],
    ['Қайтарым', 'Ақша келген жолмен қайтады: қолма-қол, карта, QR'],
    ['Ауысым және X/Z есеп', 'Кассир ақша санайды — айырма бірден көрінеді'],
    ['Құлып', 'Үш минут қозғалыссыз — код сұрайды, чек жоғалмайды'],
  ];
  функ.forEach((f, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.6 + col * 4.55, y = 1.3 + row * 0.98;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 4.3, h: 0.85, fill: { color: C.white },
      line: { color: C.card, width: 1 }, rectRadius: 0.08 });
    s.addText(f[0], { x: x + 0.2, y: y + 0.08, w: 3.9, h: 0.3, fontFace: F.b, fontSize: 14,
      bold: true, color: C.green, isTextBox: true, margin: 0 });
    s.addText(f[1], { x: x + 0.2, y: y + 0.4, w: 3.9, h: 0.4, fontFace: F.b, fontSize: 11,
      color: C.muted, isTextBox: true, margin: 0 });
  });
  notes(s, 'Касса Windows планшетінде немесе компьютерде. Сканер, таразы, чек принтері, ақша жәшігі қосылады.');
}

// ─── 4. ЦИФРЫ КАССЫ ──────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.dark };
  s.addText('Касса сандармен', { x: 0.6, y: 0.4, w: 9, h: 0.6, fontFace: F.h, fontSize: 30,
    bold: true, color: C.white, isTextBox: true, margin: 0 });
  const стат = [['17', 'кассадағы\nфункция'], ['2', 'тіл: қазақша\nжәне орысша'],
                ['690+', 'автоматты\nтексеру'], ['0', 'интернетсіз\nжоғалған чек']];
  стат.forEach((c, i) => {
    const x = 0.6 + i * 2.35;
    s.addText(c[0], { x, y: 1.5, w: 2.1, h: 1.2, fontFace: F.h, fontSize: 60, bold: true,
      color: C.gold, align: 'center', isTextBox: true, margin: 0 });
    s.addText(c[1], { x, y: 2.75, w: 2.1, h: 0.8, fontFace: F.b, fontSize: 14, color: 'B8C9BF',
      align: 'center', isTextBox: true, margin: 0 });
  });
  s.addText('Кассир оқуы — жарты сағат. Екінші рет түсіндіретін адам болмайды, сондықтан касса өзі айтады: не болды, не істеу керек.',
    { x: 0.6, y: 3.9, w: 9, h: 0.9, fontFace: F.b, fontSize: 15, color: C.white, italic: true,
      isTextBox: true, margin: 0 });
  notes(s, '690 автоматты тексеру — әр жаңарту алдында өтеді.');
}

// ─── 5. КАБИНЕТ ──────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.white };
  s.addText('Иесінің кабинеті — 21 бөлім', { x: 0.6, y: 0.4, w: 9, h: 0.7,
    fontFace: F.h, fontSize: 30, bold: true, color: C.dark, isTextBox: true, margin: 0 });
  s.addText('Компьютерден де, телефоннан да', { x: 0.6, y: 1.0, w: 9, h: 0.4,
    fontFace: F.b, fontSize: 14, color: C.muted, isTextBox: true, margin: 0 });
  const разд = ['Көрсеткіштер', 'Тауарлар', 'Қойма', 'Қаржы', 'Есептер', 'Қызметкерлер',
    'Жалақы', 'Салық', 'Адалдық', 'Kaspi дүкен', 'Таңбалау', 'Акциз',
    'Контрагенттер', 'Көтерме', 'Техкарталар', 'RFM-талдау', 'Сертификаттар',
    'Автоматтандыру', 'AI-көмекші', 'Нүктелер мен кассалар', 'Баптаулар'];
  разд.forEach((r, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = 0.6 + col * 3.05, y = 1.55 + row * 0.5;
    s.addShape(pres.shapes.OVAL, { x, y: y + 0.1, w: 0.22, h: 0.22, fill: { color: C.gold } });
    s.addText(r, { x: x + 0.35, y, w: 2.6, h: 0.42, fontFace: F.b, fontSize: 14, color: C.text,
      isTextBox: true, margin: 0, valign: 'middle' });
  });
  notes(s, 'Барлық 21 бөлім Стандарт тарифінде. Старт тарифінде негізгі 8.');
}

// ─── 6. ЧЕГО НЕТ У ДРУГИХ ────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.light };
  s.addText('Басқаларда жоқ нәрсе', { x: 0.6, y: 0.4, w: 9, h: 0.7,
    fontFace: F.h, fontSize: 30, bold: true, color: C.dark, isTextBox: true, margin: 0 });
  const уник = [
    ['AI накладной таниды', 'Жеткізушінің накладнойын суретке түсіресіз — тауарлар қоймаға өзі кіреді. Бағамен айырмашылықты көрсетеді'],
    ['Дауыспен түгендеу', 'Қоймада айтасыз: «Нан он бес» — жүйе жазады. Қолда қағаз жоқ'],
    ['Салық өзі есептеледі', 'Кіріс, шығыс, әлеуметтік төлемдер — 910-нысанға дайын сандар'],
    ['Kaspi дүкен', 'Тапсырыстар мен тауарлар өзі синхрондалады. Бір қалдық — екі жерде'],
    ['Кешкі есеп Telegram-ға', 'Күн сайын кешке: түсім, чектер, қайтарымдар. Кабинетке кірмей-ақ'],
    ['Серіктес қасында', 'Орнатады, оқытады, келеді. Байланыс орталығына емес — адамға'],
  ];
  уник.forEach((u, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.6 + col * 4.55, y = 1.3 + row * 1.3;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 4.3, h: 1.15, fill: { color: C.white },
      line: { color: C.card, width: 1 }, rectRadius: 0.08 });
    s.addShape(pres.shapes.OVAL, { x: x + 0.18, y: y + 0.18, w: 0.4, h: 0.4, fill: { color: C.green } });
    s.addText('✓', { x: x + 0.18, y: y + 0.18, w: 0.4, h: 0.4, fontFace: F.b, fontSize: 16, bold: true,
      color: C.white, align: 'center', valign: 'middle', isTextBox: true, margin: 0 });
    s.addText(u[0], { x: x + 0.72, y: y + 0.15, w: 3.4, h: 0.35, fontFace: F.b, fontSize: 15,
      bold: true, color: C.dark, isTextBox: true, margin: 0 });
    s.addText(u[1], { x: x + 0.72, y: y + 0.5, w: 3.4, h: 0.6, fontFace: F.b, fontSize: 11,
      color: C.muted, isTextBox: true, margin: 0 });
  });
  notes(s, 'Бұл алты функция UMAG пен Wipon-да жоқ.');
}

// ─── 7. ТЕЛЕФОН ──────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.white };
  s.addText('Телефоннан — дүкен алақанда', { x: 0.6, y: 0.4, w: 9, h: 0.7,
    fontFace: F.h, fontSize: 30, bold: true, color: C.dark, isTextBox: true, margin: 0 });
  // Телефон
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 6.3, y: 1.2, w: 2.6, h: 3.9,
    fill: { color: C.dark }, rectRadius: 0.3 });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 6.45, y: 1.5, w: 2.3, h: 3.4,
    fill: { color: C.light }, rectRadius: 0.15 });
  s.addText('Бүгін', { x: 6.6, y: 1.6, w: 2, h: 0.3, fontFace: F.b, fontSize: 11, color: C.muted,
    isTextBox: true, margin: 0 });
  s.addText('Түсім', { x: 6.6, y: 1.9, w: 2, h: 0.25, fontFace: F.b, fontSize: 9, color: C.muted,
    isTextBox: true, margin: 0 });
  s.addText('184 500 ₸', { x: 6.6, y: 2.12, w: 2, h: 0.4, fontFace: F.h, fontSize: 22, bold: true,
    color: C.dark, isTextBox: true, margin: 0 });
  s.addText('Чектер · 47', { x: 6.6, y: 2.6, w: 2, h: 0.25, fontFace: F.b, fontSize: 10, color: C.text,
    isTextBox: true, margin: 0 });
  s.addText('Орташа чек · 3 925 ₸', { x: 6.6, y: 2.85, w: 2, h: 0.25, fontFace: F.b, fontSize: 10,
    color: C.text, isTextBox: true, margin: 0 });
  s.addText('Пайда · 41 200 ₸', { x: 6.6, y: 3.1, w: 2, h: 0.25, fontFace: F.b, fontSize: 10,
    color: C.green, bold: true, isTextBox: true, margin: 0 });
  s.addText('Шоттардағы ақша', { x: 6.6, y: 3.5, w: 2, h: 0.25, fontFace: F.b, fontSize: 9,
    color: C.muted, isTextBox: true, margin: 0 });
  s.addText('Касса · 62 300 ₸\nKaspi · 122 200 ₸', { x: 6.6, y: 3.72, w: 2, h: 0.6, fontFace: F.b,
    fontSize: 10, color: C.text, isTextBox: true, margin: 0 });
  // Текст слева
  const тел = [
    ['Түсім нақты уақытта', 'Дүкенде болмасаңыз да — қанша сатылды, көрінеді'],
    ['Пайда, орташа чек', 'Тек түсім емес — өзіндік құн шегерілген нақты пайда'],
    ['Шоттардағы ақша', 'Кассада қанша, Kaspi-де қанша — бір экранда'],
    ['Кешкі есеп', 'Telegram немесе WhatsApp-қа өзі келеді'],
  ];
  тел.forEach((t, i) => {
    const y = 1.3 + i * 0.95;
    s.addText(t[0], { x: 0.6, y, w: 5.3, h: 0.35, fontFace: F.b, fontSize: 17, bold: true,
      color: C.text, isTextBox: true, margin: 0 });
    s.addText(t[1], { x: 0.6, y: y + 0.36, w: 5.3, h: 0.4, fontFace: F.b, fontSize: 13,
      color: C.muted, isTextBox: true, margin: 0 });
  });
  notes(s, 'Телефон қосымшасы — иесі үшін. Кассирге кассадағы бағдарлама.');
}

// ─── 8. СРАВНЕНИЕ ЦЕН ────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.white };
  s.addText('Бағаны салыстырыңыз', { x: 0.6, y: 0.4, w: 9, h: 0.7,
    fontFace: F.h, fontSize: 30, bold: true, color: C.dark, isTextBox: true, margin: 0 });
  s.addText('Айлық төлем, теңге. Ресми сайттардан, 2026 жылғы қыркүйек', { x: 0.6, y: 1.0, w: 9, h: 0.35,
    fontFace: F.b, fontSize: 12, color: C.muted, isTextBox: true, margin: 0 });
  s.addChart(pres.charts.BAR, [
    { name: 'Негізгі тариф', labels: ['Табыс', 'UMAG', 'Wipon'], values: [6900, 8800, 15000] },
    { name: 'Толық тариф', labels: ['Табыс', 'UMAG', 'Wipon'], values: [14900, 19900, 22500] },
  ], {
    x: 0.6, y: 1.4, w: 5.6, h: 3.6, barDir: 'col', barGrouping: 'clustered',
    chartColors: [C.gold, C.green], showValue: true, dataLabelPosition: 'outEnd',
    dataLabelFontSize: 10, dataLabelColor: C.text, dataLabelFormatCode: '#,##0',
    catAxisLabelFontSize: 13, catAxisLabelColor: C.text, valAxisLabelFontSize: 10,
    valAxisLabelColor: C.muted, valGridLine: { color: 'E5E5E5', size: 0.5 },
    catGridLine: { style: 'none' }, showLegend: true, legendPos: 'b', legendFontSize: 11,
    valAxisLabelFormatCode: '#,##0',
  });
  const дов = [
    ['Орнату тегін', 'UMAG: 30 000 ₸ бір рет'],
    ['Кассирге шек жоқ', 'Wipon: қызметкер санына тариф'],
    ['AI кіреді', 'Бәсекелестерде мүлде жоқ'],
    ['14 күн тегін', 'Картасыз, міндеттемесіз'],
  ];
  дов.forEach((d, i) => {
    const y = 1.4 + i * 0.9;
    s.addText(d[0], { x: 6.5, y, w: 3, h: 0.35, fontFace: F.b, fontSize: 15, bold: true,
      color: C.green, isTextBox: true, margin: 0 });
    s.addText(d[1], { x: 6.5, y: y + 0.35, w: 3, h: 0.35, fontFace: F.b, fontSize: 12,
      color: C.muted, isTextBox: true, margin: 0 });
  });
  notes(s, 'UMAG: Старт 8 800, Стандарт 19 900, орнату 30 000. Wipon: Lite 15 000, Standard 22 500 бөліп төлегенде. Дереккөз: umag.kz/tarify, docs.wipon.kz');
}

// ─── 9. ТАРИФЫ ───────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.light };
  s.addText('Тарифтер', { x: 0.6, y: 0.4, w: 9, h: 0.7, fontFace: F.h, fontSize: 30, bold: true,
    color: C.dark, isTextBox: true, margin: 0 });
  // Старт
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 1.2, w: 4.3, h: 3.9, fill: { color: C.white },
    line: { color: C.card, width: 1 }, rectRadius: 0.12 });
  s.addText('Старт', { x: 0.9, y: 1.4, w: 3.7, h: 0.4, fontFace: F.b, fontSize: 20, bold: true,
    color: C.dark, isTextBox: true, margin: 0 });
  s.addText('6 900 ₸', { x: 0.9, y: 1.8, w: 3.7, h: 0.7, fontFace: F.h, fontSize: 40, bold: true,
    color: C.green, isTextBox: true, margin: 0 });
  s.addText('айына · 1 дүкен, 1 касса', { x: 0.9, y: 2.5, w: 3.7, h: 0.3, fontFace: F.b, fontSize: 12,
    color: C.muted, isTextBox: true, margin: 0 });
  s.addText([
    { text: 'Касса: сатылым, қайтарым, ауысым', options: { bullet: true, breakLine: true } },
    { text: 'Тауарлар мен қойма', options: { bullet: true, breakLine: true } },
    { text: 'Есептер мен көрсеткіштер', options: { bullet: true, breakLine: true } },
    { text: 'Адалдық және қарыз', options: { bullet: true, breakLine: true } },
    { text: 'Телефон қосымшасы', options: { bullet: true } },
  ], { x: 0.9, y: 2.95, w: 3.7, h: 2, fontFace: F.b, fontSize: 12, color: C.text,
    isTextBox: true, margin: 0, paraSpaceAfter: 5 });
  // Стандарт
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 5.1, y: 1.2, w: 4.3, h: 3.9, fill: { color: C.dark },
    rectRadius: 0.12 });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 7.4, y: 1.35, w: 1.85, h: 0.35, fill: { color: C.gold },
    rectRadius: 0.17 });
  s.addText('ҰСЫНАМЫЗ', { x: 7.4, y: 1.35, w: 1.85, h: 0.35, fontFace: F.b, fontSize: 10, bold: true,
    color: C.dark, align: 'center', valign: 'middle', isTextBox: true, margin: 0 });
  s.addText('Стандарт', { x: 5.4, y: 1.4, w: 2, h: 0.4, fontFace: F.b, fontSize: 20, bold: true,
    color: C.white, isTextBox: true, margin: 0 });
  s.addText('14 900 ₸', { x: 5.4, y: 1.8, w: 3.7, h: 0.7, fontFace: F.h, fontSize: 40, bold: true,
    color: C.gold, isTextBox: true, margin: 0 });
  s.addText('айына · 1 дүкен, кассалар шексіз', { x: 5.4, y: 2.5, w: 3.7, h: 0.3, fontFace: F.b,
    fontSize: 12, color: 'B8C9BF', isTextBox: true, margin: 0 });
  s.addText([
    { text: 'Старттағының бәрі', options: { bullet: true, breakLine: true } },
    { text: 'AI: накладной, дауыспен түгендеу', options: { bullet: true, breakLine: true } },
    { text: 'Kaspi дүкен, салық, жалақы', options: { bullet: true, breakLine: true } },
    { text: 'Таңбалау, акциз, көтерме', options: { bullet: true, breakLine: true } },
    { text: 'Автоматтандыру және API', options: { bullet: true } },
  ], { x: 5.4, y: 2.95, w: 3.7, h: 2, fontFace: F.b, fontSize: 12, color: C.white,
    isTextBox: true, margin: 0, paraSpaceAfter: 5 });
  s.addText('Қосымша дүкен — 4 900 ₸ · Жылға төлесеңіз — 2 ай сыйлық', { x: 0.6, y: 5.2, w: 9, h: 0.3,
    fontFace: F.b, fontSize: 12, color: C.muted, align: 'center', isTextBox: true, margin: 0 });
  notes(s, 'Жылдық төлем: 10 ай бағасына 12 ай. Старт 69 000, Стандарт 149 000 жылына.');
}

// ─── 10. КАК НАЧАТЬ ──────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.white };
  s.addText('Бір күнде іске қосамыз', { x: 0.6, y: 0.4, w: 9, h: 0.7, fontFace: F.h, fontSize: 30,
    bold: true, color: C.dark, isTextBox: true, margin: 0 });
  const шаги = [
    ['1', 'Қоңырау', 'Серіктес келеді, дүкенді көреді'],
    ['2', 'Орнату', 'Касса, сканер, принтер — 2 сағат'],
    ['3', 'Тауарлар', 'Excel-ден немесе накладнойдан AI'],
    ['4', 'Оқыту', 'Кассирге жарты сағат'],
    ['5', 'Сауда', 'Сол күні кешке — бірінші есеп'],
  ];
  шаги.forEach((ш, i) => {
    const x = 0.6 + i * 1.85;
    s.addShape(pres.shapes.OVAL, { x: x + 0.45, y: 1.5, w: 0.8, h: 0.8, fill: { color: i === 4 ? C.gold : C.green } });
    s.addText(ш[0], { x: x + 0.45, y: 1.5, w: 0.8, h: 0.8, fontFace: F.h, fontSize: 26, bold: true,
      color: C.white, align: 'center', valign: 'middle', isTextBox: true, margin: 0 });
    if (i < 4) s.addShape(pres.shapes.LINE, { x: x + 1.3, y: 1.9, w: 0.5, h: 0, line: { color: C.card, width: 2 } });
    s.addText(ш[1], { x, y: 2.5, w: 1.7, h: 0.35, fontFace: F.b, fontSize: 15, bold: true, color: C.dark,
      align: 'center', isTextBox: true, margin: 0 });
    s.addText(ш[2], { x, y: 2.85, w: 1.7, h: 0.7, fontFace: F.b, fontSize: 11, color: C.muted,
      align: 'center', isTextBox: true, margin: 0 });
  });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 1.5, y: 3.9, w: 7, h: 1.1, fill: { color: C.light },
    rectRadius: 0.1 });
  s.addText('14 күн тегін сынақ', { x: 1.5, y: 4.0, w: 7, h: 0.4, fontFace: F.b, fontSize: 18, bold: true,
    color: C.dark, align: 'center', isTextBox: true, margin: 0 });
  s.addText('Ұнамаса — ештеңе төлемейсіз. Деректеріңіз сізде қалады.', { x: 1.5, y: 4.45, w: 7, h: 0.4,
    fontFace: F.b, fontSize: 13, color: C.muted, align: 'center', isTextBox: true, margin: 0 });
  notes(s, 'Серіктес — жергілікті адам. Ол дүкенге келеді, орнатады, оқытады.');
}

// ─── 11. КОНТАКТЫ ────────────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.dark };
  s.addShape(pres.shapes.OVAL, { x: -1.5, y: 3.5, w: 4, h: 4, fill: { color: C.green } });
  s.addText('Табыс', { x: 0.7, y: 1.3, w: 8, h: 1, fontFace: F.h, fontSize: 54, bold: true,
    color: C.gold, isTextBox: true, margin: 0 });
  s.addText('Дүкеніңізге табыс әкелетін жүйе', { x: 0.7, y: 2.3, w: 8, h: 0.5, fontFace: F.b,
    fontSize: 20, color: C.white, isTextBox: true, margin: 0 });
  s.addText('tabys.duckdns.org', { x: 0.7, y: 3.3, w: 8, h: 0.4, fontFace: F.b, fontSize: 18,
    color: C.gold, isTextBox: true, margin: 0 });
  s.addText('Сынақ кезеңін бастау үшін хабарласыңыз', { x: 0.7, y: 3.75, w: 8, h: 0.4, fontFace: F.b,
    fontSize: 14, color: 'B8C9BF', isTextBox: true, margin: 0 });
  notes(s, 'Байланыс: телефон, WhatsApp, Telegram — серіктес нөмірін қосыңыз.');
}

pres.writeFile({ fileName: '/home/claude/pres/Табыс.pptx' }).then(() => console.log('  собрано'));
