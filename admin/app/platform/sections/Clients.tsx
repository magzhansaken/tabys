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
import { api, cached, putCache, dropCache, money, fullDate, type Me , daysWord} from '../lib';
import { RowMenu } from '../ui/RowMenu';
import { PayForm } from '../ui/PayForm';
import { AskForm } from '../ui/AskForm';
import { NewTenant } from '../ui/NewTenant';
import { PlanLines } from '../ui/PlanLines';
import { NewPassword, CopyValue, Credentials } from '../ui/access';
import { InlineText } from '../ui/InlineText';
import { useAssign } from '../ui/useAssign';
import { useDeleteTenant } from '../ui/deleteTenant';
import { useAddDevice } from '../ui/addDevice';
import { statusView, STATUS_FILTERS, STATUS_FILTERS_PARTNER } from '../ui/status';
import { useAsk } from '../ui/Ask';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { useLive } from '../ui/useLive';
import { Failed, SkeletonMetrics, SkeletonTable, Empty , PageHead } from '../ui/States';

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
  // Показать только отмеченные: набрал тридцать строк по всему списку
  // и хочешь убедиться, что набрал именно те. Их приём.
  const [onlySel, setOnlySel] = useState(false);
  // Кнопка «Оплата» открывает окно отметки: партнёр получил деньги —
  // отмечает здесь, доступ продлевает владелец платформы.
  const [paying, setPaying] = useState<any>(null);
  const [newPass, setNewPass] = useState<any>(null);
  // Доступы после заведения: показываются один раз, дальше партнёр
  // будет искать их заново, стоя в магазине.
  const [creds, setCreds] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [billFor, setBillFor] = useState<any>(null);

  const goClient = (id: string) => { window.location.hash = `#/client/${id}`; };
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

  // Обновляем сами: панель держат открытой весь день, и
  // отмеченная партнёром оплата должна появиться без нажатий.
  useLive(() => load(), 30_000);

  // Их состояния: скелетон показывает форму будущего содержимого.
  if (err && !data) return <Failed text={err} onRetry={() => load()} />;
  if (!data) return <><SkeletonMetrics count={5} /><SkeletonTable rows={6} cols={7} /></>;

  const st = data.stats;
  const c = data.counts;
  const isSuper = me.role === 'super';

  // Группировка по партнёру: ничьи первыми — это те, кем никто не
  // занимается, и они теряются первыми.
  const byPartner = new Map<string, any[]>();
  const visible = onlySel ? data.rows.filter((r: any) => selected.includes(r.id)) : data.rows;
  for (const r of visible) {
    const k = r.partnerId ?? '—';
    if (!byPartner.has(k)) byPartner.set(k, []);
    byPartner.get(k)!.push(r);
  }
  const groups = [...byPartner.entries()]
    .map(([k, rows]) => ({ key: k, title: k === '—' ? 'Ничьи' : rows[0].partner, rows }))
    .sort((a, b) => (a.key === '—' ? -1 : b.key === '—' ? 1 : 0));

  return (
    <>
      <PageHead title={isSuper ? 'Клиенты' : 'Мои клиенты'} sub={'Все магазины платформы: состояние, срок оплаты и кто ведёт.'} />

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
            <button className="btn primary"
              onClick={() => setCreating(true)}>+ Новый клиент</button>
          </div>
        )}
      </div>

      {/* Пять чисел — их блок cards с видами ok / warn / bad / money. */}
      <div className="cards">
        <div className="card"><span>Всего</span><b>{st.total}</b></div>
        {/* «Работают» — могут продавать: срок не вышел. Сюда входят и
            пробные, которые ещё не платили. В сводке рядом стоит
            «Платят» — там их нет, и без подписи человек решит, что
            одна из цифр врёт. */}
        <div className="card ok">
          <span>Работают</span><b>{st.active}</b>
          <i>срок не вышел, включая пробных</i>
        </div>
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

      {/* Отмеченные строки применяются в «Настройках»: сами массовые
          действия живут там, а не среди ежедневной работы. Их довод:
          самая опасная возможность платформы не должна стоять между
          графиком и таблицей, где на неё нажимают походя. */}
      {isSuper && selected.length > 0 && (
        <div className="picked-bar">
          <span>Отмечено {selected.length}</span>
          <div className="picked-controls">
            <button className="btn small ghost"
              onClick={() => setOnlySel((v) => !v)}>
              {onlySel ? 'Показать всех' : 'Только отмеченные'}
            </button>
            <button className="btn small ghost"
              onClick={() => { setSelected([]); setOnlySel(false); }}>Снять</button>
            <span className="hint">
              Массовые действия — во вкладке «Настройки»
            </span>
          </div>
        </div>
      )}

      {creating && (
        <NewTenant isSuper={isSuper} partners={data.partners}
          onDone={(made) => { setCreating(false); if (made) { dropCache(); load(); } }} />
      )}

      {creds && <Credentials rows={creds} onClose={() => setCreds(null)} />}

      {newPass && (
        <NewPassword phone={newPass.phone} password={newPass.password}
          onClose={() => setNewPass(null)} />
      )}

      {/* Состав счёта: тариф это не одно число, а строки — основа,
          доплаты, скидки. Каждую назначает владелец платформы. */}
      {billFor && (
        <div className="modal"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setBillFor(null); }}>
          <div className="modal-card wide">
            <div className="sheet-head">
              <h2>Счёт · {billFor.name}</h2>
              <button className="btn small ghost sheet-x" aria-label="Закрыть"
                onClick={() => setBillFor(null)}>×</button>
            </div>
            <PlanLines accountId={billFor.id} lines={billFor.lines}
              monthly={billFor.monthly}
              onChanged={async () => {
                dropCache();
                const card = await api(`/clients/${billFor.id}/card`);
                setBillFor({ ...card, id: billFor.id });
                load();
              }} />
          </div>
        </div>
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

      {visible.length === 0 ? (
        <Empty title="Никого не нашлось"
          text="Проверьте отбор или поиск. Телефон можно вводить как угодно: +7, 8 или без кода."
          actionLabel={filter !== 'all' || q ? 'Показать всех' : undefined}
          onAction={() => { setFilter('all'); setQ(''); load('all', sort, partner, ''); }} />
      ) : groups.map((g) => (
        <section key={g.key}>
          <div className="partner-strip">
            <span className={g.key === '—' ? 'nobody' : ''}>{g.title}</span>
            {/* Сколько приносит эта группа: полоса с одним именем —
                это подпись, а с суммой — уже довод. Их приём. */}
            <span className="strip-money">
              {g.rows.length} · приносит в месяц{' '}
              <i>{money(g.rows.reduce((a: number, r: any) => a + r.monthly, 0))}</i>
            </span>
            {partner !== 'all' && (
              <button className="btn small ghost"
                onClick={() => { setPartner('all'); load(filter, sort, 'all', q); }}>
                Сбросить
              </button>
            )}
          </div>

          <table className="grid tenants">
            <thead>
              <tr>
                {isSuper && (
                  <th className="pick">
                    {/* Отметить всех разом: отмечать тридцать строк по
                        одной — это не работа, а наказание. Их приём. */}
                    <input type="checkbox"
                      checked={g.rows.length > 0 && g.rows.every((r: any) => selected.includes(r.id))}
                      onChange={(e) => setSelected((prev) => e.target.checked
                        ? Array.from(new Set([...prev, ...g.rows.map((r: any) => r.id)]))
                        : prev.filter((id) => !g.rows.some((r: any) => r.id === id)))} />
                  </th>
                )}
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
                  <td data-label="Магазин">
                    {/* Правка на месте: опечатку в названии гонять
                        через лист подтверждения незачем — это не
                        деньги. Enter сохраняет, Esc возвращает, уход с
                        поля тоже сохраняет. */}
                    {/* Название — ССЫЛКА в карточку: по нему кликают
                        чаще всего. Правка на месте висела бы кражей
                        клика — человек хочет открыть карточку, а
                        попадает в поле. Поэтому правка отдельным
                        значком рядом. */}
                    <button className="link-name" onClick={() => goClient(r.id)}>{r.name}</button>
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
                  <td data-label="Владелец">
                    {r.owner ?? '—'}
                    {r.ownerPhone && <div className="sub">
                      <a href={`tel:${r.ownerPhone}`}>{r.ownerPhone}</a>
                    </div>}
                  </td>
                  <td data-label="Статус">
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
                  <td data-label="Оплачено до">
                    {r.paidUntil ? fullDate(r.paidUntil) : '—'}
                    {r.daysLeft != null && (
                      <div className="sub">
                        {/* Склонение, а не «дн.»: «осталось 0 дн.» — это
                            «сегодня», а «1 дн.» никто не говорит. */}
                        {r.daysLeft < 0
                          ? `просрочен: ${daysWord(r.daysLeft)}`
                          : daysWord(r.daysLeft)}
                      </div>
                    )}
                  </td>
                  <td data-label="Тариф">
                    {r.tariff ?? '—'}
                    <div className="sub">{money(r.monthly)}/мес</div>
                  </td>
                  {/* Выручка магазина: отвечает, живёт ли клиент.
                      Продаж нет — продлевать не будет. */}
                  <td className="num" data-label="Выручка 30 дн.">{money(r.revenue30d)}</td>
                  <td data-label="Партнёр">{r.partner ?? <span className="nobody">без партнёра</span>}</td>
                  <td className="actions">
                    {/* У самозаписавшихся вместо «Оплаты» — решение.
                        Их приём: пока клиента не одобрили, платить ему
                        не за что, и кнопка оплаты там бессмысленна. */}
                    {r.state === 'approval' && isSuper ? (
                      <>
                        <button className="btn small accent" onClick={async () => {
                          const ok = await ask({
                            title: `Одобрить «${r.name}»`,
                            sub: 'Клиент получит пробный период и сможет работать.',
                            effects: [
                              ['Магазин', r.name],
                              ['Владелец', r.owner ?? '—'],
                              ['Пробный период', '14 дней'],
                            ],
                            confirmLabel: 'Одобрить',
                          });
                          if (!ok) return;
                          try {
                            await api(`/signups/${r.id}/approve`,
                              { method: 'POST', body: { trialDays: 14 } });
                            toast({ text: `«${r.name}»: доступ открыт на 14 дней` });
                            dropCache(); await load();
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        }}>Одобрить</button>

                        <button className="btn small danger" onClick={async () => {
                          const ok = await ask({
                            title: `Отклонить «${r.name}»`,
                            sub: 'Владелец увидит причину — напишите так, чтобы было понятно.',
                            effects: [['Магазин', r.name], ['Телефон', r.phone ?? '—']],
                            reason: { label: 'Причина отказа', required: true,
                                      placeholder: 'Не наш профиль' },
                            danger: true,
                            confirmLabel: 'Отклонить',
                          });
                          if (!ok) return;
                          try {
                            await api(`/signups/${r.id}/reject`,
                              { method: 'POST', body: { reason: ok.reason } });
                            toast({ text: `«${r.name}»: отклонено` });
                            dropCache(); await load();
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        }}>Отклонить</button>
                      </>
                    ) : (
                      <button className="btn small accent"
                        onClick={() => setPaying(r)}>Оплата</button>
                    )}
                    <button className="btn small" onClick={() => goClient(r.id)}>Карточка</button>

                    {/* Меню строки: в строке два действия каждого дня,
                        остальное здесь. Шесть целей по 32 px в правой
                        колонке — это панель управления, размноженная на
                        каждого клиента. Их довод. */}
                    <RowMenu actions={[
                      { label: 'Состав счёта…',
                        hint: 'основа, доплаты, скидки',
                        onClick: async () => {
                          try {
                            const card = await api(`/clients/${r.id}/card`);
                            setBillFor({ ...card, id: r.id });
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        } },

                      { label: 'Код для кассы',
                        hint: 'одноразовый, живёт 30 минут',
                        onClick: async () => {
                          try {
                            const x = await api(`/clients/${r.id}/activation`);
                            setShown({ title: 'Код для кассы', value: x.code, note: x.note });
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        } },

                      { label: 'Новый пароль',
                        hint: 'показан один раз — продиктуйте',
                        onClick: async () => {
                          try {
                            const x = await api('/reset-owner-password',
                              { method: 'POST', body: { tenantId: r.id } });
                            // Их окно: пароль и вход копируются одной
                            // кнопкой — диктовать два поля подряд
                            // значит один раз ошибиться.
                            setNewPass({ phone: r.ownerPhone ?? r.phone, password: x.password });
                          } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                        } },

                      // Партнёру — «Запросить у платформы»: сам он
                      // деньги не меняет. Владельцу этот пункт не
                      // нужен, он решает напрямую.
                      ...(!isSuper ? [{
                        label: 'Запросить…',
                        hint: 'устройство, тариф или отсрочку',
                        onClick: () => setAsking(r),
                      }] : []),

                      ...(isSuper ? [{ label: 'Добавить кассу…',
                        hint: 'касса или точка, с доплатой',
                        onClick: () => addDevice(r) }] : []),

                      ...(isSuper ? [{
                        label: r.partner ? 'Сменить партнёра…' : 'Назначить партнёра…',
                        hint: 'доля считается с будущих оплат',
                        onClick: () => assign(r, data.partners),
                      }] : []),

                      ...(isSuper ? [{
                        label: r.state === 'suspended' ? 'Включить' : 'Отключить',
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
                        label: 'Удалить…',
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

      {/* «Показано N из M» — их подпись. При отборе видно, что список
          неполный: иначе человек решает по части данных, думая, что
          видит всё. */}
      {data.rows.length > 0 && data.rows.length < c.all && (
        <p className="table-foot">Показано {data.rows.length} из {c.all}</p>
      )}
    </>
  );
}
