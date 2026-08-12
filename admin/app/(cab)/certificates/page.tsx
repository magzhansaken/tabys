'use client';
/**
 * Подарочные сертификаты (часть 25). Свои, без внешних систем — обгоняем
 * МойСклад, у которого они «в разработке» и требуют Бонус Плюс / Teyca.
 * Продажа, частичное гашение, срок действия — всё наше.
 *
 * Перевод статусов сертификата раньше жил прямо здесь — второй перевод,
 * ровно то, от чего защищает Status. Теперь он в ui.tsx под kind="cert":
 * у аккаунта active — «Работает», у сертификата — «Активен».
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, RevealOnce, Status, Btn, Field, Input, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function CertificatesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [nominal, setNominal] = useState('');
  const [validDays, setValidDays] = useState('365');
  const [checkCode, setCheckCode] = useState('');
  const [checked, setChecked] = useState<any>(null);
  const [sold, setSold] = useState<any>(null);
  const [err, setErr] = useState('');

  const load = async () => {
    setErr('');
    try { setRows(await api('/cash/certificates')); } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const sell = async () => {
    setErr(''); setSold(null);
    if (!(+nominal > 0)) { setErr('Укажите номинал'); return; }
    try {
      const r = await api('/cash/certificate/sell', { method: 'POST',
        body: JSON.stringify({ nominal: +nominal, validDays: validDays ? +validDays : undefined }) });
      setSold(r);
      setNominal(''); load();
    } catch (e: any) { setErr(e.message); }
  };

  const check = async () => {
    setErr(''); setChecked(null);
    try { setChecked(await api(`/cash/certificate/check?code=${encodeURIComponent(checkCode.trim())}`)); }
    catch (e: any) { setErr(e.message); }
  };

  // Непогашенные сертификаты — это долг магазина перед покупателем,
  // а не выручка. Поэтому факт в шапке считает именно остаток.
  const active = rows.filter((r: any) => r.status === 'active');
  const owed = active.reduce((s: number, r: any) => s + Number(r.balance ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Подарочные сертификаты"
        fact={rows.length
          ? `${active.length} активных на ${money(owed)} · всего выпущено ${rows.length}`
          : 'Сертификаты ещё не выпускались'}
      />
      <ErrLine err={err} />

      {sold && (
        <div style={{ marginTop: 14 }}>
          <RevealOnce
            title={`Сертификат на ${money(sold.nominal)} продан`}
            value={sold.code}
            note="Выдайте этот код покупателю: по нему сертификат гасится на кассе, в том числе частями. Код есть в списке ниже, но лучше записать его сейчас."
          />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 14 }}>
        <Card title="Продать сертификат">
          <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
            Свой сертификат — без подключения внешних систем лояльности.
            Код выдаётся покупателю, гасить можно частями.
          </p>
          <Field label="Номинал, ₸">
            <Input type="number" value={nominal} onChange={(e: any) => setNominal(e.target.value)} placeholder="5000" style={{ textAlign: 'right' }} />
          </Field>
          <Field label="Срок действия, дней (пусто — бессрочно)">
            <Input type="number" value={validDays} onChange={(e: any) => setValidDays(e.target.value)} style={{ textAlign: 'right' }} />
          </Field>
          <Btn onClick={sell} style={{ marginTop: 12 }}>Продать</Btn>
        </Card>

        <Card title="Проверить сертификат">
          <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
            Введите код с карты покупателя — увидите остаток и годность.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input value={checkCode} onChange={(e: any) => setCheckCode(e.target.value)} placeholder="12 цифр" />
            <Btn kind="ghost" onClick={check}>Проверить</Btn>
          </div>
          {checked && (
            <div style={{ marginTop: 14, fontSize: 14 }}>
              <div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {money(checked.balance)}
              </div>
              <div style={{ fontSize: 13, color: C.dim, marginTop: 3 }}>остаток из {money(checked.nominal)}</div>
              <div style={{ marginTop: 10 }}>
                {checked.usable
                  ? <Badge tone="ok">можно использовать</Badge>
                  : <Status value={checked.status} kind="cert" />}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Все сертификаты" style={{ marginTop: 14 }}>
        <DataTable storageKey="certificates" exportName="certificates"
          hint="Сертификат — деньги, полученные вперёд. Пока он не погашен, это ваш долг перед покупателем, а не выручка."
          empty="Сертификатов пока нет — выпустите первый на любую сумму" cols={[
          { h: 'Код', k: 'code' },
          { h: 'Номинал', right: true, r: (r: any) => money(r.nominal) },
          { h: 'Остаток', right: true, r: (r: any) => (
              <span style={{ fontWeight: Number(r.balance) > 0 ? 600 : 400, color: Number(r.balance) > 0 ? C.text : C.faint }}>
                {money(r.balance)}
              </span>
            ) },
          { h: 'Действует до', r: (r: any) => r.validUntil ?? 'бессрочно' },
          { h: 'Кому', r: (r: any) => r.customerName ?? 'на предъявителя' },
          { h: 'Статус', r: (r: any) => <Status value={r.status} kind="cert" /> },
        ]} rows={rows} />
      </Card>
    </>
  );
}
