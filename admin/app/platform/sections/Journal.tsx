'use client';
/**
 * РАЗДЕЛ 8: «ЖУРНАЛ» — кто что сделал.
 *
 * Записи приходят описанными словами: сервер знает, что значит
 * «payment_approved», и переводит один раз. Кабинет только показывает.
 *
 * Денежные записи помечены: цена ошибки в них другая. Листание —
 * курсором по времени, а не номерами страниц: журнал растёт, и номера
 * съезжают.
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, ErrLine, EmptyState } from '../../../lib/ui';
import { api, money, dateTime, type Me } from '../lib';

const WEIGHT = [
  { key: 'all',    label: 'Все' },
  { key: 'money',  label: 'Деньги' },
  { key: 'access', label: 'Доступ' },
  { key: 'other',  label: 'Прочее' },
];

export default function Journal({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [weight, setWeight] = useState('all');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (w = weight, before?: string) => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ limit: '30' });
      if (w !== 'all') p.set('weight', w);
      if (before) p.set('before', before);
      const d = await api('/audit?' + p.toString());
      setRows(before ? [...rows, ...d.rows] : d.rows);
      setNext(d.nextBefore); setHasMore(d.hasMore); setErr('');
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const tone = (w: string) => w === 'money' ? C.accent : w === 'access' ? C.red : C.line;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {err && <ErrLine err={err} />}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {WEIGHT.map((w) => (
          <button key={w.key}
            onClick={() => { setWeight(w.key); setRows([]); load(w.key); }}
            style={{
              minHeight: 38, padding: '0 14px', borderRadius: 10, fontSize: 14, cursor: 'pointer',
              border: `1px solid ${weight === w.key ? C.accent : C.line}`,
              background: weight === w.key ? C.accent : C.card,
              color: weight === w.key ? '#fff' : C.text,
            }}>{w.label}</button>
        ))}
      </div>

      {rows.length === 0 && !loading
        ? <EmptyState text="Записей нет. При этом отборе ничего не нашлось." />
        : (
          <Card>
            <div style={{ display: 'grid', gap: 2 }}>
              {rows.map((r: any) => (
                <div key={r.id} style={{
                  display: 'flex', gap: 12, padding: '9px 0', alignItems: 'baseline',
                  borderBottom: `1px solid ${C.line}`, fontSize: 14, flexWrap: 'wrap',
                }}>
                  <span style={{
                    width: 3, alignSelf: 'stretch', background: tone(r.weight),
                    borderRadius: 2, flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 13, color: C.dim, minWidth: 100,
                    fontVariantNumeric: 'tabular-nums' }}>{dateTime(r.at)}</span>
                  <span style={{ fontWeight: r.weight === 'money' ? 600 : 400 }}>{r.title}</span>
                  {r.client && <span style={{ color: C.dim }}>· {r.client}</span>}
                  {r.detail && <span style={{ color: C.dim, fontSize: 13 }}>· {r.detail}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: C.dim }}>{r.actor}</span>
                  {r.amount != null && (
                    <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {money(r.amount)}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {hasMore && (
              <Btn onClick={() => load(weight, next ?? undefined)} disabled={loading}
                style={{ marginTop: 12 }}>
                {loading ? 'Загрузка…' : 'Показать ещё'}
              </Btn>
            )}
          </Card>
        )}
    </div>
  );
}
