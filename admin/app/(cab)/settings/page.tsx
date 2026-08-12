'use client';
/**
 * Настройки: чек-лист запуска, подписка, фискализация, оборудование, ЭЦП.
 * Чек-лист — модель онбординга из части 12: владелец видит, что осталось
 * сделать до первого чека.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Field, Input, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function SettingsPage() {
  const [tab, setTab] = useState('onboarding');
  const [payAmount, setPayAmount] = useState('');
  const [onb, setOnb] = useState<any>(null);
  const [access, setAccess] = useState<any>(null);
  const [tariffs, setTariffs] = useState<any[]>([]);
  const [billHist, setBillHist] = useState<any[]>([]);
  const [fiscal, setFiscal] = useState<any>(null);
  const [readiness, setReadiness] = useState<any[]>([]);
  const [equipment, setEquipment] = useState<any[]>([]);
  const [keys, setKeys] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [brand, setBrand] = useState<any>(null);
  const [adText, setAdText] = useState('');

  const load = async () => {
    try {
      if (tab === 'onboarding') setOnb(await api('/onboarding'));
      if (tab === 'billing') {
        setAccess(await api('/billing/access'));
        setTariffs(await api('/billing/tariffs'));
        setBillHist(await api('/billing/history'));
      }
      if (tab === 'fiscal') { setFiscal(await api('/fiscal/health')); setKeys(await api('/documents/keys/health')); setReadiness(await api('/fiscal/readiness')); }
      if (tab === 'equipment') setEquipment(await api('/equipment'));
      if (tab === 'branding') {
        const b = await api('/branding');
        setBrand(b); setAdText(b.receiptAdText ?? '');
      }
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { setErr(''); load(); }, [tab]);

  const subscribe = async (code: string) => {
    setErr(''); setMsg('');
    try { await api('/billing/subscribe', { method: 'POST', body: JSON.stringify({ tariffCode: code }) });
      setMsg('Тариф выбран'); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const stepDone = async (code: string) => {
    try { await api(`/onboarding/steps/${code}/complete`, { method: 'POST', body: JSON.stringify({}) }); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const steps: any[] = onb?.steps ?? (Array.isArray(onb) ? onb : []);

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Настройки</h1>
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'onboarding', label: 'Чек-лист запуска' },
          { key: 'billing', label: 'Подписка' },
          { key: 'fiscal', label: 'Фискализация и ЭЦП' },
          { key: 'equipment', label: 'Оборудование' },
          { key: 'branding', label: 'Фирменный стиль' },
        ]} />

        {tab === 'onboarding' && (
          <Card title="До первого чека">
            <DataTable storageKey="settings" exportName="settings" empty="Чек-лист загружается…"
              cols={[
                { h: 'Шаг', r: (r) => r.title ?? r.name ?? r.code },
                { h: 'Статус', r: (r) => r.status === 'done' || r.completed
                    ? <Badge tone="ok">готово</Badge>
                    : r.status === 'skipped' ? <Badge tone="dim">пропущен</Badge> : <Badge tone="warn">ожидает</Badge> },
                { h: '', r: (r) => (r.status === 'done' || r.completed) ? null
                    : <Btn kind="ghost" onClick={() => stepDone(r.code)}>Отметить готовым</Btn> },
              ]}
              rows={steps} />
          </Card>
        )}

        {tab === 'billing' && (
          <>
            <Card title="Текущий доступ">
              {access ? (
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
                  {access.canSell ? <Badge tone="ok">Продажи открыты</Badge> : <Badge tone="bad">{access.reason ?? 'Продажи закрыты'}</Badge>}
                  <span>Статус: <b>{access.status ?? '—'}</b></span>
                  <span>Оплачено до: <b>{access.paidUntil ? new Date(access.paidUntil).toLocaleDateString('ru-RU') : '—'}</b></span>
                  <span>Баланс: <b>{money(access.balance)}</b></span>
                  {access.priceLocked != null && <span style={{ color: C.dim }}>Цена зафиксирована: {money(access.priceLocked)}/мес</span>}
                </div>
              ) : 'Загрузка…'}
            </Card>

            <Card title="Пополнить онлайн" style={{ marginTop: 14 }}>
              <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
                Оплата подписки через Kaspi или картой. Создайте счёт — откроется
                ссылка на оплату, после оплаты баланс пополнится автоматически.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Input type="number" placeholder="Сумма, ₸" value={payAmount} onChange={(e: any) => setPayAmount(e.target.value)} style={{ maxWidth: 140 }} />
                <Btn onClick={async () => {
                  setErr(''); setMsg('');
                  try { const inv = await api('/billing/invoice', { method: 'POST', body: JSON.stringify({ amount: +payAmount, provider: 'mock' }) });
                    setMsg(`Счёт создан. Оплатите по ссылке: ${inv.payUrl}`); setPayAmount(''); load(); }
                  catch (e: any) { setErr(e.message); }
                }}>Создать счёт</Btn>
                <label style={{ marginLeft: 'auto', fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={!!access?.autoRenew}
                    onChange={async (e) => { await api('/billing/auto-renew', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) }); load(); }} />
                  Автопродление
                </label>
              </div>
            </Card>
            <Card title="Тарифы" style={{ marginTop: 14 }}>
              <DataTable storageKey="settings-2" exportName="settings-2" cols={[
                { h: 'Тариф', k: 'name' },
                { h: 'Цена в месяц', right: true, r: (r) => money(r.price_month) },
                { h: 'Доп. точка', right: true, r: (r) => money(r.price_extra_store) },
                { h: '', r: (r) => <Btn kind="ghost" onClick={() => subscribe(r.code)}>Выбрать</Btn> },
              ]} rows={tariffs} />
            </Card>
            <Card title="История платежей" style={{ marginTop: 14 }}>
              <DataTable storageKey="settings-3" exportName="settings-3" empty="Платежей ещё не было"
                cols={[
                  { h: 'Когда', r: (r) => dt(r.ts ?? r.created_at) },
                  { h: 'Что', r: (r) => r.kind ?? r.comment ?? '—' },
                  { h: 'Сумма', right: true, r: (r) => money(r.amount) },
                ]} rows={billHist} />
            </Card>
          </>
        )}

        {tab === 'fiscal' && (
          <>
            <Card title="Фискализация (WebKassa/ReKassa)">
              {fiscal ? (
                <div style={{ fontSize: 14, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                  {(fiscal.ok ?? fiscal.healthy) ? <Badge tone="ok">Связь в порядке</Badge> : <Badge tone="warn">{fiscal.message ?? 'ККМ не подключены'}</Badge>}
                  {fiscal.queued != null && <span>В очереди чеков: <b>{fiscal.queued}</b></span>}
                  {fiscal.failed != null && Number(fiscal.failed) > 0 && <span style={{ color: C.red }}>Ошибок: {fiscal.failed}</span>}
                </div>
              ) : 'Загрузка…'}
              <p style={{ fontSize: 13, color: C.dim, marginBottom: 0 }}>
                Для боевой работы нужны договор с оператором фискальных данных и регистрация ККМ в КГД —
                см. чек-лист запуска.
              </p>
            </Card>

            <Card title="Боевой режим касс" style={{ marginTop: 14 }}>
              <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
                Касса шлёт чеки оператору только в боевом режиме. Включить его
                можно после того, как внесены РНМ/ЗНМ (получите в Кабинете
                налогоплательщика) и прошла проверка связи.
              </p>
              {(readiness ?? []).length === 0
                ? <div style={{ fontSize: 14, color: C.dim }}>Кассы с фискализацией не настроены.</div>
                : <DataTable storageKey="settings-4" exportName="settings-4" cols={[
                    { h: 'Касса', k: 'cashRegister' },
                    { h: 'Оператор', k: 'provider' },
                    { h: 'Режим', r: (r: any) => r.env === 'production'
                        ? <Badge tone="ok">боевой</Badge> : <Badge tone="dim">тест</Badge> },
                    { h: 'Ключи', r: (r: any) => r.hasCredentials ? '✓' : '—' },
                    { h: 'РНМ/ЗНМ', r: (r: any) => r.hasRegNumber ? '✓' : '—' },
                    { h: 'Связь', r: (r: any) => r.connectionOk
                        ? <Badge tone="ok">есть</Badge> : <Badge tone="warn">не проверена</Badge> },
                    { h: '', r: (r: any) => (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Btn kind="ghost" onClick={async () => {
                          setErr(''); setMsg('');
                          try { const res = await api('/fiscal/check-connection', { method: 'POST', body: JSON.stringify({ kkmId: r.kkmId }) });
                            setMsg(res.message); load(); } catch (e: any) { setErr(e.message); }
                        }}>Проверить связь</Btn>
                        {r.env !== 'production'
                          ? <Btn onClick={async () => {
                              setErr(''); setMsg('');
                              try { const res = await api('/fiscal/set-env', { method: 'POST', body: JSON.stringify({ kkmId: r.kkmId, env: 'production' }) });
                                setMsg(res.message); load(); } catch (e: any) { setErr(e.message); }
                            }} disabled={!r.readyForProduction}>В боевой режим</Btn>
                          : <Btn kind="ghost" onClick={async () => {
                              await api('/fiscal/set-env', { method: 'POST', body: JSON.stringify({ kkmId: r.kkmId, env: 'test' }) }); load();
                            }}>В тест</Btn>}
                      </div>
                    ) },
                  ]} rows={readiness} />}
            </Card>
            <Card title="ЭЦП для ЭСФ" style={{ marginTop: 14 }}>
              {keys ? (
                Array.isArray(keys) && keys.length === 0
                  ? <div style={{ fontSize: 14, color: C.dim }}>Ключи не загружены. Понадобятся для выписки ЭСФ.</div>
                  : <DataTable storageKey="settings-5" exportName="settings-5" cols={[
                      { h: 'Ключ', r: (r: any) => r.name ?? r.owner ?? '—' },
                      { h: 'Действует до', r: (r: any) => r.expires_at ? new Date(r.expires_at).toLocaleDateString('ru-RU') : '—' },
                      { h: 'Статус', r: (r: any) => r.expired ? <Badge tone="bad">истёк</Badge> : <Badge tone="ok">действует</Badge> },
                    ]} rows={Array.isArray(keys) ? keys : keys.keys ?? []} />
              ) : 'Загрузка…'}
            </Card>
          </>
        )}

        {tab === 'equipment' && (
          <Card title="Весы, принтеры, дисплеи">
            <DataTable storageKey="settings-6" exportName="settings-6" empty="Оборудование не добавлено. Весы Rongta и принтеры Xprinter подключаются по сети — см. документацию."
              cols={[
                { h: 'Название', k: 'name' },
                { h: 'Тип', k: 'kind' },
                { h: 'Адрес', r: (r) => r.ip ? `${r.ip}:${r.port ?? ''}` : '—' },
                { h: 'Состояние', r: (r) => r.online ? <Badge tone="ok">на связи</Badge> : <Badge tone="dim">не проверялось</Badge> },
              ]}
              rows={equipment} />
          </Card>
        )}

        {tab === 'branding' && (
          <Card title="Логотип и чек">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Один логотип — и на чеке, и в документах. PNG или JPG до 500 КБ
              (тот же порог, что у Wipon). Для чека мы сами переведём картинку
              в чёрно-белый растр нужной ширины — на кассе настраивать нечего.
            </p>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                {brand?.logo
                  ? <img src={brand.logo} alt="логотип" style={{ maxWidth: 220, maxHeight: 120, border: `1px solid ${C.line}`, borderRadius: 8, background: '#fff', padding: 6 }} />
                  : <div style={{ width: 220, height: 120, border: `1px dashed ${C.line}`, borderRadius: 8, display: 'grid', placeItems: 'center', color: C.dim, fontSize: 13 }}>Логотипа нет</div>}
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }}
                      onChange={async (e: any) => {
                        const f = e.target.files?.[0]; if (!f) return;
                        setErr(''); setMsg('');
                        if (f.size > 500 * 1024) { setErr(`Файл ${Math.round(f.size/1024)} КБ — больше 500 КБ`); return; }
                        const b64: string = await new Promise((res, rej) => {
                          const r = new FileReader();
                          r.onload = () => res(String(r.result).split(',')[1]);
                          r.onerror = () => rej(new Error('Не удалось прочитать файл'));
                          r.readAsDataURL(f);
                        });
                        try {
                          const r = await api('/branding/logo', { method: 'POST',
                            body: JSON.stringify({ base64: b64, mime: f.type, printerWidth: 384 }) });
                          setMsg(`Логотип загружен, для чека — ${r.receiptLogo.width}×${r.receiptLogo.height} точек`);
                          load();
                        } catch (e: any) { setErr(e.message); }
                      }} />
                    <span style={{ display: 'inline-block', border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 14px', fontSize: 14 }}>Загрузить логотип</span>
                  </label>
                  {brand?.logo && <Btn kind="ghost" onClick={async () => { await api('/branding/logo/clear', { method: 'POST' }); load(); }}>Убрать</Btn>}
                </div>
                {brand?.hasReceiptLogo && (
                  <p style={{ fontSize: 12, color: C.dim }}>
                    Для чека готов растр {brand.receiptLogoSize?.width}×{brand.receiptLogoSize?.height} —
                    кассы получат его при следующей синхронизации.
                  </p>
                )}
              </div>

              <div style={{ minWidth: 280, flex: 1 }}>
                <Field label="Рекламный текст на чеке (до 200 символов)">
                  <textarea value={adText} onChange={(e: any) => setAdText(e.target.value)}
                    placeholder="Спасибо за покупку! Скидка 10% по вторникам"
                    style={{ width: '100%', minHeight: 80, padding: 10, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
                </Field>
                <Btn onClick={async () => {
                  setErr(''); setMsg('');
                  try { await api('/branding/ad-text', { method: 'POST', body: JSON.stringify({ text: adText }) });
                    setMsg('Текст сохранён — появится на чеках после синхронизации касс'); load(); }
                  catch (e: any) { setErr(e.message); }
                }}>Сохранить текст</Btn>
                <p style={{ fontSize: 12, color: C.dim }}>
                  Печатается внизу чека по центру. Строка сама переносится по ширине ленты.
                </p>
              </div>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
