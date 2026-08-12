'use client';
/**
 * Лояльность: бонусные программы и их отдача. Модель Wipon Cashback:
 * процент с покупки — на бонусный счёт, тратится при следующих визитах.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Btn, Input, Field, Stat, money, num, today, monthAgo, C, ErrLine, Badge } from '../../../lib/ui';

export default function LoyaltyPage() {
  const [programs, setPrograms] = useState<any[]>([]);
  const [an, setAn] = useState<any>(null);
  const [form, setForm] = useState<any>({ earnPercent: 3 });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      setPrograms(await api('/loyalty/programs'));
      setAn(await api(`/loyalty/analytics?from=${monthAgo()}&to=${today()}`));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    setErr(''); setMsg('');
    try {
      await api('/loyalty/programs', { method: 'POST', body: JSON.stringify({
        name: form.name, earnPercent: +form.earnPercent,
        maxSpendPercent: form.maxSpendPercent ? +form.maxSpendPercent : undefined,
        expiryDays: form.expiryDays ? +form.expiryDays : undefined,
      }) });
      setMsg(`Программа «${form.name}» запущена`); setForm({ earnPercent: 3 }); load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Лояльность</h1>
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      {an && (
        <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
          <Stat label="Участников" value={num(an.members ?? an.customers ?? 0)} />
          <Stat label="Начислено бонусов" value={money(an.earned)} sub="за 30 дней" />
          <Stat label="Потрачено бонусов" value={money(an.spent)} sub="за 30 дней" />
          <Stat label="Выручка участников" value={money(an.memberRevenue ?? an.revenue)} />
        </div>
      )}

      <Card title="Новая бонусная программа" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Название"><Input value={form.name ?? ''} w={200} placeholder="Например: Базовый кешбэк" onChange={(e: any) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Начисление, %"><Input type="number" value={form.earnPercent} w={90} onChange={(e: any) => setForm({ ...form, earnPercent: e.target.value })} /></Field>
          <Field label="Оплата бонусами до, %"><Input type="number" value={form.maxSpendPercent ?? ''} w={90} placeholder="50" onChange={(e: any) => setForm({ ...form, maxSpendPercent: e.target.value })} /></Field>
          <Field label="Сгорают через, дней"><Input type="number" value={form.expiryDays ?? ''} w={90} placeholder="180" onChange={(e: any) => setForm({ ...form, expiryDays: e.target.value })} /></Field>
          <Btn onClick={create} disabled={!form.name}>Запустить</Btn>
        </div>
      </Card>

      <Card title="Программы" style={{ marginTop: 14 }}>
        <DataTable storageKey="loyalty" exportName="loyalty" empty="Программ пока нет — запустите первую, касса подхватит её сама"
          cols={[
            { h: 'Название', k: 'name' },
            { h: 'Начисление', right: true, r: (r) => `${num(r.earn_percent ?? r.earnPercent)}%` },
            { h: 'Оплата бонусами до', right: true, r: (r) => r.max_spend_percent != null ? `${num(r.max_spend_percent)}%` : '—' },
            { h: 'Срок бонусов', right: true, r: (r) => r.expiry_days ? `${r.expiry_days} дн.` : 'бессрочно' },
            { h: 'Статус', r: (r) => r.is_active !== false ? <Badge tone="ok">активна</Badge> : <Badge tone="dim">выключена</Badge> },
          ]}
          rows={programs} />
      </Card>
    </>
  );
}
