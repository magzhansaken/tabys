'use client';
/**
 * РАЗДЕЛ 5: «ВОРОНКА» — от знакомства до оплаты.
 *
 * Этап выводится из фактов, пока его не двигали руками. Ручной сдвиг
 * сильнее: человек знает о клиенте больше, чем база. Кабинет
 * показывает, какой этап откуда взялся — это разные вещи.
 *
 * Дни молчания — главный столбец: сделка умирает не от отказа, а от
 * того, что о ней забыли.
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, Input, ErrLine, EmptyState } from '../../../lib/ui';
import { P, api, cached, putCache, dropCache, money, daysWord, type Me } from '../lib';

export default function Funnel({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = async (silent = false) => {
    // Показываем известное сразу, свежее подъезжает в фоне: пустой
    // экран при каждом входе ощущался как «всё тормозит», хотя сервер
    // отвечает за 10-20 миллисекунд.
    const hit = cached('/funnel');
    if (hit && !silent) setData(hit.data);
    try {
      const d = await api('/funnel');
      setData(d); putCache('/funnel', d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <ErrLine err={err} />;
  if (!data) return <div style={{ color: P.dim, padding: 20 }}>Загрузка…</div>;
  if (data.total === 0) return <EmptyState text="Воронка пуста. Клиентов пока нет." />;

  const move = async (id: string, stage: string) => {
    try {
      await api(`/funnel/${id}`, { method: 'POST', body: { stage, note: note || undefined } });
      setMoving(null); setNote(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {err && <ErrLine err={err} />}

      <div style={{ display: 'grid', gap: 14,
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {data.stages.map((st: any) => (
          <Card key={st.key} title={`${st.title} · ${st.count}`}>
            <div style={{ fontSize: 13, color: P.dim, marginTop: -4, marginBottom: 4 }}>{st.hint}</div>
            {/* Сумма на этапе: воронка про деньги, а не про карточки. */}
            {st.sum > 0 && (
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10,
                fontVariantNumeric: 'tabular-nums' }}>{money(st.sum)}/мес</div>
            )}

            <div style={{ display: 'grid', gap: 8 }}>
              {st.cards.map((c: any) => (
                <div key={c.id} style={{
                  border: `1px solid ${c.cold ? P.accentSoft : P.line}`,
                  borderRadius: 10, padding: 10, fontSize: 14,
                }}>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <div style={{ color: P.dim, fontSize: 13 }}>
                    {c.city}{c.owner ? ` · ${c.owner}` : ''}
                  </div>
                  {c.ownerPhone && (
                    <a href={`tel:${c.ownerPhone}`}
                      style={{ color: P.accent, fontSize: 13, textDecoration: 'none' }}>
                      {c.ownerPhone}
                    </a>
                  )}

                  {/* Молчание — главный признак умирающей сделки. */}
                  {c.daysSilent != null && (
                    <div style={{ fontSize: 13, marginTop: 4,
                      color: c.cold ? P.accentSoft : P.dim }}>
                      молчим {c.daysSilent} дн.
                    </div>
                  )}
                  {c.note && (
                    <div style={{ fontSize: 13, fontStyle: 'italic', marginTop: 4 }}>«{c.note}»</div>
                  )}

                  {/* Откуда взялся этап: выведен из фактов или поставлен
                      руками. Это разные вещи, и путать их нельзя. */}
                  <div style={{ fontSize: 12, color: P.dim, marginTop: 4 }}>
                    {c.isManual ? 'этап поставлен вручную' : 'этап выведен из фактов'}
                  </div>

                  {moving === c.id ? (
                    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                      <Input value={note} onChange={(e: any) => setNote(e.target.value)}
                        placeholder="Заметка: о чём договорились" autoFocus />
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {data.stages.filter((x: any) => x.key !== st.key).map((x: any) => (
                          <Btn key={x.key} onClick={() => move(c.id, x.key)}>{x.title}</Btn>
                        ))}
                        <Btn onClick={() => { setMoving(null); setNote(''); }}>Отмена</Btn>
                      </div>
                    </div>
                  ) : (
                    <Btn onClick={() => { setMoving(c.id); setNote(c.note ?? ''); }}
                      style={{ marginTop: 8 }}>Сдвинуть</Btn>
                  )}
                </div>
              ))}
              {st.cards.length === 0 && (
                <div style={{ fontSize: 13, color: P.dim }}>пусто</div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
