'use client';
/**
 * ЛЕНДИНГ (часть 19, переработан под задание docs/САЙТ_задание_на_дизайн.md).
 *
 * БЫЛО: 8 блоков, 401 строка. СТАЛО: 14 блоков — боль владельца, как начать,
 * касса без интернета, накладная из фото (золотом), Kaspi, закон Казахстана,
 * снимки продукта, чек-лист вместо таблицы сравнения, цены открыто, место под
 * отзывы, вопросы и ответы, форма заявки.
 *
 * КОНКУРЕНТОВ НА САЙТЕ НЕТ — по решению владельца. Вместо таблицы сравнения
 * блок «Спросите это у любой программы учёта»: восемь неудобных вопросов и наши
 * ответы. Покупатель идёт с этим списком куда угодно и сравнивает сам.
 *
 * ЛОГИКА НЕ ТРОНУТА: переключатель языка, POST /public/leads (honeypot website +
 * лимит по IP на сервере), переходы на /login и /register.
 *
 * ФОРМА ЗАЯВКИ: телефон и название магазина — ничего лишнего. Название уходит в
 * поле name лида (оператор перезванивает по нему), locale — чтобы знать язык.
 *
 * ЦЕНЫ: два тарифа как в биллинге — «Старт» 6 900 ₸/мес (одна точка, одна
 * касса) и «Стандарт» 14 900 ₸/мес (несколько точек, опт, маркировка и акциз).
 * Плюс 14 дней бесплатно и фиксация на год. Других цифр не выдумывать.
 * Отзывов настоящих нет — стоит место и честная пометка, что мы их не придумываем.
 *
 * ЛОВУШКИ: localStorage только в useEffect; <form> не используется — обработчик
 * на кнопке; стили инлайновые, Tailwind не подключён; шрифт локальный.
 */
import { useState } from 'react';
import { C, S, mono, useLang, useMobile, SiteHeader, SiteFooter, Faq } from '../lib/site';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const T: any = {
  ru: {
    ctaStart: 'Начать бесплатно', ctaPilot: 'Хочу пилот с переездом',
    heroTitle: 'Учёт для магазина у дома.\nКасса торгует даже без интернета.',
    heroSub: 'Товары, склад, долги покупателей, бонусы и отчёты — в одном месте. Регистрация за 2 минуты, без звонков менеджеру. 14 дней бесплатно.',
    trust: 'Данные хранятся в Казахстане · 1500+ автопроверок перед каждым обновлением · Поддержка на казахском и русском',
    heroCard1: '14:02 — интернет пропал', heroCard2: '14:03 — чек пробит ✓',
    heroPhoto: 'фото: прилавок магазина у дома,', heroPhoto2: 'касса и продавец · 1200×1500',
    k1: '01 · Знакомо?', k2: '02 · Старт', k3: '03 · Касса', k5: '04 · Kaspi', k6: '05 · Закон', k7: '06 · Продукт', k8: '07 · Проверка', k9: '08 · Цены', k10: '09 · Отзывы', k11: '10 · Вопросы',
    painTitle: 'Что теряет магазин без учёта',
    pains: [
      { t: 'Минус в кассе после смены', d: 'Смена закрыта — в ящике не хватает. Кто, когда и на сколько — неизвестно.', s: 'Каждая смена сходится до тенге. Недостача видна сразу — и по кассиру.' },
      { t: 'Ходовой товар кончился', d: 'Полка опустела в пятницу вечером — узнали от покупателя.', s: 'Остатки видны с телефона, система сама подсказывает, что дозаказать.' },
      { t: 'Долги — в тетрадке', d: 'Тетрадь потерялась, «я же отдавал» — и спорить нечем.', s: 'Долговая тетрадь живёт в кассе: лимит, история, долг печатается на чеке.' },
      { t: 'Коробка ушла со склада', d: 'Заметили через месяц, при пересчёте. Деньги уже не вернуть.', s: 'Каждое движение записано. Инвентаризация — хоть голосом, за вечер.' },
    ],
    howTitle: 'Как начать',
    steps: [
      { n: '01', t: 'Завели товары', d: 'Из Excel — колонки распознаются сами. Или прямо из накладной по фото.' },
      { n: '02', t: 'Поставили кассу', d: 'Любой Windows-компьютер, Android-планшет или Sunmi. Сканер и принтер — в пару кликов.' },
      { n: '03', t: 'Смотрите отчёты', d: 'Выручка, прибыль, смены и недостачи — в кабинете и на телефоне.' },
    ],
    howNote: 'Переезд с другой программы или из Excel — за час: остатки и долги покупателей переезжают с вами, импорт можно откатить одной кнопкой.',
    offTitle: 'Касса торгует даже без интернета',
    offD: 'Провайдер лёг на сутки — касса пробивает чеки, открывает и закрывает смены, принимает возвраты и долги. Интернет вернулся — всё само доехало на сервер, до тенге.',
    offQ: 'Очередь событий доезжает на сервер, когда сеть появляется. Повторная отправка не создаёт дублей.',
    offChips: ['чеки и возвраты', 'смены и X/Z-отчёты', 'долги и лимиты', 'бонусы', 'техкарты'],
    offBtn: 'Подробнее про кассу',
    mockShift: 'Касса · смена №14', mockOffline: 'офлайн · в очереди 3 чека', mockTotal: 'Итого', mockPay: 'Оплата',
    mockNote: 'интернет вернётся — чеки сами уедут на сервер',
    prods: [['Хлеб', '160 ₸'], ['Молоко 3,2%', '540 ₸'], ['Кефир 2,5%', '430 ₸'], ['Сок яблочный', '620 ₸'], ['Чай чёрный', '980 ₸'], ['Сахар 1 кг', '590 ₸']],
    receipt: [['Хлеб ×2', '320 ₸'], ['Молоко 3,2%', '540 ₸'], ['Сахар 1 кг', '590 ₸'], ['Спички', '280 ₸']],
    only: 'Только у Табыс',
    f7t: 'Накладная из фото',
    f7d: 'Сфотографируйте накладную от поставщика — позиции, количества и цены распознаются сами. Такого больше нет ни в одной программе учёта для магазинов Казахстана.',
    goldPts: [
      { t: 'Сверка с заказом', d: 'заказали 25, привезли 20 — недовоз подсвечен до проведения.' },
      { t: 'Контроль цен закупки', d: 'цена выше прошлой поставки — подорожание видно, с процентом.' },
      { t: 'Новые товары — сами', d: 'позиции, которых нет в каталоге, создаются черновиком.' },
    ],
    goldHuman: 'Ничего не записывается без вас: AI готовит черновик, подтверждает человек.',
    goldPhoto: 'фото накладной от поставщика', goldBtn: 'Провести приёмку', goldDraft: 'черновик — подтверждает человек',
    inv: [
      { n: 'Молоко 3,2% · 20 шт', note: 'заказано 25', b: 'недовоз 5', bg: '#FBEAE7', c: C.bad },
      { n: 'Кефир 2,5% · 30 шт', note: '250 → 300 ₸', b: 'цена +20%', bg: C.goldTint, c: C.goldInk },
      { n: 'Хлеб бородинский · 40 шт', note: 'нет в каталоге', b: 'новый товар', bg: C.brandTint, c: C.brandDark },
    ],
    kaspiTitle: 'Заказы с Kaspi — в вашей системе',
    kaspiD: 'Подключите Kaspi Магазин: заказы приходят в кабинет, а цены и остатки уходят обратно сами.',
    kaspiP1: 'Остаток один на всё: касса и Kaspi списывают один склад — двойной продажи не будет.',
    kaspiP2: 'Чего нет в наличии — на витрину не уходит.',
    kaspiMockT: '· заказы', kaspiMockNote: 'единый остаток: заказ списал склад магазина',
    orders: [
      { id: '№4712', n: 'Наушники TWS', s: 'Принять', bg: C.brand, c: '#fff', br: C.brand },
      { id: '№4711', n: 'Чайник электрический', s: 'Собрать', bg: '#fff', c: C.ink, br: '#D8D8CF' },
      { id: '№4710', n: 'Кабель USB-C', s: 'Выдан ✓', bg: C.brandTint, c: C.brandDark, br: C.brandTint },
    ],
    lawTitle: 'Учёт по закону Казахстана',
    law: [
      { k: 'ОФД', t: 'Фискализация', d: 'Чеки уходят в налоговую через аккредитованных ОФД-провайдеров. Пробитый офлайн чек фискализируется, когда связь вернётся.' },
      { k: 'УКМ', t: 'Акциз алкоголя', d: 'Проверка марки по серии и номеру. Повторная продажа той же марки отбивается — клон не пройдёт.' },
      { k: 'ИС МПТ', t: 'Маркировка', d: 'DataMatrix: приёмка со сверкой, вывод из оборота при продаже. Пиво и моторные масла — уже с февраля 2026.' },
      { k: '910', t: 'Форма 910', d: 'Налоги считаются по местным ставкам, форма 910 — без бухгалтерских таблиц.' },
    ],
    shotsTitle: 'Как это выглядит',
    cabNav: ['Отчёты', 'Товары', 'Склад', 'Kaspi', 'Финансы'],
    cabStat1: 'Выручка сегодня', cabStat2: 'Прибыль',
    zTitle: 'Смена №14 · Z-отчёт', zClosed: 'закрыта 21:04',
    z: [['Продаж', '96', C.ink], ['Возвратов', '2', C.ink], ['Наличными и картой', '248 400 ₸', C.ink], ['Недостача', '0 ₸', C.brand]],
    phToday: 'сегодня', phChecks: 'Чеков', phAlert: 'Молоко 3,2% заканчивается — осталось на 1 день',
    shot1: 'кабинет владельца — склад и отчёты', shot2: 'касса — смена и Z-отчёт', shot3: 'телефон — магазин в кармане',
    chkTitle: 'Спросите это у любой программы учёта',
    chkSub: 'Восемь вопросов, на которых обычно всё и выясняется. Наши ответы — ниже, проверить можно за 14 бесплатных дней.',
    chkNote: 'Это не обещания на будущее: каждый пункт работает у действующего клиента и закрыт автопроверками.',
    checks: [
      { q: 'Что будет, если интернет пропадёт на весь день?', a: 'У нас касса торгует дальше: чеки, смены, возвраты, долги. Связь вернулась — всё уехало на сервер до тенге, без дублей.' },
      { q: 'Сколько времени займёт приёмка накладной на 40 позиций?', a: 'Одно фото. Позиции, количества и цены разбираются сами, недовоз и подорожание подсвечены до проведения.' },
      { q: 'Можно дать товар в долг и не забыть об этом?', a: 'Долговая тетрадь живёт в кассе: лимит на покупателя проверяется при продаже, долг печатается на чеке. Работает и офлайн.' },
      { q: 'Сколько стоит второй продавец? Третий?', a: 'Ноль. Сотрудники и устройства кассы входят в тариф — доплат за людей и планшеты нет.' },
      { q: 'А если я торгую алкоголем или маркированным товаром?', a: 'Проверка акцизной марки, приёмка со сверкой и вывод из оборота при продаже — внутри, в тарифе «Стандарт». Отдельного приложения не нужно.' },
      { q: 'Заказы с Kaspi придут в систему сами?', a: 'Да, и остаток при этом один: касса и Kaspi списывают тот же склад — двойной продажи не будет.' },
      { q: 'Кассир говорит только по-казахски. Это проблема?', a: 'Нет. Интерфейс, названия товаров и поддержка — на казахском и русском, с первого экрана.' },
      { q: 'Если я захочу уйти — данные отдадите?', a: 'В любой момент выгрузка товаров, продаж и покупателей в Excel. Данные ваши, держать вас силой мы не собираемся.' },
    ],
    freeT: 'А почему не бесплатно?',
    freeD: 'Бесплатная касса и учёт магазина — разные вещи: пробить чек мало, если не видно остатков, закупок и прибыли. 6 900 ₸ в месяц — это дешевле одного рабочего дня товароведа, а считает он за вас каждый день.',
    prTitle: 'Цены — открыто, два тарифа', prPer: '₸/мес',
    prN: ['14 дней бесплатно', 'Карта не нужна', 'Цена зафиксирована на год с момента подписки'],
    prInclT: 'Что умеет система', prMore: 'Подробнее о ценах',
    tariffs: [
      { name: 'Старт', price: '6 900', sub: 'Одна точка, одна касса', main: false },
      { name: 'Стандарт', price: '14 900', sub: 'Несколько точек, опт, маркировка', main: true },
    ],
    incl: ['Касса — и без интернета', 'Товары и склад без лимитов', 'Сотрудники без лимита', 'Долги и бонусы покупателей', 'Накладная из фото', 'Kaspi Магазин', 'Акциз, маркировка, форма 910', 'Отчёты и зарплата'],
    rvTitle: 'Отзывы — скоро. И только настоящие',
    rvD: 'Продукт стоит у клиента и проходит 1500+ автопроверок перед каждым обновлением, но отзывы мы не выдумываем. Здесь появятся слова первых магазинов — с именем, городом и деталями.',
    rvSlot: 'место под отзыв: имя, город, магазин', rvCta: 'Станьте одним из первых — 14 дней бесплатно',
    faqTitle: 'Частые вопросы', faqAll: 'Все вопросы и ответы',
    faqs: [
      { q: 'Правда работает без интернета?', a: 'Да. Вся касса — продажи, смены, X/Z-отчёты, возвраты, долги — работает локально. Очередь событий доезжает на сервер, когда сеть появляется; повторная отправка не создаёт дублей.' },
      { q: 'Как переехать с другой программы?', a: 'Выгрузите номенклатуру в Excel и загрузите в кабинет: колонки сопоставляются автоматически, проблемные строки видны до импорта, импорт можно откатить одной кнопкой.' },
      { q: 'Что с фискализацией?', a: 'Работаем через аккредитованных ОФД-провайдеров Казахстана — подключим того, с кем вы уже работаете. Чеки, пробитые офлайн, фискализируются при появлении связи. Продажа в долг не фискализируется — деньги ещё не получены.' },
      { q: 'Какое оборудование нужно?', a: 'Любой Windows-компьютер, Android-планшет или Sunmi-терминал. Сканеры, чековые принтеры 58/80 мм, весы Rongta — подключаются в пару кликов.' },
      { q: 'Мои данные — мои?', a: 'Да. В любой момент выгружайте товары, продажи и покупателей в Excel. Уходите — данные заберёте с собой.' },
    ],
    leadTitle: 'Оставьте заявку — перезвоним',
    leadSub: 'Поможем перенести товары, настроить кассу и обучить кассира. Говорим по-казахски и по-русски.',
    leadNote: 'Перезваниваем в рабочее время. Переезд с другой программы или из Excel — вместе с вашими остатками и долгами покупателей.',
    fPhone: 'Телефон · +7 7XX XXX XX XX', fShop: 'Название магазина',
    fSend: 'Оставить заявку', fDone: 'Заявка принята! Перезвоним в рабочее время.',
    fErrPhone: 'Введите телефон полностью — 10 цифр после +7.',
    fMicro: 'ничего лишнего: телефон и название магазина — этого достаточно',
    langLong: 'Қазақша оқу → ҚАЗ',
  },
  kk: {
    ctaStart: 'Тегін бастау', ctaPilot: 'Көшірумен пилот керек',
    heroTitle: 'Жанындағы дүкенге арналған есеп.\nКасса интернетсіз де сата береді.',
    heroSub: 'Тауар, қойма, сатып алушылардың қарызы, бонустар мен есептер — бір жерде. Тіркелу 2 минут, менеджерге қоңырау шалмай-ақ. 14 күн тегін.',
    trust: 'Деректер Қазақстанда сақталады · Әр жаңартудың алдында 1500+ автотексеру · Қолдау қазақша және орысша',
    heroCard1: '14:02 — интернет өшті', heroCard2: '14:03 — чек соғылды ✓',
    heroPhoto: 'фото: жанындағы дүкеннің сөресі,', heroPhoto2: 'касса және сатушы · 1200×1500',
    k1: '01 · Таныс па?', k2: '02 · Бастау', k3: '03 · Касса', k5: '04 · Kaspi', k6: '05 · Заң', k7: '06 · Өнім', k8: '07 · Тексеру', k9: '08 · Бағалар', k10: '09 · Пікірлер', k11: '10 · Сұрақтар',
    painTitle: 'Есепсіз дүкен неден айырылады',
    pains: [
      { t: 'Ауысымнан кейін кассада минус', d: 'Ауысым жабылды — жәшікте ақша жетпейді. Кім, қашан, қанша — белгісіз.', s: 'Әр ауысым теңгесіне дейін дәл. Жетіспеушілік бірден көрінеді — кассир бойынша да.' },
      { t: 'Жүрдек тауар таусылды', d: 'Сөре жұма кеші босап қалды — оны сатып алушыдан білдіңіз.', s: 'Қалдық телефоннан көрінеді, жүйе нені қосымша алу керегін өзі айтады.' },
      { t: 'Қарыздар — дәптерде', d: 'Дәптер жоғалды, «мен қайтарғанмын» — дәлел жоқ.', s: 'Қарыз дәптері кассада: лимит, тарих, қарыз чекте басылады.' },
      { t: 'Қорап қоймадан жоғалды', d: 'Бір айдан кейін санағанда байқадыңыз. Ақша қайтпайды.', s: 'Әр қозғалыс жазулы. Түгендеу — тіпті дауыспен, бір кеште.' },
    ],
    howTitle: 'Қалай бастау керек',
    steps: [
      { n: '01', t: 'Тауарларды енгіздіңіз', d: 'Excel-ден — бағандар өзі танылады. Немесе тікелей жүкқұжат фотосынан.' },
      { n: '02', t: 'Кассаны орнаттыңыз', d: 'Кез келген Windows-компьютер, Android-планшет немесе Sunmi. Сканер мен принтер — бірнеше клик.' },
      { n: '03', t: 'Есептерді көресіз', d: 'Түсім, пайда, ауысымдар мен жетіспеушілік — кабинетте және телефонда.' },
    ],
    howNote: 'Басқа бағдарламадан немесе Excel-ден көшу — бір сағат: қалдықтар мен сатып алушылардың қарызы сізбен бірге көшеді, импортты бір батырмамен кері қайтаруға болады.',
    offTitle: 'Касса интернетсіз де сата береді',
    offD: 'Интернет бір тәулікке өшсе де — касса чек соғады, ауысымды ашып-жабады, қайтарым мен қарызды қабылдайды. Желі оралғанда бәрі серверге теңгесіне дейін дәл жетеді.',
    offQ: 'Оқиғалар кезегі желі пайда болғанда серверге жетеді. Қайта жіберу дубль жасамайды.',
    offChips: ['чектер мен қайтарымдар', 'ауысым және X/Z-есептер', 'қарыз бен лимиттер', 'бонустар', 'техкарталар'],
    offBtn: 'Касса туралы толығырақ',
    mockShift: 'Касса · ауысым №14', mockOffline: 'офлайн · кезекте 3 чек', mockTotal: 'Барлығы', mockPay: 'Төлем',
    mockNote: 'интернет оралса — чектер серверге өзі кетеді',
    prods: [['Нан', '160 ₸'], ['Сүт 3,2%', '540 ₸'], ['Кефир 2,5%', '430 ₸'], ['Алма шырыны', '620 ₸'], ['Қара шай', '980 ₸'], ['Қант 1 кг', '590 ₸']],
    receipt: [['Нан ×2', '320 ₸'], ['Сүт 3,2%', '540 ₸'], ['Қант 1 кг', '590 ₸'], ['Сіріңке', '280 ₸']],
    only: 'Тек Табыста',
    f7t: 'Фотодан жүкқұжат',
    f7d: 'Жеткізушінің жүкқұжатын суретке түсіріңіз — позициялар, саны мен бағасы өзі танылады. Мұндай мүмкіндік Қазақстандағы басқа бірде-бір есеп бағдарламасында жоқ.',
    goldPts: [
      { t: 'Тапсырыспен салыстыру', d: 'тапсырыс 25, әкелгені 20 — кем әкелу өткізуге дейін көрінеді.' },
      { t: 'Сатып алу бағасын бақылау', d: 'баға өткен жеткізілімнен жоғары — қымбаттау пайызбен көрінеді.' },
      { t: 'Жаңа тауарлар — өзі', d: 'каталогта жоқ позициялар жоба болып жасалады.' },
    ],
    goldHuman: 'Сізсіз ештеңе жазылмайды: AI жобаны дайындайды, адам растайды.',
    goldPhoto: 'жеткізуші жүкқұжатының фотосы', goldBtn: 'Қабылдауды өткізу', goldDraft: 'жоба — адам растайды',
    inv: [
      { n: 'Сүт 3,2% · 20 дана', note: 'тапсырыс 25', b: 'кем әкелу 5', bg: '#FBEAE7', c: C.bad },
      { n: 'Кефир 2,5% · 30 дана', note: '250 → 300 ₸', b: 'баға +20%', bg: C.goldTint, c: C.goldInk },
      { n: 'Бородино наны · 40 дана', note: 'каталогта жоқ', b: 'жаңа тауар', bg: C.brandTint, c: C.brandDark },
    ],
    kaspiTitle: 'Kaspi тапсырыстары — өз жүйеңізде',
    kaspiD: 'Kaspi Магазинді қосыңыз: тапсырыстар кабинетке келеді, баға мен қалдық кері өзі жіберіледі.',
    kaspiP1: 'Қалдық біреу: касса мен Kaspi бір қойманы шегереді — қос сату болмайды.',
    kaspiP2: 'Қолда жоғы витринаға шықпайды.',
    kaspiMockT: '· тапсырыстар', kaspiMockNote: 'бірыңғай қалдық: тапсырыс дүкен қоймасынан шегерілді',
    orders: [
      { id: '№4712', n: 'TWS құлаққап', s: 'Қабылдау', bg: C.brand, c: '#fff', br: C.brand },
      { id: '№4711', n: 'Электр шәйнегі', s: 'Жинау', bg: '#fff', c: C.ink, br: '#D8D8CF' },
      { id: '№4710', n: 'USB-C кабелі', s: 'Берілді ✓', bg: C.brandTint, c: C.brandDark, br: C.brandTint },
    ],
    lawTitle: 'Қазақстан заңы бойынша есеп',
    law: [
      { k: 'ОФД', t: 'Фискализация', d: 'Чектер аккредиттелген ОФД-провайдерлер арқылы салыққа кетеді. Офлайн соғылған чек байланыс оралғанда фискалданады.' },
      { k: 'УКМ', t: 'Алкоголь акцизі', d: 'Марканы серия мен нөмір бойынша тексеру. Сол марканы қайта сату тыйылады — клон өтпейді.' },
      { k: 'ИС МПТ', t: 'Таңбалау', d: 'DataMatrix: салыстырумен қабылдау, сатқанда айналымнан шығару. Сыра мен мотор майлары — 2026 жылғы ақпаннан.' },
      { k: '910', t: '910-форма', d: 'Салық жергілікті мөлшерлемелермен есептеледі, 910-форма — бухгалтерлік кестесіз.' },
    ],
    shotsTitle: 'Бұл қалай көрінеді',
    cabNav: ['Есептер', 'Тауарлар', 'Қойма', 'Kaspi', 'Қаржы'],
    cabStat1: 'Бүгінгі түсім', cabStat2: 'Пайда',
    zTitle: 'Ауысым №14 · Z-есеп', zClosed: 'жабылды 21:04',
    z: [['Сату', '96', C.ink], ['Қайтарым', '2', C.ink], ['Қолма-қол және картамен', '248 400 ₸', C.ink], ['Жетіспеушілік', '0 ₸', C.brand]],
    phToday: 'бүгін', phChecks: 'Чектер', phAlert: 'Сүт 3,2% таусылып барады — 1 күнге жетеді',
    shot1: 'иесінің кабинеті — қойма және есептер', shot2: 'касса — ауысым және Z-есеп', shot3: 'телефон — дүкен қалтада',
    chkTitle: 'Мұны кез келген есеп бағдарламасынан сұраңыз',
    chkSub: 'Әдетте бәрі осы сегіз сұрақта анықталады. Біздің жауаптар — төменде, 14 тегін күнде тексеруге болады.',
    chkNote: 'Бұл болашақтағы уәде емес: әр тармақ жұмыс істеп тұрған клиентте қолданылады және автотексерулермен қамтылған.',
    checks: [
      { q: 'Интернет күні бойы жоқ болса не болады?', a: 'Бізде касса сата береді: чектер, ауысымдар, қайтарымдар, қарыздар. Байланыс оралғанда бәрі серверге теңгесіне дейін дәл кетті, дубльсіз.' },
      { q: '40 позициялық жүкқұжатты қабылдау қанша уақыт алады?', a: 'Бір фото. Позициялар, саны мен бағасы өзі талданады, кем әкелу мен қымбаттау өткізуге дейін көрінеді.' },
      { q: 'Тауарды қарызға беріп, ұмытпауға болады ма?', a: 'Қарыз дәптері кассада: сатып алушының лимиті сату кезінде тексеріледі, қарыз чекте басылады. Офлайн да жұмыс істейді.' },
      { q: 'Екінші сатушы қанша тұрады? Үшіншісі?', a: 'Нөл. Қызметкерлер мен касса құрылғылары тарифке кіреді — адам мен планшет үшін қосымша ақы жоқ.' },
      { q: 'Алкоголь немесе таңбаланған тауар сатсам?', a: 'Акциз маркасын тексеру, салыстырумен қабылдау және сатқанда айналымнан шығару — ішінде, «Стандарт» тарифінде. Бөлек қолданба керек емес.' },
      { q: 'Kaspi тапсырыстары жүйеге өзі келе ме?', a: 'Иә, әрі қалдық біреу: касса мен Kaspi сол қойманы шегереді — қос сату болмайды.' },
      { q: 'Кассир тек қазақша сөйлейді. Бұл мәселе ме?', a: 'Жоқ. Интерфейс, тауар атаулары және қолдау — қазақша және орысша, бірінші экраннан.' },
      { q: 'Кетуді қаласам — деректерді бересіздер ме?', a: 'Кез келген сәтте тауар, сату және сатып алушыларды Excel-ге түсіру. Деректер сіздікі, күшпен ұстамаймыз.' },
    ],
    freeT: 'Ал неге тегін емес?',
    freeD: 'Тегін касса мен дүкен есебі — әр басқа: қалдық, сатып алу мен пайда көрінбесе, чек соғу жеткіліксіз. Айына 6 900 ₸ — тауартанушының бір жұмыс күнінен арзан, ал ол сіз үшін күн сайын санайды.',
    prTitle: 'Бағалар — ашық, екі тариф', prPer: '₸/ай',
    prN: ['14 күн тегін', 'Карта керек емес', 'Баға жазылған сәттен бір жылға бекітіледі'],
    prInclT: 'Жүйе не істей алады', prMore: 'Бағалар туралы толығырақ',
    tariffs: [
      { name: 'Старт', price: '6 900', sub: 'Бір нүкте, бір касса', main: false },
      { name: 'Стандарт', price: '14 900', sub: 'Бірнеше нүкте, көтерме, таңбалау', main: true },
    ],
    incl: ['Касса — интернетсіз де', 'Тауар мен қойма шектеусіз', 'Қызметкерлер шектеусіз', 'Қарыз бен бонустар', 'Фотодан жүкқұжат', 'Kaspi Магазин', 'Акциз, таңбалау, 910-форма', 'Есептер мен жалақы'],
    rvTitle: 'Пікірлер — жақында. Тек шынайысы',
    rvD: 'Өнім клиентте жұмыс істейді және әр жаңартудың алдында 1500+ автотексеруден өтеді, бірақ пікірді ойдан шығармаймыз. Мұнда алғашқы дүкендердің сөзі шығады — аты, қаласы және егжей-тегжейімен.',
    rvSlot: 'пікірге орын: аты, қаласы, дүкені', rvCta: 'Алғашқылардың бірі болыңыз — 14 күн тегін',
    faqTitle: 'Жиі қойылатын сұрақтар', faqAll: 'Барлық сұрақ-жауап',
    faqs: [
      { q: 'Шынымен интернетсіз жұмыс істей ме?', a: 'Иә. Бүкіл касса — сату, ауысым, X/Z-есептер, қайтарым, қарыз — жергілікті жұмыс істейді. Желі пайда болғанда оқиғалар кезегі серверге жетеді; қайта жіберу дубль жасамайды.' },
      { q: 'Басқа бағдарламадан қалай көшемін?', a: 'Номенклатураны Excel-ге түсіріп, кабинетке жүктеңіз: бағандар автоматты сәйкестендіріледі, қате жолдар импортқа дейін көрінеді, импортты бір батырмамен кері қайтаруға болады.' },
      { q: 'Фискализация ше?', a: 'Қазақстанның аккредиттелген ОФД-провайдерлері арқылы жұмыс істейміз — сіз пайдаланып жүргенін қосамыз. Офлайн соғылған чектер байланыс пайда болғанда фискалданады. Қарызға сату фискалданбайды — ақша әлі алынған жоқ.' },
      { q: 'Қандай жабдық керек?', a: 'Кез келген Windows-компьютер, Android-планшет немесе Sunmi-терминал. Сканерлер, 58/80 мм чек принтерлері, Rongta таразылары — бірнеше кликпен қосылады.' },
      { q: 'Деректерім — менікі ме?', a: 'Иә. Кез келген сәтте тауарды, сатуды және сатып алушыларды Excel-ге түсіре аласыз. Кетсеңіз — деректеріңізді өзіңізбен аласыз.' },
    ],
    leadTitle: 'Өтінім қалдырыңыз — қоңырау шаламыз',
    leadSub: 'Тауарды көшіруге, кассаны баптауға және кассирді үйретуге көмектесеміз. Қазақша және орысша сөйлейміз.',
    leadNote: 'Жұмыс уақытында қоңырау шаламыз. Басқа бағдарламадан немесе Excel-ден көшу — қалдықтарыңызбен және сатып алушылардың қарызымен бірге.',
    fPhone: 'Телефон · +7 7XX XXX XX XX', fShop: 'Дүкен атауы',
    fSend: 'Өтінім қалдыру', fDone: 'Өтінім қабылданды! Жұмыс уақытында қоңырау шаламыз.',
    fErrPhone: 'Телефонды толық енгізіңіз — +7-ден кейін 10 цифр.',
    fMicro: 'артық ештеңе жоқ: телефон мен дүкен атауы — жеткілікті',
    langLong: 'Читать по-русски → РУС',
  },
};

export default function Landing() {
  const [lang, toggleLang] = useLang();
  const mobile = useMobile();
  const [form, setForm] = useState<any>({});
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const t = T[lang];

  /** POST /public/leads — контракт не менялся: honeypot website + лимит по IP на сервере. */
  const submit = async () => {
    setErr('');
    const digits = (String(form.phone ?? '').match(/\d/g) ?? []).length;
    if (digits < 10) { setErr(t.fErrPhone); return; }
    try {
      const r = await fetch(`${API}/public/leads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.shop, phone: form.phone, city: '', comment: '', locale: lang, website: form.website ?? '' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? 'Ошибка');
      setSent(true);
    } catch (e: any) { setErr(e.message); }
  };

  const photo = (ratio: string, tint = false) => ({
    aspectRatio: ratio, border: `1px solid ${tint ? C.goldLine : C.line}`, borderRadius: 14, overflow: 'hidden', position: 'relative' as const,
    background: `repeating-linear-gradient(135deg, ${C.card} 0 12px, ${tint ? '#FDF7EC' : C.bg} 12px 24px)`,
  });

  return (
    <div style={{ color: C.ink, background: C.card }}>
      <SiteHeader lang={lang} onLang={toggleLang} />

      {/* ---------- 1. герой ---------- */}
      <section style={{ maxWidth: 1080, margin: '0 auto', padding: 'clamp(40px,7vw,72px) clamp(16px,4vw,24px) clamp(44px,6vw,64px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(32px,5vw,56px)', alignItems: 'center' }}>
        <div>
          <div style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: C.goldInk }}>Тәртіп — табыстың басы</div>
          <h1 style={{ fontSize: 'clamp(31px,5.3vw,45px)', fontWeight: 600, letterSpacing: '-.022em', lineHeight: 1.13, margin: '16px 0 0', whiteSpace: 'pre-line', textWrap: 'pretty' } as any}>{t.heroTitle}</h1>
          <p style={{ fontSize: 'clamp(16px,2vw,17.5px)', lineHeight: 1.55, color: C.prose, margin: '18px 0 0', maxWidth: '54ch' }}>{t.heroSub}</p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 30 }}>
            <a href="/register" style={S.btn}>{t.ctaStart}</a>
            <a href="#lead" style={S.ghost}>{t.ctaPilot}</a>
          </div>
          <p style={{ fontSize: 13, color: C.dim, lineHeight: 1.6, margin: '22px 0 0', maxWidth: '56ch' }}>{t.trust}</p>
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ ...photo('4 / 5'), maxHeight: 520 }}>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '12px 14px', background: 'rgba(255,255,255,.93)', borderTop: `1px solid ${C.line}`, fontFamily: mono, fontSize: 12, color: C.dim, lineHeight: 1.5 }}>
              {t.heroPhoto}<br />{t.heroPhoto2}
            </div>
          </div>
          <div style={{ position: 'absolute', top: 14, left: 14, background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 13px', boxShadow: '0 8px 24px rgba(23,33,29,.08)', fontFamily: mono, fontSize: 12, lineHeight: 1.7, color: C.prose }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: C.bad }} />{t.heroCard1}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: C.brand }} />{t.heroCard2}</div>
          </div>
        </div>
      </section>

      {/* ---------- 2. боль владельца ---------- */}
      <section style={{ background: C.sunken, borderTop: `1px solid ${C.lineIn}`, borderBottom: `1px solid ${C.lineIn}` }}>
        <div style={{ ...S.wrap, padding: 'clamp(48px,7vw,72px) clamp(16px,4vw,24px)' }}>
          <div style={S.kicker}>{t.k1}</div>
          <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 26px' }}>{t.painTitle}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(235px,1fr))', gap: 14 }}>
            {t.pains.map((p: any) => (
              <div key={p.t} style={{ ...S.card, display: 'flex', flexDirection: 'column' }}>
                <b style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{p.t}</b>
                <p style={{ color: C.prose, fontSize: 13.5, margin: '8px 0 0', lineHeight: 1.55, flex: 1 }}>{p.d}</p>
                <p style={{ color: C.brand, fontSize: 13.5, fontWeight: 500, margin: '12px 0 0', lineHeight: 1.5, borderTop: `1px solid ${C.lineIn}`, paddingTop: 12 }}>{p.s}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- 3. как начать ---------- */}
      <section style={{ ...S.sec, paddingTop: 'clamp(52px,8vw,80px)' }}>
        <div style={S.kicker}>{t.k2}</div>
        <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 26px' }}>{t.howTitle}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14 }}>
          {t.steps.map((s: any) => (
            <div key={s.n} style={{ ...S.card, padding: '22px 24px' }}>
              <div style={{ fontFamily: mono, fontSize: 13, color: C.goldInk }}>{s.n}</div>
              <b style={{ display: 'block', fontSize: 17, fontWeight: 600, marginTop: 10 }}>{s.t}</b>
              <p style={{ color: C.prose, fontSize: 14, margin: '8px 0 0', lineHeight: 1.6 }}>{s.d}</p>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 14, color: C.prose, lineHeight: 1.6, margin: '16px 0 0', maxWidth: '76ch' }}>
          <span style={{ color: C.brand, fontWeight: 600 }}>→</span> {t.howNote}
        </p>
      </section>

      {/* ---------- 4. касса без интернета ---------- */}
      <section style={{ ...S.sec, paddingTop: 'clamp(52px,8vw,80px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(28px,4vw,48px)', alignItems: 'center' }}>
        <div>
          <div style={S.kicker}>{t.k3}</div>
          <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 0' }}>{t.offTitle}</h2>
          <p style={{ fontSize: 15.5, lineHeight: 1.6, color: C.prose, margin: '14px 0 0', maxWidth: '52ch' }}>{t.offD}</p>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: C.dim, margin: '12px 0 0', maxWidth: '52ch' }}>{t.offQ}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }}>
            {t.offChips.map((c: string) => (
              <span key={c} style={{ background: C.brandTint, color: C.brandDark, borderRadius: 999, padding: '7px 13px', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>{c}</span>
            ))}
          </div>
          <div style={{ marginTop: 24 }}>
            <a href="/касса" style={{ ...S.ghost, minHeight: 48, fontSize: 15, borderColor: C.brand, color: C.brand }}>{t.offBtn}</a>
          </div>
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, boxShadow: '0 20px 44px rgba(23,33,29,.07)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${C.lineIn}`, background: C.sunken }}>
            <span style={{ width: 9, height: 9, borderRadius: 99, background: '#D8D8CF' }} />
            <b style={{ fontSize: 13.5, fontWeight: 600 }}>{t.mockShift}</b>
            <div style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: C.goldTint, color: C.goldInk, borderRadius: 999, padding: '5px 11px', fontFamily: mono, fontSize: 11.5, whiteSpace: 'nowrap' }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: C.gold }} />{t.mockOffline}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.25fr minmax(0,1fr)' }}>
            <div style={{ padding: 14, display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, alignContent: 'start', borderRight: `1px solid ${C.lineIn}` }}>
              {t.prods.map((p: string[]) => (
                <div key={p[0]} style={{ border: `1px solid ${C.line}`, borderRadius: 9, padding: '10px 11px', minHeight: 52, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.25 }}>{p[0]}</span>
                  <span style={{ fontFamily: mono, fontSize: 11.5, color: C.dim, marginTop: 3 }}>{p[1]}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column' }}>
              {t.receipt.map((r: string[]) => (
                <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: mono, fontSize: 11.5, color: C.prose, padding: '4px 0' }}>
                  <span>{r[0]}</span><span style={{ whiteSpace: 'nowrap' }}>{r[1]}</span>
                </div>
              ))}
              <div style={{ flex: 1 }} />
              <div style={{ borderTop: '1px dashed #D8D8CF', marginTop: 8, paddingTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600 }}>
                <span>{t.mockTotal}</span><span style={{ fontFamily: mono, whiteSpace: 'nowrap' }}>1 730 ₸</span>
              </div>
              <div style={{ background: C.brand, color: '#fff', borderRadius: 9, minHeight: 44, marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>{t.mockPay}</div>
            </div>
          </div>
          <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.lineIn}`, fontFamily: mono, fontSize: 11.5, color: C.dim }}>{t.mockNote}</div>
        </div>
      </section>

      {/* ---------- 5. накладная из фото — главное отличие, золотом ---------- */}
      <section style={{ background: C.goldPaper, borderTop: `1px solid ${C.goldLine}`, borderBottom: `1px solid ${C.goldLine}`, marginTop: 'clamp(52px,8vw,80px)' }}>
        <div style={{ ...S.wrap, padding: 'clamp(48px,7vw,72px) clamp(16px,4vw,24px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(28px,4vw,52px)', alignItems: 'center' }}>
          <div>
            <div style={{ display: 'inline-block', background: C.goldTint, color: C.goldInk, padding: '5px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 500, letterSpacing: '.04em' }}>{t.only}</div>
            <h2 style={{ ...S.h2, fontSize: 'clamp(26px,4.4vw,34px)', margin: '16px 0 0' }}>{t.f7t}</h2>
            <p style={{ fontSize: 15.5, lineHeight: 1.6, color: C.prose, margin: '14px 0 0', maxWidth: '54ch' }}>{t.f7d}</p>
            <div style={{ display: 'grid', gap: 12, marginTop: 22 }}>
              {t.goldPts.map((g: any) => (
                <div key={g.t} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{ width: 22, height: 22, borderRadius: 99, background: C.goldTint, color: C.goldInk, fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>✓</span>
                  <div><b style={{ fontSize: 14.5, fontWeight: 600 }}>{g.t}</b><span style={{ color: C.prose, fontSize: 14, lineHeight: 1.55 }}> — {g.d}</span></div>
                </div>
              ))}
            </div>
            <p style={{ fontFamily: mono, fontSize: 12.5, color: C.goldInk, margin: '20px 0 0', lineHeight: 1.6 }}>{t.goldHuman}</p>
          </div>
          <div style={{ background: C.card, border: `1px solid ${C.goldLine}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 20px 44px rgba(138,95,27,.08)' }}>
            <div style={{ height: 64, background: `repeating-linear-gradient(135deg, ${C.card} 0 12px, #FDF7EC 12px 24px)`, borderBottom: `1px solid ${C.goldLine}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: mono, fontSize: 12, color: C.goldInk }}>{t.goldPhoto}</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0', color: C.gold, fontSize: 15 }}>↓</div>
            <div style={{ padding: '0 16px 14px', display: 'grid', gap: 8 }}>
              {t.inv.map((r: any) => (
                <div key={r.n} style={{ border: `1px solid ${C.lineIn}`, borderRadius: 9, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 130 }}>{r.n}</span>
                  <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.note}</span>
                  <span style={{ background: r.bg, color: r.c, borderRadius: 999, padding: '4px 10px', fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap' }}>{r.b}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                <div style={{ background: C.brand, color: '#fff', borderRadius: 9, minHeight: 44, padding: '0 18px', display: 'inline-flex', alignItems: 'center', fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap' }}>{t.goldBtn}</div>
                <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>{t.goldDraft}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- 6. Kaspi Магазин ---------- */}
      <section style={{ ...S.sec, paddingTop: 'clamp(52px,8vw,80px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(28px,4vw,48px)', alignItems: 'center' }}>
        <div>
          <div style={S.kicker}>{t.k5}</div>
          <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 0' }}>{t.kaspiTitle}</h2>
          <p style={{ fontSize: 15.5, lineHeight: 1.6, color: C.prose, margin: '14px 0 0', maxWidth: '52ch' }}>{t.kaspiD}</p>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: C.prose, margin: '12px 0 0', maxWidth: '52ch' }}><span style={{ color: C.brand, fontWeight: 600 }}>→</span> {t.kaspiP1}</p>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: C.prose, margin: '8px 0 0', maxWidth: '52ch' }}><span style={{ color: C.brand, fontWeight: 600 }}>→</span> {t.kaspiP2}</p>
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 20px 44px rgba(23,33,29,.07)' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.lineIn}`, background: C.sunken, display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontSize: 13.5, fontWeight: 600 }}>Kaspi</b><span style={{ fontSize: 13.5, color: C.dim }}>{t.kaspiMockT}</span>
          </div>
          <div style={{ padding: '8px 16px 14px', display: 'grid', gap: 8 }}>
            {t.orders.map((o: any) => (
              <div key={o.id} style={{ border: `1px solid ${C.lineIn}`, borderRadius: 9, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: mono, fontSize: 11.5, color: C.dim, whiteSpace: 'nowrap' }}>{o.id}</span>
                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{o.n}</span>
                <span style={{ background: o.bg, color: o.c, border: `1px solid ${o.br}`, borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>{o.s}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.lineIn}`, fontFamily: mono, fontSize: 11.5, color: C.dim }}>{t.kaspiMockNote}</div>
        </div>
      </section>

      {/* ---------- 7. закон Казахстана ---------- */}
      <section style={{ background: C.sunken, borderTop: `1px solid ${C.lineIn}`, borderBottom: `1px solid ${C.lineIn}`, marginTop: 'clamp(52px,8vw,80px)' }}>
        <div style={{ ...S.wrap, padding: 'clamp(48px,7vw,72px) clamp(16px,4vw,24px)' }}>
          <div style={S.kicker}>{t.k6}</div>
          <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 26px' }}>{t.lawTitle}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(235px,1fr))', gap: 14 }}>
            {t.law.map((l: any) => (
              <div key={l.k} style={S.card}>
                <div style={S.tag}>{l.k}</div>
                <b style={{ display: 'block', fontSize: 16, fontWeight: 600, marginTop: 12 }}>{l.t}</b>
                <p style={{ color: C.prose, fontSize: 13.5, margin: '8px 0 0', lineHeight: 1.6 }}>{l.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- 8. снимки продукта (макеты, до настоящих скриншотов) ---------- */}
      <section style={{ ...S.sec, paddingTop: 'clamp(52px,8vw,80px)' }}>
        <div style={S.kicker}>{t.k7}</div>
        <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 26px' }}>{t.shotsTitle}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 18, alignItems: 'start' }}>
          <div>
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 14px 34px rgba(23,33,29,.06)' }}>
              <div style={{ display: 'flex', gap: 5, padding: '10px 12px', borderBottom: `1px solid ${C.lineIn}`, background: C.sunken }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: C.line }} />
                <span style={{ width: 8, height: 8, borderRadius: 99, background: C.line }} />
                <span style={{ width: 8, height: 8, borderRadius: 99, background: C.line }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '76px minmax(0,1fr)', minHeight: 210 }}>
                <div style={{ borderRight: `1px solid ${C.lineIn}`, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {t.cabNav.map((x: string, i: number) => (
                    <span key={x} style={{ fontSize: 10.5, color: i === 0 ? C.brandDark : C.dim, fontWeight: i === 0 ? 600 : 400, background: i === 0 ? C.brandTint : 'transparent', borderRadius: 6, padding: '5px 7px', whiteSpace: 'nowrap', overflow: 'hidden' }}>{x}</span>
                  ))}
                </div>
                <div style={{ padding: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(0,1fr))', gap: 8 }}>
                    <div style={{ border: `1px solid ${C.lineIn}`, borderRadius: 8, padding: '9px 10px', minWidth: 0 }}>
                      <div style={{ fontSize: 9.5, color: C.dim }}>{t.cabStat1}</div>
                      <div style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 500, marginTop: 3 }}>248 400 ₸</div>
                    </div>
                    <div style={{ border: `1px solid ${C.lineIn}`, borderRadius: 8, padding: '9px 10px', minWidth: 0 }}>
                      <div style={{ fontSize: 9.5, color: C.dim }}>{t.cabStat2}</div>
                      <div style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 500, marginTop: 3, color: C.brand }}>61 200 ₸</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 86, marginTop: 12, border: `1px solid ${C.lineIn}`, borderRadius: 8, padding: 10 }}>
                    {[34, 52, 41, 66, 58, 78, 47].map((h, i) => (
                      <div key={i} style={{ flex: 1, height: `${h}%`, background: h > 60 ? C.brand : C.brandTint, borderRadius: 3 }} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <p style={{ fontFamily: mono, fontSize: 12, color: C.dim, margin: '10px 0 0' }}>{t.shot1}</p>
          </div>
          <div>
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 14px 34px rgba(23,33,29,.06)' }}>
              <div style={{ padding: '11px 14px', borderBottom: `1px solid ${C.lineIn}`, background: C.sunken, display: 'flex', alignItems: 'center', gap: 8 }}>
                <b style={{ fontSize: 12.5, fontWeight: 600 }}>{t.zTitle}</b>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: mono, fontSize: 10.5, color: C.brand, background: C.brandTint, borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap' }}>{t.zClosed}</span>
              </div>
              <div style={{ padding: '12px 14px', display: 'grid', gap: 8, minHeight: 186, alignContent: 'start' }}>
                {t.z.map((z: any[]) => (
                  <div key={z[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: `1px dashed ${C.lineIn}`, padding: '6px 0' }}>
                    <span style={{ fontSize: 12.5, color: C.prose }}>{z[0]}</span>
                    <span style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 500, color: z[2], whiteSpace: 'nowrap' }}>{z[1]}</span>
                  </div>
                ))}
              </div>
            </div>
            <p style={{ fontFamily: mono, fontSize: 12, color: C.dim, margin: '10px 0 0' }}>{t.shot2}</p>
          </div>
          <div>
            <div style={{ maxWidth: 230, margin: '0 auto', background: C.card, border: `1px solid ${C.line}`, borderRadius: 26, overflow: 'hidden', boxShadow: '0 14px 34px rgba(23,33,29,.06)', padding: 10 }}>
              <div style={{ border: `1px solid ${C.lineIn}`, borderRadius: 18, overflow: 'hidden' }}>
                <div style={{ padding: '10px 12px', background: C.brand, color: '#fff', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{ width: 18, height: 18, borderRadius: 5, background: 'rgba(255,255,255,.18)', fontSize: 10, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Т</div>
                  <b style={{ fontSize: 12, fontWeight: 600 }}>Табыс</b>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: mono, fontSize: 9.5, opacity: .8 }}>{t.phToday}</span>
                </div>
                <div style={{ padding: 12 }}>
                  <div style={{ fontSize: 9.5, color: C.dim }}>{t.cabStat1}</div>
                  <div style={{ fontFamily: mono, fontSize: 19, fontWeight: 500, marginTop: 2, whiteSpace: 'nowrap' }}>248 400 ₸</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(0,1fr))', gap: 7, marginTop: 10 }}>
                    <div style={{ border: `1px solid ${C.lineIn}`, borderRadius: 8, padding: 8, minWidth: 0 }}>
                      <div style={{ fontSize: 9, color: C.dim }}>{t.phChecks}</div>
                      <div style={{ fontFamily: mono, fontSize: 12.5, marginTop: 2 }}>96</div>
                    </div>
                    <div style={{ border: `1px solid ${C.lineIn}`, borderRadius: 8, padding: 8, minWidth: 0 }}>
                      <div style={{ fontSize: 9, color: C.dim }}>{t.cabStat2}</div>
                      <div style={{ fontFamily: mono, fontSize: 12.5, marginTop: 2, color: C.brand }}>61 200 ₸</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 10, border: `1px solid ${C.lineIn}`, borderRadius: 8, padding: '8px 9px', display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: C.gold, flexShrink: 0 }} />
                    <span style={{ fontSize: 9.5, color: C.prose, lineHeight: 1.4 }}>{t.phAlert}</span>
                  </div>
                </div>
              </div>
            </div>
            <p style={{ fontFamily: mono, fontSize: 12, color: C.dim, margin: '10px 0 0', textAlign: 'center' }}>{t.shot3}</p>
          </div>
        </div>
      </section>

      {/* ---------- 9. чек-лист вместо сравнения с конкурентами ---------- */}
      <section style={{ ...S.sec, paddingTop: 'clamp(52px,8vw,80px)' }}>
        <div style={S.kicker}>{t.k8}</div>
        <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 12px' }}>{t.chkTitle}</h2>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: C.prose, margin: '0 0 24px', maxWidth: '72ch' }}>{t.chkSub}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(290px,1fr))', gap: 14 }}>
          {t.checks.map((c: any, i: number) => (
            <div key={c.q} style={{ ...S.card, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                <span style={{ fontFamily: mono, fontSize: 11.5, color: C.goldInk, marginTop: 3 }}>{`0${i + 1}`}</span>
                <b style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{c.q}</b>
              </div>
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.lineIn}` }}>
                <span style={{ width: 20, height: 20, borderRadius: 99, background: C.brandTint, color: C.brandDark, fontSize: 11.5, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>✓</span>
                <span style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.6 }}>{c.a}</span>
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12.5, color: C.faint, marginTop: 14 }}>{t.chkNote}</p>
        <div style={{ ...S.card, background: C.sunken, marginTop: 16, padding: '20px 24px' }}>
          <b style={{ fontSize: 15.5, fontWeight: 600 }}>{t.freeT}</b>
          <p style={{ color: C.prose, fontSize: 14, margin: '8px 0 0', lineHeight: 1.6, maxWidth: '80ch' }}>{t.freeD}</p>
        </div>
      </section>

      {/* ---------- 10. цены открыто ---------- */}
      <section style={{ ...S.sec, paddingTop: 'clamp(52px,8vw,80px)' }}>
        <div style={S.kicker}>{t.k9}</div>
        <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 26px' }}>{t.prTitle}</h2>
        <div style={{ border: `1.5px solid ${C.brand}`, borderRadius: 16, background: C.card, overflow: 'hidden', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
          <div style={{ padding: 'clamp(24px,4vw,36px)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14 }}>
              {t.tariffs.map((p: any) => (
                <div key={p.name} style={{ border: p.main ? `1.5px solid ${C.brand}` : `1px solid ${C.line}`, borderRadius: 12, padding: '16px 18px' }}>
                  <b style={{ fontSize: 15.5, fontWeight: 600 }}>{p.name}</b>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'clamp(28px,4vw,34px)', fontWeight: 600, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{p.price} ₸</span>
                    <span style={{ fontSize: 14, color: C.dim }}>{t.prPer}</span>
                  </div>
                  <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.5, marginTop: 6 }}>{p.sub}</div>
                </div>
              ))}
            </div>
            <div style={{ height: 18 }} />
            <div style={{ display: 'grid', gap: 8, marginTop: 18 }}>
              {t.prN.map((x: string) => (
                <div key={x} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
                  <span style={{ color: C.brand, fontWeight: 600 }}>✓</span><span style={{ fontSize: 14.5, color: C.prose }}>{x}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 26 }}>
              <a href="/register" style={{ ...S.btn, fontSize: 16 }}>{t.ctaStart}</a>
              <a href="/цены" style={{ ...S.ghost, fontSize: 16, borderColor: C.brand, color: C.brand }}>{t.prMore}</a>
            </div>
          </div>
          <div style={{ background: C.sunken, borderLeft: `1px solid ${C.lineIn}`, padding: 'clamp(24px,4vw,36px)' }}>
            <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: '.1em', textTransform: 'uppercase', color: C.dim }}>{t.prInclT}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: '8px 20px', marginTop: 14 }}>
              {t.incl.map((x: string) => (
                <div key={x} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
                  <span style={{ color: C.brand, fontWeight: 600 }}>✓</span><span style={{ fontSize: 14, color: C.prose, lineHeight: 1.5 }}>{x}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------- 11. отзывы: место и честная пометка (настоящих ещё нет) ---------- */}
      <section style={{ ...S.sec, paddingTop: 'clamp(52px,8vw,80px)' }}>
        <div style={S.kicker}>{t.k10}</div>
        <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 0' }}>{t.rvTitle}</h2>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: C.prose, margin: '14px 0 24px', maxWidth: '72ch' }}>{t.rvD}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ border: '1.5px dashed #D8D8CF', borderRadius: 12, minHeight: 150, padding: '20px 22px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: C.sunken }}>
              <span style={{ fontSize: 26, color: '#D8D8CF', lineHeight: 1 }}>«»</span>
              <span style={{ fontFamily: mono, fontSize: 12, color: C.faint, lineHeight: 1.6 }}>{t.rvSlot}</span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 14, margin: '18px 0 0' }}><a href="/register" style={{ color: C.brand, fontWeight: 500 }}>{t.rvCta} →</a></p>
      </section>

      {/* ---------- 12. вопросы и ответы ---------- */}
      <section style={{ maxWidth: 820, margin: '0 auto', padding: 'clamp(52px,8vw,80px) clamp(16px,4vw,24px) 0' }}>
        <div style={S.kicker}>{t.k11}</div>
        <h2 style={{ ...S.h2, fontSize: 'clamp(25px,4.2vw,31px)', margin: '10px 0 18px' }}>{t.faqTitle}</h2>
        <Faq items={t.faqs} startOpen={0} />
        <p style={{ fontSize: 14, margin: '18px 0 0' }}><a href="/вопросы" style={{ color: C.brand, fontWeight: 500 }}>{t.faqAll} →</a></p>
      </section>

      {/* ---------- 13. форма заявки: телефон и название магазина ---------- */}
      <section id="lead" style={{ maxWidth: 1080, margin: '0 auto', padding: 'clamp(52px,8vw,80px) clamp(16px,4vw,24px) clamp(56px,8vw,84px)' }}>
        <div style={{ background: C.ink, borderRadius: 16, padding: 'clamp(28px,5vw,46px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 'clamp(28px,5vw,48px)', alignItems: 'start' }}>
          <div>
            <h2 style={{ fontSize: 'clamp(24px,4vw,30px)', fontWeight: 600, letterSpacing: '-.018em', lineHeight: 1.22, margin: 0, color: '#fff', textWrap: 'pretty' } as any}>{t.leadTitle}</h2>
            <p style={{ fontSize: 15.5, lineHeight: 1.6, color: '#C6CCC4', margin: '14px 0 0', maxWidth: '46ch' }}>{t.leadSub}</p>
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${C.formLine}`, fontSize: 14, color: '#8E958C', lineHeight: 1.7 }}>{t.leadNote}</div>
          </div>
          {sent ? (
            <div style={{ background: C.formBg, border: `1px solid ${C.brand}`, borderRadius: 12, padding: 22, color: '#fff', fontSize: 16, fontWeight: 500, lineHeight: 1.5 }}>{t.fDone}</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <input style={S.input} placeholder={t.fPhone} value={form.phone ?? ''} inputMode="tel"
                onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <input style={S.input} placeholder={t.fShop} value={form.shop ?? ''}
                onChange={(e) => setForm({ ...form, shop: e.target.value })} />
              {/* honeypot: человек не видит, бот заполнит — на сервере такой лид молча выбрасывается */}
              <input style={{ position: 'absolute', left: -9999, top: -9999 }} tabIndex={-1} autoComplete="off"
                value={form.website ?? ''} onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder="website" aria-hidden="true" />
              {err && <div style={{ color: '#F0A79B', fontSize: 14, lineHeight: 1.5 }}>{err}</div>}
              <button style={{ ...S.btn, width: '100%', fontSize: 16, marginTop: 4 }} onClick={submit}>{t.fSend}</button>
              <p style={{ fontFamily: mono, fontSize: 11.5, color: '#8E958C', margin: '6px 0 0', lineHeight: 1.6 }}>{t.fMicro}</p>
            </div>
          )}
        </div>
      </section>

      <SiteFooter lang={lang} full />
    </div>
  );
}
