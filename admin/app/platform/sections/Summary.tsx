'use client';
/**
 * РАЗДЕЛ 7: «СВОДКА» — где мы сейчас и куда движемся.
 *
 * Цифра без сравнения ничего не значит: «пришло 140 тысяч» — это много
 * или мало? Рядом с каждым числом за период стоит прошлый такой же.
 *
 * График простой, без библиотек: столбики на голом CSS. Библиотека
 * ради одного графика — это лишние сотни килобайт на страницу, которую
 * открывают с телефона в дороге.
 */
import { useEffect, useState } from 'react';
import { C, Card, ErrLine } from '../../../lib/ui';
import { P, api, cached, putCache, dropCache, money, shortDate, type Me } from '../lib';

export default function Summary({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState('');

  const load = async (d = days) => {
    const path = `/metrics?days=${d}`;
    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const r = await api(path);
      setData(r); putCache(path, r); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <ErrLine err={err} />;
  if (!data) return <div style={{ color: P.dim, padding: 20 }}>Загрузка…</div>;

  const max = Math.max(1, ...data.series.map((d: any) => d.amount));
  const ch = data.change;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {err && <ErrLine err={err} />}

      <div style={{ display: 'flex', gap: 6 }}>
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => { setDays(d); load(d); }}
            style={{
              minHeight: 38, padding: '0 14px', borderRadius: 10, fontSize: 14, cursor: 'pointer',
              border: `1px solid ${days === d ? P.accent : P.line}`,
              background: days === d ? P.accent : P.card,
              color: days === d ? '#fff' : P.ink,
            }}>{d} дней</button>
        ))}
      </div>

      <Card title="Сейчас">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Big title="Клиентов" value={String(data.now.tenants)} />
          <Big title="Работают" value={String(data.now.active)} />
          <Big title="Просрочены" value={String(data.now.expired)}
            tone={data.now.expired > 0 ? P.danger : undefined} />
          <Big title="Доход в месяц" value={money(data.now.mrr)} big />
        </div>
        {data.note && (
          <div style={{ fontSize: 13, color: P.accentSoft, marginTop: 10 }}>{data.note}</div>
        )}
      </Card>

      <Card title={`За ${data.days} дней`}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Big title="Пришло" value={money(data.period.amount)} big />
          <Big title="Оплат" value={String(data.period.payments)} />
          <Big title="Партнёрам" value={money(data.period.partnerShare)} />
          <Big title="Платформе" value={money(data.period.platformShare)} />
        </div>

        {/* Сравнение с прошлым периодом: направление важнее величины.
            140 тысяч при падении на треть — плохая новость. */}
        <div style={{ fontSize: 14, marginTop: 10,
          color: ch.amount >= 0 ? P.accent : P.danger }}>
          {ch.amount >= 0 ? '↑' : '↓'} {money(Math.abs(ch.amount))}
          {ch.percent != null && ` (${ch.percent > 0 ? '+' : ''}${ch.percent}%)`}
          {' '}к прошлым {data.days} дням
          <span style={{ color: P.dim }}> · было {money(ch.prevAmount)}</span>
        </div>
      </Card>

      <Card title="По дням">
        {/* Столбики на голом CSS: библиотека ради одного графика — это
            лишние сотни килобайт на странице, которую открывают с
            телефона в дороге. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 140,
          borderBottom: `1px solid ${P.line}`, paddingBottom: 2 }}>
          {data.series.map((d: any) => (
            <div key={d.day} title={`${shortDate(d.day)}: ${money(d.amount)}`}
              style={{
                flex: 1, minWidth: 3,
                height: `${Math.max(2, (d.amount / max) * 100)}%`,
                background: d.amount > 0 ? P.accent : P.line,
                borderRadius: '3px 3px 0 0',
              }} />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between',
          fontSize: 12, color: P.dim, marginTop: 6 }}>
          <span>{shortDate(data.series[0]?.day)}</span>
          <span>{shortDate(data.series[data.series.length - 1]?.day)}</span>
        </div>
      </Card>
    </div>
  );
}

function Big({ title, value, big, tone }: {
  title: string; value: string; big?: boolean; tone?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 13, color: P.dim }}>{title}</div>
      <div style={{ fontSize: big ? 28 : 22, fontWeight: 600, color: tone ?? P.ink,
        fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
