'use client';
/**
 * РАЗДЕЛ 2: «КЛИЕНТЫ».
 *
 * Разметка и КЛАССЫ взяты из кабинета проекта автоматизации
 * ресторанов: grid tenants, badge st-*, btn small ghost, chips, cards,
 * toolbar, partner-strip. Оформление к ним лежит в style/admin.css —
 * их файл целиком, ни одна строка не переписана.
 *
 * Отличия от ресторана только там, где отличается дело:
 *   «заведение» → «магазин»;
 *   вместо экранов кухни и официантов — точки и кассы;
 *   выручка магазина вместо выручки заведения.
 * Всё остальное — их: цвета, размеры, поведение при наведении.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, money, fullDate, type Me } from '../lib';
import { RowMenu } from '../ui/RowMenu';
import { PayForm } from '../ui/PayForm';
import { AskForm } from '../ui/AskForm';
import { BulkPanel } from '../ui/BulkPanel';
import { InlineText } from '../ui/InlineText';
import { useAssign } from '../ui/useAssign';
import { useDeleteTenant } from '../ui/deleteTenant';
import { useAddDevice } from '../ui/addDevice';
import { statusView, STATUS_FILTERS, STATUS_FILTERS_PARTNER } from '../ui/status';
import { useAsk } from '../ui/Ask';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { Failed, SkeletonMetrics, SkeletonTable, Empty } from '../ui/States';

const SORTS = [
  { key: 'due',     label: 'Сначала просроченные' },
  { key: 'price',   label: 'Сначала дорогие' },
  { key: 'revenue', label: 'По выручке магазина' },
  { key: 'name',    label: 'По названию' },
];

export default function Clients({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('due');
  const [partner, setPartner] = useState('all');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [shown, setShown] = useState<{ title: string; value: string; note: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // Кнопка «Оплата» открывает окно отметки: партнёр получил деньги —
  // отмечает здесь, доступ продлевает владелец платформы.
  const [paying, setPaying] = useState<any>(null);
  // Партнёр не меняет деньги сам — он просит платформу. Их пункт
  // «Запросить у платформы» в меню строки.
  const [asking, setAsking] = useState<any>(null);

  const ask = useAsk();
  const toast = useToast();
  const assign = useAssign(() => { dropCache(); load(); });
  const del = useDeleteTenant(() => { dropCache(); load(); });
  const addDevice = useAddDevice(() => { dropCache(); load(); });

  const load = async (f = filter, s = sort, p = partner, search = q) => {
    const u = new URLSearchParams();
    if (f !== 'all') u.set('filter', f);
    if (s !== 'due') u.set('sort', s);
    if (p !== 'all') u.set('partnerId', p);
    if (search.trim()) u.set('q', search.trim());
    const path = '/clients?' + u.toString();

    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const d = await api(path);
      setData(d); putCache(path, d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  // Их состояния: скелетон показывает форму будущего содержимого.
  if (err && !data) return <Failed text={err} onRetry={() => load()} />;
  if (!data) return <><SkeletonMetrics count={5} /><SkeletonTable rows={6} cols={7} /></>;

  const st = data.stats;
  const c = data.counts;
  const isSuper = me.role === 'super';

  // Группировка по партнёру: ничьи первыми — это те, кем никто не
  // занимается, и они теряются первыми.
  const byPartner = new Map<string, any[]>();
  for (const r of data.rows) {
    const k = r.partnerId ?? '—';
    if (!byPartner.has(k)) byPartner.set(k, []);
    byPartner.get(k)!.push(r);
  }
  const groups = [...byPartner.entries()]
    .map(([k, rows]) => ({ key: k, title: k === '—' ? 'Ничьи' : rows[0].partner, rows }))
    .sort((a, b) => (a.key === '—' ? -1 : b.key === '—' ? 1 : 0));

  return (
    <>
      <div className="page-head">
        <div>
          <p className="muted">Все магазины платформы: состояние, срок оплаты и кто ведёт.</p>
        </div>
        {isSuper && (
          <div className="head-actions">
            <button className="btn" onClick={async () => {
              try { await api('/demo', { method: 'POST' }); dropCache(); await load(); }
              catch (e: any) { setErr(e.message); }
            }}>Учебный магазин</button>
            <button className="btn primary">+ Новый клиент</button>
          </div>
        )}
      </div>

      {/* Пять чисел — их блок cards с видами ok / warn / bad / money. */}
      <div className="cards">
        <div className="card"><span>Всего</span><b>{st.total}</b></div>
        <div className="card ok"><span>Работают</span><b>{st.active}</b></div>
        <div className="card warn"><span>Ждут подтверждения</span><b>{st.pendingPay}</b></div>
        <div className="card bad"><span>Срок вышел</span><b>{st.expired}</b></div>
        <div className="card money"><span>Доход в месяц</span><b>{money(st.mrr)}</b></div>
      </div>

      <div className="toolbar">
        <input className="search" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(filter, sort, partner, q); }}
          placeholder="Поиск: магазин, владелец, телефон, город, партнёр" />

        <select className="sorter" value={sort}
          onChange={(e) => { setSort(e.target.value); load(filter, e.target.value, partner, q); }}>
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>

        {isSuper && (
          <select className="sorter" value={partner}
            onChange={(e) => { setPartner(e.target.value); load(filter, sort, e.target.value, q); }}>
            <option value="all">Все партнёры</option>
            <option value="none">Ничьи · {c.nobody}</option>
            {data.partners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      <div className="chips">
        {/* Их порядок: от входящего потока к архиву. Партнёр не
            одобряет регистрации и не отключает — этих вкладок у него
            нет вовсе. */}
        {(isSuper ? STATUS_FILTERS : STATUS_FILTERS_PARTNER).map((t) => (
          <button key={t.value} className={`chip${filter === t.value ? ' on' : ''}`}
            onClick={() => { setFilter(t.value); load(t.value, sort, partner, q); }}>
            {t.label}{c[t.value] ? <b> {c[t.value]}</b> : null}
          </button>
        ))}
      </div>

      {/* Массовые действия: два шага всегда. Сперва сервер отвечает,
          кого затронет, потом применение — тем же листом, что и
          одиночное решение. Одинаковые действия выглядят одинаково. */}
      {isSuper && (
        <BulkPanel rows={data.rows} selected={selected}
          onClear={() => setSelected([])}
          onDone={() => { dropCache(); load(); }} />
      )}

      {asking && (
        <AskForm client={asking}
          onDone={(sent) => { setAsking(null); if (sent) dropCache(); }} />
      )}

      {paying && (
        <PayForm client={paying}
          onDone={(saved) => { setPaying(null); if (saved) { dropCache(); load(); } }} />
      )}

      {err && <div className="err">{err}</div>}

      {shown && (
        <div className="reveal" onClick={() => setShown(null)}>
          <div className="reveal-card">
            <span>{shown.title}</span>
            <b>{shown.value}</b>
            <i>{shown.note}</i>
          </div>
        </div>
      )}

      {data.rows.length === 0 ? (
        <Empty title="Никого не нашлось"
          text="Проверьте отбор или поиск. Телефон можно вводить как угодно: +7, 8 или без кода."
          actionLabel={filter !== 'all' || q ? 'Показать всех' : undefined}
          onAction={() => { setFilter('all'); setQ(''); load('all', sort, partner, ''); }} />
      ) : groups.map((g) => (
        <section key={g.key}>
          <div className="partner-strip">
            <span className={g.key === '—' ? 'nobody' : ''}>{g.title}</span>
            <span className="strip-money">· {g.rows.length}</span>
          </div>

          <table className="grid tenants">
            <thead>
              <tr>
                {isSuper && <th className="pick" />}
                <th>Магазин</th>
                <th>Владелец</th>
                <th>Статус</th>
                <th>Оплачено до</th>
                <th>Тариф</th>
                <th className="num">Выручка 30 дн.</th>
                <th>Партнёр</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r: any) => (
                <tr key={r.id}>
                  {isSuper && (
                    <td className="pick">
                      <input type="checkbox" checked={selected.includes(r.id)}
                        onChange={(e) => setSelected((p) => e.target.checked
                          ? [...p, r.id] : p.filter((x) => x !== r.id))} />
                    </td>
                  )}
                  <td>
                    {/* Правка на месте: опечатку в названии гонять
                        через лист подтверждения незачем — это не
                        деньги. Enter сохраняет, Esc возвращает, уход с
                        поля тоже сохраняет. */}
                    {/* Название — ССЫЛКА в карточку: по нему кликают
                        чаще всего. Правка на месте висела бы кражей
                        клика — человек хочет открыть карточку, а
                        попадает в поле. Поэтому правка отдельным
                        значком рядом. */}
                    <button className="link-name">{r.name}</button>
                    <InlineText value={r.name} label="название" placeholder="✎"
                      onSave={async (v) => {
                        try {
                          await api(`/clients/${r.id}`, { method: 'PATCH', body: { name: v } });
                          toast({ text: 'Название изменено' });
                          dropCache(); await load();
                        } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                      }} />
                    <div className="sub">
                      {r.city ?? '—'}
                      {r.stores > 1 ? ` · точек ${r.stores}` : ''}
                      {r.registers > 1 ? ` · касс ${r.registers}` : ''}
                      {r.isDemo ? ' · учебный' : ''}
                    </div>
                  </td>
                  <td>
                    {r.owner ?? '—'}
                    {r.ownerPhone && <div className="sub">
                      <a href={`tel:${r.ownerPhone}`}>{r.ownerPhone}</a>
                    </div>}
                  </td>
                  <td>
                    <span className={`badge ${statusView(r.state).cls}`}>
                      {statusView(r.state).text}
                    </span>
                    {/* Пояснение под плашкой: цвет несёт смысл, но
                        словами всё равно надо сказать. Их приём. */}
                    <div className="sub">
                      {r.pendingPayments > 0
                        ? `оплат: ${r.pendingPayments}`
                        : statusView(r.state).hint}
                    </div>
                  </td>
                  <td>
                    {r.paidUntil ? fullDate(r.paidUntil) : '—'}
                    {r.daysLeft != null && (
                      <div className="sub">
                        {r.daysLeft < 0
                          ? `просрочен ${Math.abs(r.daysLeft)} дн.`
                          : `осталось ${r.daysLeft} дн.`}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.tariff ?? '—'}
                    <div className="sub">{money(r.monthly)}/мес</div>
                  </td>
                  {/* Выручка магазина: отвечает, живёт ли клиент.
                      Продаж нет — продлевать не будет. */}
                  <td className="num">{money(r.revenue30d)}</td>
                  <td>{r.partner ?? <span className="nobody">без партнёра</span>}</td>
                  <td className="actions">
                    <button className="btn small accent"
                      onClick={() => setPaying(r)}>Оплата</button>
                    <button className="btn small">Карточка</button>

                    {/* Меню строки: в строке два действия каждого дня,
                        остальное здесь. Шесть целей по 32 px в правой
                        колонке — это панель управления, размноженная на
                        каждого клиента. Их довод. */}
                    <RowMenu actions={[
                      { label: 'Код для кассы',
                        hint: 'одноразовый, живёт 30 минут',
                        onClick: async () => {
                          try {
                            const x = await api(`/clients/${r.id}/activation`);
                            setShown({ title: 'Код для кассы', value: x.code, note: x.note });
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        } },

                      { label: 'Новый пароль владельцу',
                        hint: 'показан один раз — продиктуйте',
                        onClick: async () => {
                          try {
                            const x = await api(`/clients/${r.id}/reset-password`,
                              { method: 'POST', body: { tenantId: r.id } });
                            setShown({ title: 'Новый пароль владельцу',
                                       value: x.password, note: x.note });
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        } },

                      // Партнёру — «Запросить у платформы»: сам он
                      // деньги не меняет. Владельцу этот пункт не
                      // нужен, он решает напрямую.
                      ...(!isSuper ? [{
                        label: 'Запросить у платформы…',
                        hint: 'устройство, тариф или отсрочку',
                        onClick: () => setAsking(r),
                      }] : []),

                      ...(isSuper ? [{ label: 'Добавить устройство…',
                        hint: 'касса или точка, с доплатой',
                        onClick: () => addDevice(r) }] : []),

                      ...(isSuper ? [{
                        label: r.partner ? 'Передать другому партнёру…' : 'Назначить партнёра…',
                        hint: 'доля считается с будущих оплат',
                        onClick: () => assign(r, data.partners),
                      }] : []),

                      ...(isSuper ? [{
                        label: r.state === 'suspended' ? 'Включить магазин' : 'Отключить магазин',
                        hint: r.state === 'suspended'
                          ? 'продажи снова откроются'
                          : 'продажи закроются, кабинет останется',
                        danger: r.state !== 'suspended',
                        onClick: async () => {
                          const on = r.state === 'suspended';
                          const ok = await ask({
                            title: on ? `Включить «${r.name}»` : `Отключить «${r.name}»`,
                            effects: [
                              ['Магазин', r.name],
                              ['Продажи', on ? 'откроются' : 'закроются'],
                              ['Кабинет владельца', 'останется открытым'],
                            ],
                            danger: !on,
                            confirmLabel: on ? 'Включить' : 'Отключить',
                          });
                          if (!ok) return;
                          try {
                            await api(`/clients/${r.id}/status`,
                              { method: 'POST', body: { active: on } });
                            toast({ text: on ? `«${r.name}» включён` : `«${r.name}» отключён` });
                            dropCache(); await load();
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        },
                      }] : []),

                      ...(isSuper ? [{
                        label: 'Удалить магазин…',
                        hint: 'две ступени, набор названия',
                        danger: true,
                        onClick: () => del(r),
                      }] : []),
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
