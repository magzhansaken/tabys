'use client';
/**
 * Налоги (часть 22). Форма 910.00 считается из реальных чеков магазина —
 * владельцу остаётся проверить и выгрузить. Отправку в ОГД делает он сам
 * через Кабинет налогоплательщика с ЭЦП (та же граница, что по ЭСФ).
 *
 * Раздел, где ошибка стоит штрафа. Поэтому сумма к уплате — единственное
 * крупное на экране (34 px), а таблица ставок и соцплатежей намеренно
 * тише: на неё смотрят вторым взглядом, а не первым.
 */
import { useEffect, useState } from 'react';
import { api, downloadXlsx } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Input, Select, Field, Stat, Status,
  confirmDanger, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function TaxesPage() {
  const now = new Date();
  const [tab, setTab] = useState('declaration');
  const [year, setYear] = useState(now.getFullYear());
  const [half, setHalf] = useState<1 | 2>(now.getMonth() < 6 ? 1 : 2);
  const [calc, setCalc] = useState<any>(null);
  const [reg, setReg] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [hist, setHist] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setErr('');
    try {
      if (tab === 'declaration') setCalc(await api(`/taxes/declaration/910?year=${year}&half=${half}`));
      if (tab === 'registers') setReg(await api(`/taxes/registers?from=${year}-01-01&to=${year}-12-31`));
      if (tab === 'settings') setSettings(await api('/taxes/settings'));
      if (tab === 'history') setHist(await api('/taxes/history'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab, year, half]);

  const downloadXml = async () => {
    setErr('');
    try {
      const t = await api(`/taxes/declaration/910/xml?year=${year}&half=${half}`);
      const a = document.createElement('a');
      a.href = 'data:application/xml;base64,' + t.base64; a.download = t.fileName; a.click();
    } catch (e: any) { setErr(e.message); }
  };

  const fact = tab === 'declaration'
    ? (calc ? `Форма 910.00 · ${year}, ${half}-е полугодие · к уплате ${money(calc.lines['910.00.004'])}` : 'Считаем из ваших чеков…')
    : tab === 'registers'
      ? (reg ? `Доход за ${year} год — ${money(reg.salesRegister.total)}` : 'Загрузка…')
      : tab === 'history'
        ? `${hist.length} деклараций сохранено`
        : (settings ? `Режим: ${settings.taxRegime === 'simplified' ? 'упрощённая декларация' : settings.taxRegime}${settings.vatPayer ? ' · плательщик НДС' : ''}` : 'Загрузка…');

  return (
    <>
      <PageHeader
        title="Налоги"
        fact={fact}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select value={year} onChange={(e: any) => setYear(Number(e.target.value))}
              options={[now.getFullYear(), now.getFullYear() - 1].map((y) => ({ value: y, label: String(y) }))} />
            <Select value={half} onChange={(e: any) => setHalf(Number(e.target.value) as 1 | 2)}
              options={[{ value: 1, label: '1-е полугодие' }, { value: 2, label: '2-е полугодие' }]} />
          </div>
        }
      />
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'declaration', label: 'Форма 910.00' },
          { key: 'registers', label: 'Регистры' },
          { key: 'history', label: 'История' },
          { key: 'settings', label: 'Настройки налогов' },
        ]} />

        {tab === 'declaration' && calc && (
          <>
            {/* Сумма к уплате — единственное крупное на экране. Ради неё
                раздел и открывают, остальное здесь справочное. */}
            <Card style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 230 }}>
                  <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: C.faint }}>
                    ИПН к уплате
                  </div>
                  <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1.1,
                    marginTop: 8, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {money(calc.lines['910.00.004'])}
                  </div>
                  <div style={{ fontSize: 13.5, color: C.dim, marginTop: 9, lineHeight: 1.5 }}>
                    строка 910.00.004 · ставка {(calc.rate * 100).toFixed(0)}%
                  </div>
                </div>
                <div style={{ paddingLeft: 40, borderLeft: `1px solid ${C.lineIn}`, minWidth: 210 }}>
                  <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: C.faint }}>
                    Соцплатежи «за себя»
                  </div>
                  <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em', lineHeight: 1.1,
                    marginTop: 8, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {money(calc.social.total)}
                  </div>
                  <div style={{ fontSize: 13.5, color: C.dim, marginTop: 9, lineHeight: 1.5 }}>
                    за полугодие, платятся отдельно от ИПН
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.6, margin: '20px 0 0',
                paddingTop: 16, borderTop: `1px solid ${C.lineIn}`, maxWidth: '84ch' }}>
                Посчитано из ваших чеков за период. Отправляете вы сами — через Кабинет
                налогоплательщика с ЭЦП, мы даём готовый XML и цифры. Срок сдачи и уплаты
                за это полугодие смотрите в КНП: он зависит от полугодия и от вашего ОГД.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <Btn onClick={downloadXml}>Скачать XML для КНП</Btn>
                <Btn kind="ghost" onClick={async () => {
                  setErr(''); setMsg('');
                  // Снимок цифр, а не живой отчёт: провёденные потом задним
                  // числом документы в него уже не попадут. Об этом лучше
                  // сказать до сохранения, а не объяснять расхождение после.
                  if (!confirmDanger(
                    `Сохранить декларацию за ${year}, ${half}-е полугодие?`,
                    'В историю ляжет снимок цифр на сейчас. Если позже вы проведёте документы задним числом, сохранённая декларация останется прежней — новый расчёт будет отличаться.',
                  )) return;
                  try { await api('/taxes/declaration/910', { method: 'POST', body: JSON.stringify({ year, half }) });
                    setMsg('Декларация сохранена в историю'); }
                  catch (e: any) { setErr(e.message); }
                }}>Сохранить в историю</Btn>
              </div>
            </Card>

            {calc.warnings?.length > 0 && (
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', marginBottom: 14,
                background: '#FFFCF6', border: `1px solid #E8DCC3`, borderRadius: 10, padding: '14px 16px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.gold, flex: '0 0 7px', marginTop: 7 }} />
                <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.6, maxWidth: '80ch' }}>
                  {calc.warnings.map((w: string, i: number) => (
                    <div key={i} style={{ marginTop: i ? 6 : 0 }}>{w}</div>
                  ))}
                </div>
              </div>
            )}

            <Card title={`Как сложился доход — ${year}, ${half}-е полугодие`}>
              <DataTable storageKey="taxes" exportName="taxes" search={false}
                hint="Эти строки уходят в декларацию как есть. Если цифра не сходится с вашими ожиданиями, ищите причину в чеках за период, а не здесь."
                cols={[
                  { h: 'Строка формы', k: 'n' },
                  { h: 'Сумма', right: true, r: (r: any) => (
                      <span style={{ fontWeight: r.bold ? 600 : 400, whiteSpace: 'nowrap' }}>{money(r.v)}</span>
                    ) },
                ]}
                empty="За это полугодие продаж не было — декларация выйдет нулевой. Это нормально, если магазин ещё не открылся, и повод проверить кассы, если он работал."
                rows={[
                  { n: '910.00.001 — доход всего', v: calc.lines['910.00.001'], bold: true },
                  { n: '910.00.001 I — в том числе наличными', v: calc.lines['910.00.001_I'] },
                  { n: '910.00.001 II — в том числе безналичными', v: calc.lines['910.00.001_II'] },
                  { n: `910.00.004 — ИПН к уплате (${(calc.rate * 100).toFixed(0)}%)`, v: calc.lines['910.00.004'], bold: true },
                ]} />
            </Card>

            <Card title="Социальные платежи «за себя»" style={{ marginTop: 14 }}>
              <DataTable storageKey="taxes-social" exportName="taxes-social" search={false}
                hint="Справочно, за шесть месяцев. Это отдельные платежи: ИПН их не включает, и заплатить нужно и то, и другое."
                cols={[
                  { h: 'Платёж', k: 'n' },
                  { h: 'Сумма за полугодие', right: true, r: (r: any) => (
                      <span style={{ fontWeight: r.bold ? 600 : 400, whiteSpace: 'nowrap' }}>{money(r.v)}</span>
                    ) },
                ]}
                empty="Соцплатежи не посчитаны: не задан заявленный доход. Задайте его во вкладке «Настройки налогов» — без него ОПВ, СО и ВОСМС считать не от чего."
                rows={[
                  { n: 'ОПВ — пенсионные, 10%', v: calc.social.opv },
                  { n: 'ОПВР — пенсионные работодателя, 3,5%', v: calc.social.opvr },
                  { n: 'СО — социальные отчисления, 5%', v: calc.social.so },
                  { n: 'ВОСМС — медстрахование', v: calc.social.vosms },
                  { n: 'Итого соцплатежей', v: calc.social.total, bold: true },
                ]} />
              <p style={{ fontSize: 13, color: C.dim, margin: '14px 0 0', lineHeight: 1.6 }}>
                База — заявленный доход {money(calc.social.declaredMonthly)} в месяц, он задаётся
                во вкладке «Настройки налогов». Социальный налог с 2026 года отменён.
              </p>
            </Card>
          </>
        )}

        {tab === 'registers' && reg && (
          <Card title={`Налоговые регистры за ${year} год`}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
              <Stat label="Доход наличными" value={money(reg.salesRegister.cash)} />
              <Stat label="Доход безналичными" value={money(reg.salesRegister.noncash)} />
              <Stat label="Доход всего" value={money(reg.salesRegister.total)} />
              <Stat label="Закупки за период" value={money(reg.purchaseRegister.total)} />
            </div>
            <DataTable storageKey="taxes-2" exportName="taxes-2" search={false}
              hint="Помесячная разбивка — то, что покажете при проверке. Наличные и безналичные разделены: в декларации это разные строки."
              empty="Нет продаж за период" cols={[
              { h: 'Месяц', k: 'month' },
              { h: 'Наличными', right: true, r: (r: any) => money(r.cash) },
              { h: 'Безналичными', right: true, r: (r: any) => money(r.noncash) },
              { h: 'Чеков', right: true, k: 'receipts' },
              { h: 'Возвратов', right: true, r: (r: any) => Number(r.returns) > 0
                  ? <span style={{ color: C.red }}>{r.returns}</span>
                  : <span style={{ color: C.faint }}>—</span> },
            ]} rows={reg.salesRegister.byMonth} />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="История деклараций">
            <DataTable storageKey="taxes-3" exportName="taxes-3"
              hint="Сохранённая декларация — снимок цифр на момент расчёта. Если позже вы провели документы задним числом, новый расчёт может отличаться."
              empty="Пока нет сохранённых деклараций — посчитайте форму 910.00 и нажмите «Сохранить в историю»" cols={[
              { h: 'Форма', k: 'form' },
              { h: 'Период', r: (r: any) => `${r.year}, ${r.half}-е полуг.` },
              { h: 'Доход', right: true, r: (r: any) => money(r.income) },
              { h: 'ИПН', right: true, r: (r: any) => <b style={{ whiteSpace: 'nowrap' }}>{money(r.ipn)}</b> },
              { h: 'Статус', r: (r: any) => <Status value={r.status} /> },
              { h: 'Создана', r: (r: any) => dt(r.createdAt) },
            ]} rows={hist} />
          </Card>
        )}

        {tab === 'settings' && settings && (
          <Card title="Настройки налогов">
            <p style={{ fontSize: 13.5, color: C.dim, margin: '0 0 18px', lineHeight: 1.55, maxWidth: '80ch' }}>
              Задаётся один раз и влияет на каждый расчёт. Ошибка здесь тише всего:
              декларация посчитается и выгрузится, а неверной окажется сумма.
            </p>
            <div style={{ display: 'grid', gap: 14, maxWidth: 460 }}>
              <Field label="Код органа госдоходов (ОГД), 4 цифры">
                <Input defaultValue={settings.ogedCode ?? ''} id="oged" w="100%" />
              </Field>
              <Field label="Ставка ИПН маслихата (если отличается от 4%)">
                <Select id="rate" defaultValue={settings.maslikhatIpnRate ?? ''} style={{ width: '100%' }}
                  options={[{ value: '', label: 'Базовая 4%' },
                    ...[0.02, 0.03, 0.04, 0.05, 0.06].map((r) => ({ value: r, label: `${(r * 100).toFixed(0)}%` }))]} />
              </Field>
              <Field label="Заявленный доход для соцплатежей, ₸/мес (мин. 1 МЗП = 85 000)">
                <Input type="number" defaultValue={settings.declaredIncomeMonthly ?? 85000} id="declared"
                  w="100%" style={{ textAlign: 'right' }} />
              </Field>
              <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 14, minHeight: 34, cursor: 'pointer' }}>
                <input type="checkbox" defaultChecked={settings.bornBefore1975} id="born"
                  style={{ width: 16, height: 16, accentColor: C.accent }} />
                ИП рождён до 1975 года — ОПВР не платится
              </label>
              <Btn style={{ justifySelf: 'start' }} onClick={async () => {
                setErr(''); setMsg('');
                // Ошибка здесь самая тихая в кабинете: декларация посчитается
                // и выгрузится, неверной окажется только сумма.
                if (!confirmDanger(
                  'Сохранить настройки налогов?',
                  'Все следующие расчёты пойдут по новым значениям. Неверный код ОГД или ставка маслихата не вызовут ошибку — декларация просто посчитается неправильно, и узнаете вы об этом от налоговой.',
                )) return;
                try {
                  const rate = (document.getElementById('rate') as HTMLSelectElement).value;
                  await api('/taxes/settings', { method: 'POST', body: JSON.stringify({
                    ogedCode: (document.getElementById('oged') as HTMLInputElement).value || null,
                    maslikhatIpnRate: rate ? Number(rate) : null,
                    declaredIncomeMonthly: Number((document.getElementById('declared') as HTMLInputElement).value) || null,
                    bornBefore1975: (document.getElementById('born') as HTMLInputElement).checked,
                  }) });
                  setMsg('Настройки сохранены'); load();
                } catch (e: any) { setErr(e.message); }
              }}>Сохранить</Btn>
            </div>
            <p style={{ fontSize: 13, color: C.dim, marginTop: 20, paddingTop: 16,
              borderTop: `1px solid ${C.lineIn}`, lineHeight: 1.6, maxWidth: '80ch' }}>
              Режим: {settings.taxRegime === 'simplified' ? 'упрощённая декларация' : settings.taxRegime}.
              {settings.vatPayer ? ' Плательщик НДС.' : ' Не плательщик НДС.'}
              {' '}Ставку маслихата вашего региона уточните в Кабинете налогоплательщика —
              она отличается от области к области.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
