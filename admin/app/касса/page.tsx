'use client';
/**
 * КАССА — отдельная страница. Офлайн-работа наша сильная сторона, на главной ей
 * тесно: здесь макет кассы, полный список того, что работает без сети,
 * оборудование (не нужен дорогой POS-моноблок) и фискализация.
 */
import { C, S, mono, useLang, SiteHeader, SiteFooter, CtaBand } from '../../lib/site';

const T: any = {
  ru: {
    kicker: 'Касса', ctaStart: 'Начать бесплатно', ctaPrices: 'Цены',
    h1: 'Касса, которой не нужен интернет',
    sub: 'Провайдер лёг на сутки — касса пробивает чеки, открывает и закрывает смены, принимает возвраты и долги. Интернет вернулся — всё само доехало на сервер, до тенге.',
    heroNote: 'Любой Windows-компьютер, Android-планшет или Sunmi-терминал. Специальное железо покупать не нужно.',
    mockShift: 'Касса · смена №14', mockOffline: 'офлайн · в очереди 3 чека', mockTotal: 'Итого', mockPay: 'Оплата',
    mockDebt: 'В долг: Азамат · лимит 5 000 ₸ — ок',
    mockNote: 'интернет вернётся — чеки сами уедут на сервер',
    prods: [['Хлеб', '160 ₸'], ['Молоко 3,2%', '540 ₸'], ['Кефир 2,5%', '430 ₸'], ['Сок яблочный', '620 ₸'], ['Чай чёрный', '980 ₸'], ['Сахар 1 кг', '590 ₸']],
    receipt: [['Хлеб ×2', '320 ₸'], ['Молоко 3,2%', '540 ₸'], ['Сахар 1 кг', '590 ₸'], ['Спички', '280 ₸']],
    k1: 'Офлайн — полностью',
    offTitle: 'Что касса умеет без сети',
    offSub: 'Не «покажет каталог», а работает целиком. Очередь событий доезжает на сервер, когда сеть появляется, — повторная отправка не создаёт дублей.',
    offCards: [
      { t: 'Чеки и возвраты', d: 'Продажи и возвраты пробиваются локально — очередь у прилавка не ждёт провайдера.' },
      { t: 'Смены и X/Z-отчёты', d: 'Открытие, закрытие, промежуточный X и итоговый Z — всё считается на месте.' },
      { t: 'Долги с лимитом', d: '«Азамату больше 5 000 не давать» — лимит проверяется прямо на кассе, даже офлайн.' },
      { t: 'Бонусы', d: 'Начисление и списание по проценту из кабинета. Баланс печатается на чеке.' },
      { t: 'Техкарты', d: 'Продали латте — зёрна, молоко и стакан списались. Работает и без сети.' },
      { t: 'Синхронизация до тенге', d: 'Связь вернулась — события уехали на сервер по очереди, без дублей и потерь.' },
    ],
    k2: 'Оборудование',
    hwTitle: 'Работает на том, что есть',
    hwSub: 'POS-моноблок за сотни тысяч тенге не нужен. Подойдёт компьютер, который уже стоит в магазине.',
    hw: [
      { k: 'Касса', t: 'Windows, Android, Sunmi', d: 'Кассовое место — любой Windows-компьютер, Android-планшет или Sunmi-терминал.' },
      { k: 'Сканер', t: 'Сканеры штрихкодов', d: 'USB и Bluetooth-сканеры подключаются в пару кликов. Понимает и акцизные марки.' },
      { k: 'Принтер', t: 'Чековые принтеры', d: 'Лента 58 и 80 мм. Долг и бонусный баланс печатаются прямо на чеке.' },
      { k: 'Весы', t: 'Весы Rongta', d: 'Весовой товар — сыр, колбаса, конфеты — пробивается сам, без ручного ввода.' },
    ],
    k3: 'Фискализация',
    fiscTitle: 'Чеки — в налоговую, по закону',
    fiscSub: 'Табыс работает через аккредитованных ОФД-провайдеров Казахстана — подключим того, с кем вы уже работаете.',
    fisc: [
      'Чек, пробитый офлайн, фискализируется автоматически, когда появляется связь.',
      'Продажа в долг не фискализируется — деньги ещё не получены. Фискализация происходит при погашении.',
      'Каждая отправка в ОФД видна в журнале — понятно, что ушло и что в очереди.',
    ],
    ctaTitle: 'Поставьте кассу за вечер',
    ctaSub: '14 дней бесплатно. Товары — из Excel или из накладной по фото.',
  },
  kk: {
    kicker: 'Касса', ctaStart: 'Тегін бастау', ctaPrices: 'Бағалар',
    h1: 'Интернет керек емес касса',
    sub: 'Интернет бір тәулікке өшсе де — касса чек соғады, ауысымды ашып-жабады, қайтарым мен қарызды қабылдайды. Желі оралғанда бәрі серверге теңгесіне дейін дәл жетеді.',
    heroNote: 'Кез келген Windows-компьютер, Android-планшет немесе Sunmi-терминал. Арнайы жабдық сатып алу керек емес.',
    mockShift: 'Касса · ауысым №14', mockOffline: 'офлайн · кезекте 3 чек', mockTotal: 'Барлығы', mockPay: 'Төлем',
    mockDebt: 'Қарызға: Азамат · лимит 5 000 ₸ — жарайды',
    mockNote: 'интернет оралса — чектер серверге өзі кетеді',
    prods: [['Нан', '160 ₸'], ['Сүт 3,2%', '540 ₸'], ['Кефир 2,5%', '430 ₸'], ['Алма шырыны', '620 ₸'], ['Қара шай', '980 ₸'], ['Қант 1 кг', '590 ₸']],
    receipt: [['Нан ×2', '320 ₸'], ['Сүт 3,2%', '540 ₸'], ['Қант 1 кг', '590 ₸'], ['Сіріңке', '280 ₸']],
    k1: 'Офлайн — толық',
    offTitle: 'Касса желісіз не істей алады',
    offSub: '«Каталог көрсетеді» емес — толық жұмыс істейді. Оқиғалар кезегі желі пайда болғанда серверге жетеді, қайта жіберу дубль жасамайды.',
    offCards: [
      { t: 'Чектер мен қайтарымдар', d: 'Сату мен қайтарым жергілікті соғылады — сөре алдындағы кезек провайдерді күтпейді.' },
      { t: 'Ауысым және X/Z-есептер', d: 'Ашу, жабу, аралық X және қорытынды Z — бәрі орнында есептеледі.' },
      { t: 'Лимиті бар қарыз', d: '«Азаматқа 5 000-нан артық бермеу» — лимит кассада тексеріледі, интернетсіз де.' },
      { t: 'Бонустар', d: 'Кабинеттегі пайыз бойынша есептеу мен шегеру. Баланс чекте басылады.' },
      { t: 'Техкарталар', d: 'Латте саттыңыз — дән, сүт және стакан шегерілді. Желісіз де жұмыс істейді.' },
      { t: 'Теңгесіне дейін дәл', d: 'Байланыс оралды — оқиғалар серверге кезекпен кетті, дубльсіз және шығынсыз.' },
    ],
    k2: 'Жабдық',
    hwTitle: 'Бардың өзінде жұмыс істейді',
    hwSub: 'Жүздеген мың теңгелік POS-моноблок керек емес. Дүкенде тұрған компьютер жарайды.',
    hw: [
      { k: 'Касса', t: 'Windows, Android, Sunmi', d: 'Касса орны — кез келген Windows-компьютер, Android-планшет немесе Sunmi-терминал.' },
      { k: 'Сканер', t: 'Штрихкод сканерлері', d: 'USB және Bluetooth-сканерлер бірнеше кликпен қосылады. Акциз маркаларын да түсінеді.' },
      { k: 'Принтер', t: 'Чек принтерлері', d: '58 және 80 мм таспа. Қарыз бен бонус балансы чекте басылады.' },
      { k: 'Таразы', t: 'Rongta таразылары', d: 'Салмақ тауары — ірімшік, шұжық, кәмпит — қолмен енгізусіз өзі соғылады.' },
    ],
    k3: 'Фискализация',
    fiscTitle: 'Чектер — салыққа, заң бойынша',
    fiscSub: 'Табыс Қазақстанның аккредиттелген ОФД-провайдерлері арқылы жұмыс істейді — сіз пайдаланып жүргенін қосамыз.',
    fisc: [
      'Офлайн соғылған чек байланыс пайда болғанда автоматты фискалданады.',
      'Қарызға сату фискалданбайды — ақша әлі алынған жоқ. Фискализация қарыз өтелгенде болады.',
      'ОФД-ға әр жіберу журналда көрінеді — не кетті, не кезекте тұр — түсінікті.',
    ],
    ctaTitle: 'Кассаны бір кеште орнатыңыз',
    ctaSub: '14 күн тегін. Тауарлар — Excel-ден немесе жүкқұжат фотосынан.',
  },
};

export default function Kassa() {
  const [lang, toggleLang] = useLang();
  const t = T[lang];

  return (
    <div style={{ color: C.ink, background: C.card }}>
      <SiteHeader lang={lang} onLang={toggleLang} active="kassa" />

      <section style={{ ...S.sec, paddingTop: 'clamp(40px,7vw,72px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 'clamp(28px,5vw,52px)', alignItems: 'center' }}>
        <div>
          <div style={S.kicker}>{t.kicker}</div>
          <h1 style={S.h1}>{t.h1}</h1>
          <p style={{ fontSize: 'clamp(15.5px,2vw,17px)', lineHeight: 1.55, color: C.prose, margin: '16px 0 0', maxWidth: '54ch' }}>{t.sub}</p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 28 }}>
            <a href="/register" style={S.btn}>{t.ctaStart}</a>
            <a href="/цены" style={S.ghost}>{t.ctaPrices}</a>
          </div>
          <p style={{ fontSize: 13, color: C.dim, lineHeight: 1.6, margin: '20px 0 0' }}>{t.heroNote}</p>
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, boxShadow: '0 24px 52px rgba(23,33,29,.08)', overflow: 'hidden' }}>
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
              <div style={{ border: `1px solid ${C.lineIn}`, borderRadius: 8, padding: '8px 10px', marginTop: 8, display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: C.brand, flexShrink: 0 }} />
                <span style={{ fontSize: 10.5, color: C.prose, lineHeight: 1.4 }}>{t.mockDebt}</span>
              </div>
              <div style={{ borderTop: '1px dashed #D8D8CF', marginTop: 10, paddingTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600 }}>
                <span>{t.mockTotal}</span><span style={{ fontFamily: mono, whiteSpace: 'nowrap' }}>1 730 ₸</span>
              </div>
              <div style={{ background: C.brand, color: '#fff', borderRadius: 9, minHeight: 44, marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>{t.mockPay}</div>
            </div>
          </div>
          <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.lineIn}`, fontFamily: mono, fontSize: 11.5, color: C.dim }}>{t.mockNote}</div>
        </div>
      </section>

      <section style={{ background: C.sunken, borderTop: `1px solid ${C.lineIn}`, borderBottom: `1px solid ${C.lineIn}`, marginTop: 'clamp(48px,7vw,72px)' }}>
        <div style={{ ...S.wrap, padding: 'clamp(44px,6vw,64px) clamp(16px,4vw,24px)' }}>
          <div style={S.kicker}>{t.k1}</div>
          <h2 style={{ ...S.h2, margin: '10px 0 8px' }}>{t.offTitle}</h2>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: C.prose, margin: '0 0 24px', maxWidth: '70ch' }}>{t.offSub}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 14 }}>
            {t.offCards.map((c: any) => (
              <div key={c.t} style={S.card}>
                <b style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.35 }}>{c.t}</b>
                <p style={{ color: C.prose, fontSize: 13.5, margin: '8px 0 0', lineHeight: 1.6 }}>{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={S.sec}>
        <div style={S.kicker}>{t.k2}</div>
        <h2 style={{ ...S.h2, margin: '10px 0 8px' }}>{t.hwTitle}</h2>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: C.prose, margin: '0 0 24px', maxWidth: '70ch' }}>{t.hwSub}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(235px,1fr))', gap: 14 }}>
          {t.hw.map((h: any) => (
            <div key={h.k} style={S.card}>
              <div style={S.tag}>{h.k}</div>
              <b style={{ display: 'block', fontSize: 15.5, fontWeight: 600, marginTop: 12 }}>{h.t}</b>
              <p style={{ color: C.prose, fontSize: 13.5, margin: '8px 0 0', lineHeight: 1.6 }}>{h.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={S.sec}>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 16, background: C.card, padding: 'clamp(24px,4vw,36px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 'clamp(24px,4vw,40px)' }}>
          <div>
            <div style={S.kicker}>{t.k3}</div>
            <h2 style={{ ...S.h2, fontSize: 'clamp(23px,3.8vw,28px)', margin: '10px 0 0' }}>{t.fiscTitle}</h2>
            <p style={{ fontSize: 14.5, lineHeight: 1.6, color: C.prose, margin: '12px 0 0', maxWidth: '50ch' }}>{t.fiscSub}</p>
          </div>
          <div style={{ display: 'grid', gap: 12, alignContent: 'center' }}>
            {t.fisc.map((x: string) => (
              <div key={x} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ width: 22, height: 22, borderRadius: 99, background: C.brandTint, color: C.brandDark, fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>✓</span>
                <span style={{ color: C.prose, fontSize: 14.5, lineHeight: 1.55 }}>{x}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CtaBand lang={lang} title={t.ctaTitle} sub={t.ctaSub} />
      <SiteFooter lang={lang} />
    </div>
  );
}
