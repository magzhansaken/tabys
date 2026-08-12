'use client';
import { useEffect, useState } from 'react';

/**
 * ЛЕНДИНГ (часть 19).
 *
 * Позиционирование — из анализа троих конкурентов (docs/15, 19):
 * - UMAG начинает путь клиента со «звонка менеджера» → наш заголовок про
 *   «регистрация за 2 минуты, без звонков»;
 * - Wipon Lite: 150 000 ₸/год и лимит «1 сотрудник» → наша таблица честно
 *   сравнивает цены и лимиты (по их документации, с датой);
 * - у Wipon есть казахская версия доков → мы двуязычные прямо с лендинга.
 *
 * Форма пилота шлёт POST /public/leads (лимит по IP + honeypot на сервере).
 *
 * ВНЕШНИЙ ВИД
 *   • Добавлен седьмой блок — «Накладная из фото», золотом и во всю ширину.
 *     Это единственное, чего нет ни у UMAG, ни у Wipon, ни у МоегоСклада, а
 *     на лендинге оно раньше не упоминалось вовсе. Казахский текст блока
 *     писал дизайнер — прогоните через носителя.
 *   • Золото здесь только в заливках, рамках и бейдже: на белом у #B8863B
 *     контраст 3,2:1, для текста он не годится — текст берёт #8A5F1B.
 *   • Казахский текст на 15–20% длиннее русского, поэтому кнопки и таблица
 *     не переносятся (white-space: nowrap), а заголовки свёрстаны на
 *     длинном варианте.
 *   • Места под фото помечены штриховкой и подписью размера: рисованных
 *     картинок на лендинге нет, нужны настоящие снимки магазина.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const T: Record<'ru' | 'kk', Record<string, string>> = {
  ru: {
    login: 'Войти', cabinet: 'Кабинет',
    heroTitle: 'Учёт для магазина у дома.\nКасса торгует даже без интернета.',
    heroSub: 'Товары, склад, долги покупателей, бонусы и отчёты — в одном месте. Регистрация за 2 минуты, без звонков менеджеру. 14 дней бесплатно.',
    ctaStart: 'Начать бесплатно', ctaPilot: 'Хочу пилот с переездом',
    trust: 'Данные хранятся в Казахстане · 1014 автопроверок перед каждым обновлением · Поддержка на казахском и русском',
    s1t: 'Kaspi магазин', s1d: 'Заказы с маркетплейса приходят в кабинет, цены и остатки уходят обратно.',
    s2t: 'Налоги Казахстана', s2d: 'Расчёт по местным ставкам и форма 910 — без бухгалтерских таблиц.',
    s3t: 'Цена на год', s3d: 'Фиксируется с момента подписки и не меняется в середине года.',
    whyTitle: 'Почему магазины выбирают нас', only: 'Только у Табыс',
    f7t: 'Накладная из фото', f7d: 'Сфотографируйте накладную от поставщика — позиции, количества и цены распознаются сами. Недовоз и подорожание видно до проведения. Ни у UMAG, ни у Wipon, ни у МоегоСклада этого нет.',
    f1t: 'Касса работает без интернета', f1d: 'Провайдер лёг на сутки — касса пробивает чеки, открывает и закрывает смены, принимает возвраты и долги. Интернет вернулся — всё само доехало на сервер, до тенге.',
    f2t: 'Долговая тетрадь — в кассе', f2d: '«Азамату больше 5000 не давать» — лимит проверяется прямо на кассе, даже офлайн. Погашение принимает кассир, долг печатается на чеке.',
    f3t: 'Бонусы без блокнота', f3d: 'Процент начисления задаёте в кабинете — касса сама начисляет и списывает. Клиент видит баланс на чеке.',
    f4t: 'Переезд с UMAG — за час', f4d: 'Выгрузите товары в Excel и загрузите к нам: колонки распознаются сами, ошибки видны до импорта, есть кнопка отката.',
    f5t: 'Отчёты, которым можно верить', f5d: 'Выручка, прибыль, смены с недостачами, зарплата продавцов-консультантов — всё считается автоматически и сходится до тенге.',
    f6t: 'Қазақша сөйлейміз', f6d: 'Интерфейс, названия товаров и поддержка — на казахском и русском. Не «когда-нибудь переведём», а сейчас.',
    cmpTitle: 'Честное сравнение', cmpNote: '* по открытой документации и тарифам конкурентов на июль 2026',
    cmpPrice: 'Цена в месяц, от', cmpReg: 'Регистрация без звонка менеджеру',
    cmpOffline: 'Касса полностью офлайн (смены, возвраты, долги)', cmpDebt: 'Лимит долга проверяется на кассе',
    cmpEmp: 'Сотрудники в базовом тарифе', cmpKk: 'Казахский язык',
    unlimited: 'без лимита', one: '1 сотрудник', byCall: 'по звонку', partial: 'частично',
    priceTitle: 'Тарифы', priceNote: '14 дней бесплатно. Карта не нужна. Цена фиксируется на год с момента подписки.',
    startName: 'Старт', stdName: 'Стандарт', perMonth: '₸/мес',
    startFeat: '1 торговая точка · товары, склад и касса без ограничений · долги и бонусы · отчёты · +4 900 ₸ за дополнительную точку',
    stdFeat: 'Всё из «Старта» · финансы и P&L · документы и ЭСФ · интеграции оборудования · приоритетная поддержка',
    pilotTitle: 'Пилот с переездом под ключ',
    pilotSub: 'Оставьте телефон — поможем перенести товары, настроить кассу и обучить кассира. Говорим по-казахски и по-русски.',
    pilotNote: 'Перезваниваем в рабочее время. Переезд с UMAG, Wipon или МоегоСклада — вместе с вашими остатками и долгами покупателей.',
    fName: 'Как вас зовут', fPhone: 'Телефон', fCity: 'Город', fComment: 'Пара слов о магазине (не обязательно)',
    fSend: 'Оставить заявку', fDone: 'Заявка принята! Перезвоним в рабочее время.',
    faqTitle: 'Частые вопросы',
    q1: 'Правда работает без интернета?', a1: 'Да. Вся касса — продажи, смены, X/Z-отчёты, возвраты, долги — работает локально. Очередь событий доезжает на сервер, когда сеть появляется; повторная отправка не создаёт дублей.',
    q2: 'Как переехать с UMAG или Wipon?', a2: 'Выгрузите номенклатуру в Excel и загрузите в кабинет: колонки сопоставляются автоматически, проблемные строки видны до импорта, импорт можно откатить одной кнопкой.',
    q3: 'Что с фискализацией?', a3: 'Поддерживаем работу через ОФД-провайдеров (WebKassa, ReKassa и другие). Чеки, пробитые офлайн, фискализируются при появлении связи. Продажа в долг не фискализируется — деньги ещё не получены.',
    q4: 'Какое оборудование нужно?', a4: 'Любой Windows-компьютер, Android-планшет или Sunmi-терминал. Сканеры, чековые принтеры 58/80 мм, весы Rongta — подключаются в пару кликов.',
    q5: 'Мои данные — мои?', a5: 'Да. В любой момент выгружайте товары, продажи и покупателей в Excel. Уходите — данные заберёте с собой.',
    footer: 'Тәртіп — табыстың басы · Сделано для магазинов Казахстана',
  },
  kk: {
    login: 'Кіру', cabinet: 'Кабинет',
    heroTitle: 'Жанындағы дүкенге арналған есеп.\nКасса интернетсіз де сата береді.',
    heroSub: 'Тауар, қойма, сатып алушылардың қарызы, бонустар мен есептер — бір жерде. Тіркелу 2 минут, менеджерге қоңырау шалмай-ақ. 14 күн тегін.',
    ctaStart: 'Тегін бастау', ctaPilot: 'Көшірумен пилот керек',
    trust: 'Деректер Қазақстанда сақталады · Әр жаңартудың алдында 1014 автотексеру · Қолдау қазақша және орысша',
    s1t: 'Kaspi магазин', s1d: 'Маркетплейс тапсырыстары кабинетке келеді, баға мен қалдық кері жіберіледі.',
    s2t: 'Қазақстан салықтары', s2d: 'Жергілікті мөлшерлемелер бойынша есеп және 910-форма.',
    s3t: 'Баға бір жылға', s3d: 'Жазылған сәттен бекітіледі және жыл ортасында өзгермейді.',
    whyTitle: 'Дүкендер бізді неге таңдайды', only: 'Тек Табыста',
    f7t: 'Фотодан жүкқұжат', f7d: 'Жеткізушінің жүкқұжатын суретке түсіріңіз — позициялар, саны мен бағасы өзі танылады. Кем әкелу мен қымбаттау өткізуге дейін көрінеді. Мұндай мүмкіндік UMAG-та да, Wipon-да да, МойСклад-та да жоқ.',
    f1t: 'Касса интернетсіз жұмыс істейді', f1d: 'Интернет бір тәулікке өшсе де — касса чек соғады, ауысымды ашып-жабады, қайтарым мен қарызды қабылдайды. Желі оралғанда бәрі серверге теңгесіне дейін дәл жетеді.',
    f2t: 'Қарыз дәптері — кассада', f2d: '«Азаматқа 5000-нан артық бермеу» — лимит кассада тексеріледі, интернетсіз де. Қарызды кассир қабылдайды, чекте басылады.',
    f3t: 'Бонус блокнотсыз', f3d: 'Есептеу пайызын кабинетте қоясыз — касса өзі есептеп, өзі шегереді. Клиент балансын чектен көреді.',
    f4t: 'UMAG-тан көшу — бір сағат', f4d: 'Тауарларды Excel-ге түсіріп, бізге жүктеңіз: бағандар өзі танылады, қателер импортқа дейін көрінеді, кері қайтару батырмасы бар.',
    f5t: 'Сенуге болатын есептер', f5d: 'Түсім, пайда, жетіспеушілігі бар ауысымдар, сатушы-кеңесшілердің жалақысы — бәрі автоматты есептеледі, теңгесіне дейін дәл.',
    f6t: 'Қазақша сөйлейміз', f6d: 'Интерфейс, тауар атаулары және қолдау — қазақша және орысша. «Кейін аударамыз» емес, қазір.',
    cmpTitle: 'Адал салыстыру', cmpNote: '* бәсекелестердің ашық құжаттамасы бойынша, 2026 ж. шілде',
    cmpPrice: 'Айлық баға, бастап', cmpReg: 'Менеджерге қоңыраусыз тіркелу',
    cmpOffline: 'Касса толық офлайн (ауысым, қайтарым, қарыз)', cmpDebt: 'Қарыз лимиті кассада тексеріледі',
    cmpEmp: 'Базалық тарифтегі қызметкерлер', cmpKk: 'Қазақ тілі',
    unlimited: 'шектеусіз', one: '1 қызметкер', byCall: 'қоңырау арқылы', partial: 'ішінара',
    priceTitle: 'Тарифтер', priceNote: '14 күн тегін. Карта керек емес. Баға жазылған сәттен бір жылға бекітіледі.',
    startName: 'Старт', stdName: 'Стандарт', perMonth: '₸/ай',
    startFeat: '1 сауда нүктесі · тауар, қойма және касса шектеусіз · қарыз бен бонус · есептер · қосымша нүкте +4 900 ₸',
    stdFeat: '«Старттағы» бәрі · қаржы және P&L · құжаттар мен ЭШФ · жабдық интеграциясы · басым қолдау',
    pilotTitle: 'Толық көшірумен пилот',
    pilotSub: 'Телефоныңызды қалдырыңыз — тауарды көшіруге, кассаны баптауға және кассирді үйретуге көмектесеміз. Қазақша және орысша сөйлейміз.',
    pilotNote: 'Жұмыс уақытында қоңырау шаламыз. UMAG, Wipon немесе МойСклад-тан көшу — қалдықтарыңызбен және сатып алушылардың қарызымен бірге.',
    fName: 'Атыңыз', fPhone: 'Телефон', fCity: 'Қала', fComment: 'Дүкен туралы бір-екі сөз (міндетті емес)',
    fSend: 'Өтінім қалдыру', fDone: 'Өтінім қабылданды! Жұмыс уақытында қоңырау шаламыз.',
    faqTitle: 'Жиі қойылатын сұрақтар',
    q1: 'Шынымен интернетсіз жұмыс істей ме?', a1: 'Иә. Бүкіл касса — сату, ауысым, X/Z-есептер, қайтарым, қарыз — жергілікті жұмыс істейді. Желі пайда болғанда оқиғалар кезегі серверге жетеді; қайта жіберу дубль жасамайды.',
    q2: 'UMAG немесе Wipon-нан қалай көшемін?', a2: 'Номенклатураны Excel-ге түсіріп, кабинетке жүктеңіз: бағандар автоматты сәйкестендіріледі, қате жолдар импортқа дейін көрінеді, импортты бір батырмамен кері қайтаруға болады.',
    q3: 'Фискализация ше?', a3: 'ОФД-провайдерлер арқылы жұмысты қолдаймыз (WebKassa, ReKassa және т.б.). Офлайн соғылған чектер байланыс пайда болғанда фискалданады.',
    q4: 'Қандай жабдық керек?', a4: 'Кез келген Windows-компьютер, Android-планшет немесе Sunmi-терминал. Сканерлер, 58/80 мм чек принтерлері, Rongta таразылары — бірнеше кликпен қосылады.',
    q5: 'Деректерім — менікі ме?', a5: 'Иә. Кез келген сәтте тауарды, сатуды және сатып алушыларды Excel-ге түсіре аласыз. Кетсеңіз — деректеріңізді өзіңізбен аласыз.',
    footer: 'Тәртіп — табыстың басы · Қазақстан дүкендері үшін жасалған',
  },
};

/** Палитра лендинга — те же значения, что в кабинете (admin/lib/ui.tsx).
 *  Лендинг намеренно ничего оттуда не импортирует: он должен открываться
 *  у человека, который ещё не наш клиент, и не тянуть код кабинета. */
const C = {
  ink: '#17211D', prose: '#3C443E', dim: '#6B7167', faint: '#9A9E95',
  brand: '#0B6B4F', brandDark: '#085340', brandTint: '#E8F1EC',
  gold: '#B8863B', goldInk: '#8A5F1B', goldTint: '#F7EFDF', goldPaper: '#FFFCF6',
  bad: '#A32C1E', bg: '#F5F5F1', card: '#FFFFFF', line: '#E4E4DD', lineIn: '#EFEFE9', sunken: '#FAFAF6',
};

export default function Landing() {
  const [lang, setLang] = useState<'ru' | 'kk'>('ru');
  const [authed, setAuthed] = useState(false);
  const [form, setForm] = useState<any>({});
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(0);
  const t = T[lang];

  useEffect(() => { setAuthed(!!localStorage.getItem('access')); }, []);

  const submit = async () => {
    setErr('');
    try {
      const r = await fetch(`${API}/public/leads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, phone: form.phone, city: form.city,
          comment: form.comment, locale: lang, website: form.website ?? '' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? 'Ошибка');
      setSent(true);
    } catch (e: any) { setErr(e.message); }
  };

  const S = {
    wrap: { maxWidth: 1080, margin: '0 auto', padding: '0 24px' } as const,
    h2: { fontSize: 30, fontWeight: 600, letterSpacing: '-.018em', margin: '0 0 22px' } as const,
    card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '22px 24px' } as const,
    btn: { background: C.brand, color: '#fff', border: 0, borderRadius: 10, minHeight: 52, padding: '0 26px',
      fontSize: 16.5, fontWeight: 500, cursor: 'pointer', textDecoration: 'none',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap' } as const,
    ghost: { background: C.card, color: C.ink, border: `1px solid #D8D8CF`, borderRadius: 10, minHeight: 52,
      padding: '0 24px', fontSize: 16.5, cursor: 'pointer', textDecoration: 'none',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap' } as const,
    input: { padding: '0 14px', height: 48, border: `1px solid #3A423C`, borderRadius: 10, fontSize: 16,
      width: '100%', boxSizing: 'border-box', background: '#212C27', color: '#fff', outline: 'none' } as const,
    /** Место под фото: штриховка и подпись размера, а не рисованная картинка. */
    photo: (ratio: string, tint = false) => ({
      aspectRatio: ratio, border: `1px solid ${tint ? '#E8DCC3' : C.line}`, borderRadius: 14, overflow: 'hidden',
      position: 'relative' as const,
      background: `repeating-linear-gradient(135deg, ${C.card} 0 12px, ${tint ? '#FDF7EC' : C.bg} 12px 24px)`,
    }),
    photoNote: {
      position: 'absolute' as const, left: 0, right: 0, bottom: 0, padding: '14px 16px',
      background: 'rgba(255,255,255,.92)', borderTop: `1px solid ${C.line}`,
      fontFamily: 'var(--font-mono), monospace', fontSize: 12, color: C.dim, lineHeight: 1.5,
    },
  };

  const yes = <span style={{ color: C.brand, fontWeight: 600, fontSize: 17 }}>✓</span>;
  const no = <span style={{ color: C.bad, fontSize: 17 }}>—</span>;

  return (
    <div style={{ color: C.ink, background: C.card }}>
      {/* ---------- шапка ---------- */}
      <header style={{ background: C.card, borderBottom: `1px solid ${C.line}`, position: 'relative', zIndex: 10 }}>
        <div style={{ ...S.wrap, display: 'flex', alignItems: 'center', gap: 12, height: 68 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: C.brand, color: '#fff', fontSize: 14,
              fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
            <b style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-.01em' }}>Табыс</b>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={() => setLang(lang === 'ru' ? 'kk' : 'ru')} data-testid="lang-switch"
            style={{ ...S.ghost, minHeight: 40, minWidth: 56, padding: '0 12px', fontSize: 13.5, fontWeight: 500, color: C.prose }}>
            {lang === 'ru' ? 'ҚАЗ' : 'РУС'}
          </button>
          <a href={authed ? '/dashboard' : '/login'} style={{ ...S.ghost, minHeight: 40, padding: '0 16px', fontSize: 14.5 }}>
            {authed ? t.cabinet : t.login}
          </a>
          <a href="/register" style={{ ...S.btn, minHeight: 40, padding: '0 17px', fontSize: 14.5 }}>{t.ctaStart}</a>
        </div>
      </header>

      {/* ---------- герой ---------- */}
      <section style={{ ...S.wrap, padding: '64px 24px 56px', display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 56, alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: C.goldInk }}>
            Тәртіп — табыстың басы
          </div>
          <h1 style={{ fontSize: 44, fontWeight: 600, letterSpacing: '-.022em', lineHeight: 1.14,
            margin: '16px 0 0', whiteSpace: 'pre-line', textWrap: 'pretty' } as any}>{t.heroTitle}</h1>
          <p style={{ fontSize: 17.5, lineHeight: 1.55, color: C.prose, margin: '18px 0 0', maxWidth: '54ch' }}>{t.heroSub}</p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 30 }}>
            <a href="/register" style={S.btn}>{t.ctaStart}</a>
            <a href="#pilot" style={S.ghost}>{t.ctaPilot}</a>
          </div>
          <p style={{ fontSize: 13, color: C.dim, lineHeight: 1.6, margin: '22px 0 0', maxWidth: '56ch' }}>{t.trust}</p>
        </div>
        <div>
          <div style={S.photo('4 / 5')}>
            <div style={S.photoNote}>фото: прилавок магазина у дома,<br />касса и продавец. 1200×1500</div>
          </div>
        </div>
      </section>

      {/* ---------- три коротких обещания ---------- */}
      <section style={{ background: C.sunken, borderTop: `1px solid ${C.lineIn}`, borderBottom: `1px solid ${C.lineIn}` }}>
        <div style={{ ...S.wrap, padding: '26px 24px', display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))', gap: 28 }}>
          {[['s1t', 's1d'], ['s2t', 's2d'], ['s3t', 's3d']].map(([tt, dd]) => (
            <div key={tt}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{t[tt]}</div>
              <div style={{ fontSize: 13.5, color: C.dim, lineHeight: 1.55, marginTop: 4 }}>{t[dd]}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- фичи ---------- */}
      <section style={{ ...S.wrap, padding: '64px 24px 0' }}>
        <h2 style={S.h2}>{t.whyTitle}</h2>

        {/* Главное отличие продукта — во всю ширину и золотом */}
        <div style={{ background: C.goldPaper, border: `1px solid #E8DCC3`, borderRadius: 14, padding: '28px 30px',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 36,
          alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ display: 'inline-block', background: C.goldTint, color: C.goldInk, padding: '4px 11px',
              borderRadius: 999, fontSize: 12, fontWeight: 500, letterSpacing: '.04em' }}>{t.only}</div>
            <h3 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-.015em', margin: '14px 0 0' }}>{t.f7t}</h3>
            <p style={{ fontSize: 15.5, lineHeight: 1.6, color: C.prose, margin: '12px 0 0', maxWidth: '52ch' }}>{t.f7d}</p>
          </div>
          <div style={S.photo('16 / 10', true)}>
            <div style={{ ...S.photoNote, borderTopColor: '#E8DCC3', color: C.goldInk }}>
              фото накладной → разобранные строки. 1200×750
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(304px, 1fr))', gap: 14 }}>
          {[['f1t', 'f1d'], ['f2t', 'f2d'], ['f3t', 'f3d'], ['f4t', 'f4d'], ['f5t', 'f5d'], ['f6t', 'f6d']].map(([tt, dd]) => (
            <div key={tt} style={S.card}>
              <b style={{ fontSize: 16.5, fontWeight: 600, lineHeight: 1.35 }}>{t[tt]}</b>
              <p style={{ color: C.prose, fontSize: 14, margin: '10px 0 0', lineHeight: 1.6 }}>{t[dd]}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- сравнение ---------- */}
      <section style={{ ...S.wrap, padding: '64px 24px 0' }}>
        <h2 style={S.h2}>{t.cmpTitle}</h2>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden', background: C.card }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 15 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '18px 20px', background: C.sunken }}></th>
                  {['Табыс', 'UMAG', 'Wipon', 'МойСклад'].map((n, i) => (
                    <th key={n} style={{ padding: '18px 20px', whiteSpace: 'nowrap',
                      background: i === 0 ? C.brandTint : C.sunken,
                      color: i === 0 ? C.brandDark : C.dim,
                      fontSize: i === 0 ? 16 : 15, fontWeight: i === 0 ? 600 : 500 }}>{n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  [t.cmpPrice, <b key="p">6 900 ₸</b>, '8 800 ₸', '12 500 ₸', '~9 000 ₸'],
                  [t.cmpReg, yes, no, yes, yes],
                  [t.cmpOffline, yes, t.partial, t.partial, t.partial],
                  [t.cmpDebt, yes, no, no, no],
                  [t.cmpEmp, <b key="e">{t.unlimited}</b>, t.unlimited, t.one, t.unlimited],
                  [t.cmpKk, yes, t.partial, t.partial, no],
                ].map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{ padding: '15px 20px', borderTop: `1px solid ${C.lineIn}`,
                        textAlign: ci ? 'center' : 'left', whiteSpace: ci ? 'nowrap' : 'normal',
                        background: ci === 1 ? '#F4F9F6' : undefined,
                        color: ci === 0 ? C.prose : typeof cell === 'string' ? C.dim : undefined,
                        lineHeight: 1.45 }}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p style={{ fontSize: 12.5, color: C.faint, marginTop: 12 }}>{t.cmpNote}</p>
      </section>

      {/* ---------- тарифы ---------- */}
      <section style={{ ...S.wrap, padding: '64px 24px 0' }}>
        <h2 style={S.h2}>{t.priceTitle}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, maxWidth: 760 }}>
          {[
            { name: t.startName, price: '6 900', feat: t.startFeat, main: false },
            { name: t.stdName, price: '14 900', feat: t.stdFeat, main: true },
          ].map((p) => (
            <div key={p.name} style={{ ...S.card, padding: '26px 28px', borderRadius: 14,
              border: p.main ? `1.5px solid ${C.brand}` : `1px solid ${C.line}`,
              display: 'flex', flexDirection: 'column' }}>
              <b style={{ fontSize: 17, fontWeight: 600 }}>{p.name}</b>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, margin: '12px 0 16px' }}>
                <span style={{ fontSize: 38, fontWeight: 600, letterSpacing: '-.02em',
                  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{p.price}</span>
                <span style={{ fontSize: 15, color: C.dim }}>{t.perMonth}</span>
              </div>
              <p style={{ color: C.prose, fontSize: 14, lineHeight: 1.65, margin: '0 0 22px', flex: 1 }}>{p.feat}</p>
              <a href="/register" style={p.main
                ? { ...S.btn, minHeight: 48, width: '100%', fontSize: 15.5 }
                : { ...S.ghost, minHeight: 48, width: '100%', fontSize: 15.5, borderColor: C.brand, color: C.brand }}>
                {t.ctaStart}
              </a>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 13.5, color: C.dim, marginTop: 14 }}>{t.priceNote}</p>
      </section>

      {/* ---------- форма пилота ---------- */}
      <section id="pilot" style={{ ...S.wrap, padding: '64px 24px 0' }}>
        <div style={{ background: C.ink, borderRadius: 16, padding: '44px 46px', display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 48, alignItems: 'start' }}>
          <div>
            <h2 style={{ ...S.h2, color: '#fff', margin: 0 }}>{t.pilotTitle}</h2>
            <p style={{ fontSize: 15.5, lineHeight: 1.6, color: '#C6CCC4', margin: '14px 0 0', maxWidth: '46ch' }}>{t.pilotSub}</p>
            <div style={{ marginTop: 26, paddingTop: 22, borderTop: `1px solid #3A423C`, fontSize: 14,
              color: '#8E958C', lineHeight: 1.7 }}>{t.pilotNote}</div>
          </div>
          {sent ? (
            <div style={{ background: '#212C27', border: `1px solid ${C.brand}`, borderRadius: 12, padding: 22,
              color: '#fff', fontSize: 16, fontWeight: 500, lineHeight: 1.5 }}>{t.fDone}</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <input style={S.input} placeholder={t.fName} value={form.name ?? ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input style={S.input} placeholder={`${t.fPhone} +7 7XX XXX XX XX`} value={form.phone ?? ''}
                inputMode="tel" onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <input style={S.input} placeholder={t.fCity} value={form.city ?? ''}
                onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <textarea style={{ ...S.input, height: 'auto', minHeight: 84, padding: '12px 14px', resize: 'vertical' }}
                placeholder={t.fComment} value={form.comment ?? ''}
                onChange={(e) => setForm({ ...form, comment: e.target.value })} />
              {/* honeypot: человек не видит, бот заполнит */}
              <input style={{ position: 'absolute', left: -9999, top: -9999 }} tabIndex={-1} autoComplete="off"
                value={form.website ?? ''} onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder="website" aria-hidden="true" />
              {err && <div style={{ color: '#F0A79B', fontSize: 14, lineHeight: 1.5 }}>{err}</div>}
              <button style={{ ...S.btn, width: '100%', fontSize: 16, marginTop: 4 }} onClick={submit}>{t.fSend}</button>
            </div>
          )}
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section style={{ ...S.wrap, maxWidth: 780, padding: '64px 24px 72px' }}>
        <h2 style={S.h2}>{t.faqTitle}</h2>
        <div style={{ borderTop: `1px solid ${C.line}` }}>
          {[['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3'], ['q4', 'a4'], ['q5', 'a5']].map(([q, a], i) => (
            <div key={q} style={{ borderBottom: `1px solid ${C.line}` }}>
              <button onClick={() => setOpen(open === i ? -1 : i)}
                style={{ width: '100%', minHeight: 60, padding: '16px 0', background: 'transparent', border: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20,
                  cursor: 'pointer', textAlign: 'left', color: C.ink }}>
                <span style={{ fontSize: 16.5, fontWeight: 500, lineHeight: 1.4 }}>{t[q]}</span>
                <span style={{ fontSize: 22, color: C.faint, lineHeight: 1 }}>{open === i ? '−' : '+'}</span>
              </button>
              {open === i && (
                <p style={{ color: C.prose, fontSize: 14.5, lineHeight: 1.65, margin: '0 0 20px', maxWidth: '68ch' }}>{t[a]}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <footer style={{ borderTop: `1px solid ${C.line}`, background: C.sunken }}>
        <div style={{ ...S.wrap, padding: '28px 24px', display: 'flex', justifyContent: 'space-between',
          color: C.dim, fontSize: 13.5, flexWrap: 'wrap', gap: 12 }}>
          <span>© {new Date().getFullYear()} Табыс — {t.footer}</span>
          <a href="/login" style={{ color: C.dim }}>{t.login}</a>
        </div>
      </footer>
    </div>
  );
}
