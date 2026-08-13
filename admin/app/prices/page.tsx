'use client';
/**
 * ЦЕНЫ — открыто. Скрывать цену значит терять тех, кто не хочет звонить.
 *
 * Два тарифа, как в биллинге (часть 14): «Старт» 6 900 ₸ — одна точка и одна
 * касса; «Стандарт» 14 900 ₸ — несколько точек, опт, маркировка и акциз.
 * Витрина не должна расходиться с биллингом: если тарифы там поменяются,
 * править надо здесь же.
 *
 * Конкурентов на странице нет: вместо чужого прайса блок «что не влияет на цену».
 * Разрешённые цифры: 6 900, 14 900, 14 дней, фиксация на год. Больше ничего.
 */
import { C, S, mono, useLang, SiteHeader, SiteFooter, Faq, CtaBand } from '../../lib/site';

const T: any = {
  ru: {
    kicker: 'Цены — открыто', ctaStart: 'Начать бесплатно',
    h1: 'Два тарифа. Оба видно сразу.',
    sub: 'Без звонка менеджеру и без «уточните у нас». 14 дней бесплатно, карта не нужна, цена фиксируется на год с момента подписки.',
    perMonth: '₸/мес',
    tariffs: [
      { name: 'Старт', price: '6 900', main: false, sub: 'Одна точка, одна касса',
        feat: ['1 торговая точка и 1 касса', 'Товары, склад и касса без ограничений', 'Долги покупателей и бонусы', 'Отчёты: выручка, прибыль, смены', 'Работа кассы без интернета'] },
      { name: 'Стандарт', price: '14 900', main: true, sub: 'Несколько точек, опт, маркировка',
        feat: ['Всё из «Старта»', 'Несколько точек в одном кабинете', 'Опт: CRM, отсрочки, лимиты', 'Маркировка (ИС МПТ) и акциз (УКМ)', 'Финансы и P&L, документы и ЭСФ', 'Приоритетная поддержка'] },
    ],
    both: ['14 дней бесплатно — версия полная, без урезаний', 'Карта для пробного периода не нужна', 'Цена фиксируется на год с момента подписки', 'Поддержка на казахском и русском'],
    bothT: 'В обоих тарифах',
    inclTitle: 'Что умеет система',
    incl: ['Касса — работает и без интернета', 'Товары и склад без лимитов', 'Сотрудники — без лимита и доплат', 'Долговая тетрадь с лимитами', 'Бонусы покупателей', 'Накладная из фото (AI-приёмка)', 'Kaspi Магазин — заказы и остатки', 'Фискализация через ОФД', 'Акциз (УКМ) и маркировка (ИС МПТ)', 'Форма 910 и налоги Казахстана', 'Отчёты: выручка, прибыль, смены, P&L', 'Зарплата сотрудников', 'Техкарты для кофейни', 'Импорт и экспорт Excel', 'Инвентаризация — хоть голосом'],
    inclNote: 'Опт, маркировка и акциз — в тарифе «Стандарт». Остальное есть в обоих.',
    fragTitle: 'Почему у нас нет доплат',
    fragSub: 'Обычно цену собирают из кусочков: касса, сотрудник, модуль, выезд специалиста. У нас в тарифе уже всё, что нужно магазину.',
    fragUs: 'Что не влияет на цену',
    fragUsNote: 'платите за тариф — и всё',
    rows: [['Сколько у вас продавцов', '0 ₸'], ['Сколько касс и планшетов', '0 ₸'], ['Фискальный модуль', '0 ₸'], ['Kaspi Магазин', '0 ₸'], ['Обновления и поддержка', '0 ₸'], ['Помощь с переездом', '0 ₸']],
    freeT: 'А почему не бесплатно?',
    freeD: 'Бесплатная касса и учёт магазина — разные вещи: пробить чек мало, если не видно остатков, закупок и прибыли. 6 900 ₸ в месяц — дешевле одного рабочего дня товароведа, а считает он за вас каждый день.',
    faqTitle: 'Вопросы об оплате',
    faqs: [
      { q: 'Какой тариф выбрать?', a: 'Один магазин и одна касса — «Старт» за 6 900 ₸. Несколько точек, опт с отсрочками или маркированный товар и алкоголь — «Стандарт» за 14 900 ₸. Перейти со «Старта» на «Стандарт» можно в любой момент.' },
      { q: 'Что будет после 14 дней?', a: 'Пробный период — полная версия, без урезаний. Дальше выбираете тариф. Карту заранее не привязываем: не продлили — данные можно выгрузить в Excel и забрать.' },
      { q: 'Цена правда не вырастет?', a: 'Цена фиксируется на год с момента подписки и не меняется в середине года. Через год — по действующему тарифу на тот момент.' },
      { q: 'Есть ли скрытые платежи?', a: 'Нет. Сотрудники, устройства кассы, обновления и поддержка входят в тариф. Доплат за «модули» нет.' },
    ],
    ctaTitle: 'Проще попробовать, чем читать',
    ctaSub: '14 дней бесплатно, регистрация за 2 минуты, без звонков менеджеру.',
  },
  kk: {
    kicker: 'Бағалар — ашық', ctaStart: 'Тегін бастау',
    h1: 'Екі тариф. Екеуі де көрініп тұр.',
    sub: 'Менеджерге қоңыраусыз және «бізден сұраңыз» деместен. 14 күн тегін, карта керек емес, баға жазылған сәттен бір жылға бекітіледі.',
    perMonth: '₸/ай',
    tariffs: [
      { name: 'Старт', price: '6 900', main: false, sub: 'Бір нүкте, бір касса',
        feat: ['1 сауда нүктесі және 1 касса', 'Тауар, қойма және касса шектеусіз', 'Сатып алушы қарызы мен бонустар', 'Есептер: түсім, пайда, ауысым', 'Кассаның интернетсіз жұмысы'] },
      { name: 'Стандарт', price: '14 900', main: true, sub: 'Бірнеше нүкте, көтерме, таңбалау',
        feat: ['«Старттағы» бәрі', 'Бір кабинетте бірнеше нүкте', 'Көтерме: CRM, мерзімін ұзарту, лимиттер', 'Таңбалау (ИС МПТ) және акциз (УКМ)', 'Қаржы және P&L, құжаттар мен ЭШФ', 'Басым қолдау'] },
    ],
    both: ['14 күн тегін — нұсқа толық, қысқартусыз', 'Сынақ кезеңіне карта керек емес', 'Баға жазылған сәттен бір жылға бекітіледі', 'Қазақша және орысша қолдау'],
    bothT: 'Екі тарифте де',
    inclTitle: 'Жүйе не істей алады',
    incl: ['Касса — интернетсіз де жұмыс істейді', 'Тауар мен қойма шектеусіз', 'Қызметкерлер — шектеусіз, қосымша ақысыз', 'Лимиті бар қарыз дәптері', 'Сатып алушы бонустары', 'Фотодан жүкқұжат (AI-қабылдау)', 'Kaspi Магазин — тапсырыс пен қалдық', 'ОФД арқылы фискализация', 'Акциз (УКМ) және таңбалау (ИС МПТ)', '910-форма және Қазақстан салықтары', 'Есептер: түсім, пайда, ауысым, P&L', 'Қызметкерлер жалақысы', 'Кофейняға техкарталар', 'Excel импорты мен экспорты', 'Түгендеу — тіпті дауыспен'],
    inclNote: 'Көтерме, таңбалау және акциз — «Стандарт» тарифінде. Қалғаны екеуінде де бар.',
    fragTitle: 'Бізде неге қосымша ақы жоқ',
    fragSub: 'Әдетте баға бөлшектерден жиналады: касса, қызметкер, модуль, маманның шығуы. Бізде тарифте дүкенге керектің бәрі бар.',
    fragUs: 'Бағаға әсер етпейтіндер',
    fragUsNote: 'тариф үшін төлейсіз — болды',
    rows: [['Сатушы саны', '0 ₸'], ['Касса мен планшет саны', '0 ₸'], ['Фискалдық модуль', '0 ₸'], ['Kaspi Магазин', '0 ₸'], ['Жаңартулар мен қолдау', '0 ₸'], ['Көшуге көмек', '0 ₸']],
    freeT: 'Ал неге тегін емес?',
    freeD: 'Тегін касса мен дүкен есебі — әр басқа: қалдық, сатып алу мен пайда көрінбесе, чек соғу жеткіліксіз. Айына 6 900 ₸ — тауартанушының бір жұмыс күнінен арзан, ал ол сіз үшін күн сайын санайды.',
    faqTitle: 'Төлем туралы сұрақтар',
    faqs: [
      { q: 'Қай тарифті таңдау керек?', a: 'Бір дүкен және бір касса — 6 900 ₸-ге «Старт». Бірнеше нүкте, мерзімін ұзартатын көтерме немесе таңбаланған тауар мен алкоголь — 14 900 ₸-ге «Стандарт». «Старттан» «Стандартқа» кез келген сәтте өтуге болады.' },
      { q: '14 күннен кейін не болады?', a: 'Сынақ кезеңі — толық нұсқа, қысқартусыз. Әрі қарай тариф таңдайсыз. Картаны алдын ала байламаймыз: жалғастырмасаңыз — деректерді Excel-ге түсіріп аласыз.' },
      { q: 'Баға шынымен өспей ме?', a: 'Баға жазылған сәттен бір жылға бекітіледі және жыл ортасында өзгермейді. Бір жылдан кейін — сол кездегі қолданыстағы тариф бойынша.' },
      { q: 'Жасырын төлемдер бар ма?', a: 'Жоқ. Қызметкерлер, касса құрылғылары, жаңартулар мен қолдау тарифке кіреді. «Модуль» үшін қосымша ақы жоқ.' },
    ],
    ctaTitle: 'Оқығаннан гөрі байқап көру оңай',
    ctaSub: '14 күн тегін, тіркелу 2 минут, менеджерге қоңыраусыз.',
  },
};

export default function Prices() {
  const [lang, toggleLang] = useLang();
  const t = T[lang];

  return (
    <div style={{ color: C.ink, background: C.card }}>
      <SiteHeader lang={lang} onLang={toggleLang} active="prices" />

      <section style={{ ...S.sec, paddingTop: 'clamp(40px,7vw,72px)' }}>
        <div style={S.kicker}>{t.kicker}</div>
        <h1 style={S.h1}>{t.h1}</h1>
        <p style={{ fontSize: 'clamp(15.5px,2vw,17px)', lineHeight: 1.55, color: C.prose, margin: '16px 0 0', maxWidth: '62ch' }}>{t.sub}</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(290px,1fr))', gap: 18, marginTop: 34, alignItems: 'stretch' }}>
          {t.tariffs.map((p: any) => (
            <div key={p.name} style={{ border: p.main ? `1.5px solid ${C.brand}` : `1px solid ${C.line}`, borderRadius: 16, background: C.card, padding: 'clamp(24px,4vw,32px)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 17, fontWeight: 600 }}>{p.name}</b>
                {p.main && <span style={{ background: C.brandTint, color: C.brandDark, borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>{p.sub}</span>}
                {!p.main && <span style={{ fontSize: 13, color: C.dim }}>{p.sub}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, margin: '14px 0 18px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'clamp(38px,5.5vw,48px)', fontWeight: 600, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{p.price} ₸</span>
                <span style={{ fontSize: 15.5, color: C.dim }}>{t.perMonth}</span>
              </div>
              <div style={{ display: 'grid', gap: 8, flex: 1 }}>
                {p.feat.map((x: string) => (
                  <div key={x} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
                    <span style={{ color: C.brand, fontWeight: 600 }}>✓</span><span style={{ fontSize: 14.5, color: C.prose, lineHeight: 1.5 }}>{x}</span>
                  </div>
                ))}
              </div>
              <a href="/register" style={p.main
                ? { ...S.btn, fontSize: 16, marginTop: 24, width: '100%' }
                : { ...S.ghost, fontSize: 16, marginTop: 24, width: '100%', borderColor: C.brand, color: C.brand }}>{t.ctaStart}</a>
            </div>
          ))}
        </div>

        <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.sunken, padding: 'clamp(20px,3vw,26px)', marginTop: 18 }}>
          <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: '.1em', textTransform: 'uppercase', color: C.dim }}>{t.bothT}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: '10px 24px', marginTop: 14 }}>
            {t.both.map((x: string) => (
              <div key={x} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
                <span style={{ color: C.brand, fontWeight: 600 }}>✓</span><span style={{ fontSize: 14.5, color: C.prose, lineHeight: 1.5 }}>{x}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={S.sec}>
        <h2 style={{ ...S.h2, fontSize: 'clamp(23px,3.8vw,29px)', margin: '0 0 22px' }}>{t.inclTitle}</h2>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.card, padding: 'clamp(20px,3vw,28px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(225px,1fr))', gap: '10px 24px' }}>
          {t.incl.map((x: string) => (
            <div key={x} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
              <span style={{ color: C.brand, fontWeight: 600 }}>✓</span><span style={{ fontSize: 14.5, color: C.prose, lineHeight: 1.5 }}>{x}</span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 13, color: C.faint, marginTop: 12 }}>{t.inclNote}</p>
      </section>

      <section style={{ background: C.sunken, borderTop: `1px solid ${C.lineIn}`, borderBottom: `1px solid ${C.lineIn}`, marginTop: 'clamp(48px,7vw,72px)' }}>
        <div style={{ ...S.wrap, padding: 'clamp(44px,6vw,64px) clamp(16px,4vw,24px)' }}>
          <h2 style={{ ...S.h2, fontSize: 'clamp(23px,3.8vw,29px)', margin: '0 0 8px' }}>{t.fragTitle}</h2>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: C.prose, margin: '0 0 24px', maxWidth: '70ch' }}>{t.fragSub}</p>
          <div style={{ border: `1.5px solid ${C.brand}`, borderRadius: 14, background: C.card, padding: 'clamp(22px,3vw,28px)' }}>
            <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', color: C.brand }}>{t.fragUs}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: '10px 24px', marginTop: 16 }}>
              {t.rows.map((r: string[]) => (
                <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: `1px dashed ${C.lineIn}`, paddingBottom: 10 }}>
                  <span style={{ fontSize: 14, color: C.prose }}>{r[0]}</span>
                  <span style={{ fontFamily: mono, fontSize: 13.5, color: C.brandDark, fontWeight: 500, whiteSpace: 'nowrap' }}>{r[1]}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, color: C.faint, margin: '14px 0 0' }}>{t.fragUsNote}</p>
          </div>
          <div style={{ ...S.card, marginTop: 16, padding: '20px 24px' }}>
            <b style={{ fontSize: 15.5, fontWeight: 600 }}>{t.freeT}</b>
            <p style={{ color: C.prose, fontSize: 14, margin: '8px 0 0', lineHeight: 1.6, maxWidth: '80ch' }}>{t.freeD}</p>
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 820, margin: '0 auto', padding: 'clamp(48px,7vw,72px) clamp(16px,4vw,24px) 0' }}>
        <h2 style={{ ...S.h2, fontSize: 'clamp(23px,3.8vw,29px)', margin: '0 0 18px' }}>{t.faqTitle}</h2>
        <Faq items={t.faqs} />
      </section>

      <CtaBand lang={lang} title={t.ctaTitle} sub={t.ctaSub} />
      <SiteFooter lang={lang} />
    </div>
  );
}
