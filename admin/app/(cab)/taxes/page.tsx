'use client';
/**
 * Налоги (часть 22). Форма 910.00 считается из реальных чеков магазина —
 * владельцу остаётся проверить и выгрузить. Отправку в ОГД делает он сам
 * через Кабинет налогоплательщика с ЭЦП (та же граница, что по ЭСФ).
 */
import { useEffect, useState } from 'react';
import { api, downloadXlsx } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Field, Stat, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

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

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Налоги</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.line}` }}>
            {[now.getFullYear(), now.getFullYear() - 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={half} onChange={(e) => setHalf(Number(e.target.value) as 1 | 2)}
            style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.line}` }}>
            <option value={1}>1-е полугодие</option>
            <option value={2}>2-е полугодие</option>
          </select>
        </div>
      </div>
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
          <Card title={`Упрощённая декларация 910.00 — ${year}, ${half}-е полугодие`}>
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Посчитано из ваших чеков за период. Отправку в органы госдоходов
              вы делаете сами через Кабинет налогоплательщика с ЭЦП — мы даём
              готовый XML и цифры.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Stat label="Доход всего (910.00.001)" value={money(calc.lines['910.00.001'])} />
              <Stat label="в т.ч. наличными" value={money(calc.lines['910.00.001_I'])} />
              <Stat label="в т.ч. безналичными" value={money(calc.lines['910.00.001_II'])} />
              <Stat label={`ИПН к уплате (${(calc.rate * 100).toFixed(0)}%)`} value={money(calc.lines['910.00.004'])} tone="accent" />
            </div>

            {calc.warnings?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {calc.warnings.map((w: string, i: number) => (
                  <p key={i} style={{ color: '#b45309', fontSize: 13, margin: '4px 0' }}>⚠ {w}</p>
                ))}
              </div>
            )}

            <h3 style={{ fontSize: 15, marginTop: 18 }}>Социальные платежи «за себя» (справочно, за 6 мес.)</h3>
            <DataTable hint="Расчёт налогов по ставкам Казахстана и подготовка формы 910. Проверьте настройки режима перед первым расчётом." storageKey="taxes" exportName="taxes" cols={[
              { h: 'Платёж', k: 'n' },
              { h: 'Сумма за полугодие', right: true, r: (r: any) => money(r.v) },
            ]} rows={[
              { n: 'ОПВ (пенсионные, 10%)', v: calc.social.opv },
              { n: 'ОПВР (пенсионные работодателя, 3.5%)', v: calc.social.opvr },
              { n: 'СО (социальные отчисления, 5%)', v: calc.social.so },
              { n: 'ВОСМС (медстрахование)', v: calc.social.vosms },
              { n: 'Итого соцплатежей', v: calc.social.total },
            ]} />
            <p style={{ fontSize: 12, color: C.dim }}>
              База соцплатежей — заявленный доход {money(calc.social.declaredMonthly)}/мес.
              Соцналог с 2026 года отменён.
            </p>

            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <Btn onClick={downloadXml}>Скачать XML для КНП</Btn>
              <Btn kind="ghost" onClick={async () => {
                setErr(''); setMsg('');
                try { await api('/taxes/declaration/910', { method: 'POST', body: JSON.stringify({ year, half }) });
                  setMsg('Декларация сохранена в историю'); }
                catch (e: any) { setErr(e.message); }
              }}>Сохранить в историю</Btn>
            </div>
          </Card>
        )}

        {tab === 'registers' && reg && (
          <Card title={`Налоговые регистры за ${year} год`}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <Stat label="Доход наличными" value={money(reg.salesRegister.cash)} />
              <Stat label="Доход безналичными" value={money(reg.salesRegister.noncash)} />
              <Stat label="Доход всего" value={money(reg.salesRegister.total)} />
              <Stat label="Закупки за период" value={money(reg.purchaseRegister.total)} />
            </div>
            <h3 style={{ fontSize: 15 }}>Отчёт по продажам помесячно</h3>
            <DataTable storageKey="taxes-2" exportName="taxes-2" empty="Нет продаж за период" cols={[
              { h: 'Месяц', k: 'month' },
              { h: 'Наличными', right: true, r: (r: any) => money(r.cash) },
              { h: 'Безналичными', right: true, r: (r: any) => money(r.noncash) },
              { h: 'Чеков', right: true, k: 'receipts' },
              { h: 'Возвратов', right: true, k: 'returns' },
            ]} rows={reg.salesRegister.byMonth} />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="История деклараций">
            <DataTable storageKey="taxes-3" exportName="taxes-3" empty="Пока нет сохранённых деклараций" cols={[
              { h: 'Форма', k: 'form' },
              { h: 'Период', r: (r: any) => `${r.year}, ${r.half}-е полуг.` },
              { h: 'Доход', right: true, r: (r: any) => money(r.income) },
              { h: 'ИПН', right: true, r: (r: any) => money(r.ipn) },
              { h: 'Статус', r: (r: any) => <Badge tone={r.status === 'exported' ? 'ok' : 'dim'}>{r.status === 'exported' ? 'выгружена' : 'черновик'}</Badge> },
              { h: 'Создана', r: (r: any) => dt(r.createdAt) },
            ]} rows={hist} />
          </Card>
        )}

        {tab === 'settings' && settings && (
          <Card title="Настройки налогов">
            <div style={{ display: 'grid', gap: 12, maxWidth: 440 }}>
              <Field label="Код органа госдоходов (ОГД), 4 цифры">
                <input defaultValue={settings.ogedCode ?? ''} id="oged"
                  style={{ width: '100%', padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, boxSizing: 'border-box' }} />
              </Field>
              <Field label="Ставка ИПН маслихата (если отличается от 4%)">
                <select id="rate" defaultValue={settings.maslikhatIpnRate ?? ''}
                  style={{ width: '100%', padding: 10, border: `1px solid ${C.line}`, borderRadius: 8 }}>
                  <option value="">Базовая 4%</option>
                  {[0.02, 0.03, 0.04, 0.05, 0.06].map((r) => <option key={r} value={r}>{(r * 100).toFixed(0)}%</option>)}
                </select>
              </Field>
              <Field label="Заявленный доход для соцплатежей, ₸/мес (мин. 1 МЗП = 85 000)">
                <input type="number" defaultValue={settings.declaredIncomeMonthly ?? 85000} id="declared"
                  style={{ width: '100%', padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, boxSizing: 'border-box' }} />
              </Field>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" defaultChecked={settings.bornBefore1975} id="born" />
                ИП рождён до 1975 года (ОПВР не платится)
              </label>
              <Btn onClick={async () => {
                setErr(''); setMsg('');
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
            <p style={{ fontSize: 12, color: C.dim, marginTop: 14 }}>
              Режим: {settings.taxRegime === 'simplified' ? 'упрощённая декларация' : settings.taxRegime}.
              {settings.vatPayer ? ' Плательщик НДС.' : ' Не плательщик НДС.'}
              Ставку маслихата вашего региона уточните в Кабинете налогоплательщика.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
