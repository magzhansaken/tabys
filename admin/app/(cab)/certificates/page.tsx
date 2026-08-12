'use client';
/**
 * Подарочные сертификаты (часть 25). Свои, без внешних систем — обгоняем
 * МойСклад, у которого они «в разработке» и требуют Бонус Плюс / Teyca.
 * Продажа, частичное гашение, срок действия — всё наше.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Btn, Field, Input, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function CertificatesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [nominal, setNominal] = useState('');
  const [validDays, setValidDays] = useState('365');
  const [checkCode, setCheckCode] = useState('');
  const [checked, setChecked] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setErr('');
    try { setRows(await api('/cash/certificates')); } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const sell = async () => {
    setErr(''); setMsg('');
    if (!(+nominal > 0)) { setErr('Укажите номинал'); return; }
    try {
      const r = await api('/cash/certificate/sell', { method: 'POST',
        body: JSON.stringify({ nominal: +nominal, validDays: validDays ? +validDays : undefined }) });
      setMsg(`Сертификат продан. Код для покупателя: ${r.code} (номинал ${money(r.nominal)})`);
      setNominal(''); load();
    } catch (e: any) { setErr(e.message); }
  };

  const check = async () => {
    setErr(''); setChecked(null);
    try { setChecked(await api(`/cash/certificate/check?code=${encodeURIComponent(checkCode.trim())}`)); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Подарочные сертификаты</h1>
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 14, fontWeight: 600 }}>{msg}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 14 }}>
        <Card title="Продать сертификат">
          <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
            Свой сертификат — без подключения внешних систем лояльности.
            Код выдаётся покупателю, гасить можно частями.
          </p>
          <Field label="Номинал, ₸">
            <Input type="number" value={nominal} onChange={(e: any) => setNominal(e.target.value)} placeholder="5000" />
          </Field>
          <Field label="Срок действия, дней (пусто — бессрочно)">
            <Input type="number" value={validDays} onChange={(e: any) => setValidDays(e.target.value)} />
          </Field>
          <Btn onClick={sell}>Продать</Btn>
        </Card>

        <Card title="Проверить сертификат">
          <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
            Введите код с карты покупателя — увидите остаток и годность.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input value={checkCode} onChange={(e: any) => setCheckCode(e.target.value)} placeholder="12 цифр" />
            <Btn kind="ghost" onClick={check}>Проверить</Btn>
          </div>
          {checked && (
            <div style={{ marginTop: 12, fontSize: 14 }}>
              <div>Остаток: <b>{money(checked.balance)}</b> из {money(checked.nominal)}</div>
              <div style={{ marginTop: 4 }}>
                {checked.usable
                  ? <Badge tone="ok">можно использовать</Badge>
                  : <Badge tone="bad">{checked.status === 'expired' ? 'просрочен' : checked.status === 'used' ? 'использован' : 'недоступен'}</Badge>}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Все сертификаты" style={{ marginTop: 14 }}>
        <DataTable storageKey="certificates" exportName="certificates" empty="Сертификатов пока нет" cols={[
          { h: 'Код', k: 'code' },
          { h: 'Номинал', right: true, r: (r: any) => money(r.nominal) },
          { h: 'Остаток', right: true, r: (r: any) => money(r.balance) },
          { h: 'Действует до', r: (r: any) => r.validUntil ?? 'бессрочно' },
          { h: 'Кому', r: (r: any) => r.customerName ?? 'на предъявителя' },
          { h: 'Статус', r: (r: any) => {
              const t: any = { active: ['ok', 'активен'], used: ['dim', 'использован'], expired: ['bad', 'просрочен'], void: ['bad', 'аннулирован'] };
              const [tone, label] = t[r.status] ?? ['dim', r.status];
              return <Badge tone={tone}>{label}</Badge>;
            } },
        ]} rows={rows} />
      </Card>
    </>
  );
}
