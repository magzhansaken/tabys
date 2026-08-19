'use client';
/**
 * РАЗДЕЛ 6: «ПАРТНЁРЫ».
 *
 * Разметка из их main.tsx: grid partners, cards, toolbar, btn primary,
 * sub, num, badge st-*.
 *
 * Их столбцы: Имя, Почта, Клиентов, Доля партнёра, Заработал 30 дн.,
 * Был в системе. Добавлено сверх них: ПРИВЁЛ ДЕНЕГ — это другое число,
 * и оно важнее заработка: партнёр с малой комиссией может приносить
 * платформе больше.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, money, dateTime, type Me } from '../lib';
import { RowMenu } from '../ui/RowMenu';
import { InlineText } from '../ui/InlineText';
import { useAsk } from '../ui/Ask';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { Failed, SkeletonMetrics, SkeletonTable, Empty , PageHead } from '../ui/States';

export default function Partners({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', commissionPercent: 15 });
  const [shown, setShown] = useState<{ title: string; value: string; note: string } | null>(null);
  const load = async () => {
    const hit = cached('/partners');
    if (hit) setData(hit.data);
    try {
      const d = await api('/partners');
      setData(d); putCache('/partners', d); setErr('');
    } catch (e: any) { if (!hit) setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, []);

  const ask = useAsk();
  const toast = useToast();

  const save = async (id: string, body: any, ok: string) => {
    try {
      await api(`/partners/${id}`, { method: 'PATCH', body });
      toast({ text: ok });
      dropCache(); await load();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  /**
   * Правка доли. Последствие пересчитывается ПРИ ВВОДЕ: набираешь
   * процент — сразу видно, сколько останется вам. Их приём.
   */
  const editShare = async (p: any) => {
    const now = p.commissionPercent;
    const r = await ask({
      title: `Доля партнёра · ${p.name}`,
      value: { label: 'Доля партнёра, %', initial: String(now), numeric: true },
      effects: (d) => {
        const next = Number(d.value);
        const ok = Number.isFinite(next) && next >= 0 && next <= 100;
        return [
          ['Партнёр', p.name],
          ['Сейчас', `${now}% · вам ${100 - now}%`],
          ['Станет', ok ? `${next}% · вам ${100 - next}%` : '— · допустимо от 0 до 100'],
          ['Уже подтверждённые оплаты', 'хранят свою долю'],
          ['Заработал за 30 дн.', money(p.earned)],
        ];
      },
      confirmLabel: 'Изменить долю',
    });
    if (!r) return;
    const next = Number(r.value);
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      toast({ text: 'Доля партнёра — от 0 до 100%', kind: 'err' }); return;
    }
    await save(p.id, { commissionPercent: next }, `Доля «${p.name}» — ${next}%`);
  };

  /** Смена пароля партнёру. Показан один раз — передайте лично. */
  const changePassword = async (p: any) => {
    const r = await ask({
      title: `Новый пароль · ${p.name}`,
      sub: 'Старый пароль перестанет работать сразу. Передайте новый лично — '
         + 'показан он будет один раз.',
      effects: [['Партнёр', p.name], ['Вход', p.email]],
      value: { label: 'Новый пароль', hint: 'не короче восьми знаков' },
      confirmLabel: 'Сменить пароль',
    });
    if (!r) return;
    if (r.value.length < 8) { toast({ text: 'Пароль короче восьми знаков — не сохранил', kind: 'err' }); return; }
    try {
      await api(`/partners/${p.id}`, { method: 'PATCH', body: { password: r.value } });
      setShown({ title: 'Новый пароль партнёра', value: r.value,
                 note: 'Показан один раз — передайте лично. В базе хранится отпечатком.' });
      dropCache(); await load();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  /**
   * Отключить или включить партнёра. СПРАШИВАЕМ В ОБА КОНЦА, как у
   * них: включение тоже меняет положение дел — человек снова получает
   * доступ к деньгам клиентов, и нажать это мимо тоже можно.
   */
  const toggle = async (p: any) => {
    const off = p.isActive;

    const r = await ask({
      title: off ? `Отключить «${p.name}»` : `Включить «${p.name}»`,
      sub: off
        ? 'Партнёр перестанет входить в панель. Его клиенты продолжат работать и платить — вести их будете вы.'
        : 'Партнёр снова сможет вести своих клиентов и отмечать оплаты.',
      // Четыре строки, как у них. Заработок здесь не случайно: решая
      // про отключение, надо видеть, сколько человек принёс.
      effects: [
        ['Партнёр', p.name],
        ['Клиентов', `${p.activeClients} из ${p.clients}`],
        ['Заработал за 30 дн.', money(p.earned)],
        ['Доля', `${p.commissionPercent}%`],
        ['Его клиенты дают', `${money(p.mrr)}/мес`],
      ],
      danger: off,
      confirmLabel: off ? 'Отключить' : 'Включить',
    });
    if (!r) return;
    await save(p.id, { isActive: !off },
      off ? `«${p.name}» отключён` : `«${p.name}» включён`);
  };

  if (err && !data) return <Failed text={err} onRetry={load} />;
  if (!data) return <><SkeletonMetrics count={3} /><SkeletonTable rows={4} cols={7} /></>;

  return (
    <>
      <PageHead title={'Партнёры'} sub={'Партнёр заводит и настраивает своих клиентов, отмечает оплаты. Подтверждаете деньги только вы.'} />

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

      <div className="cards">
        <div className="card"><span>Партнёров</span><b>{data.totals.partners}</b></div>
        <div className="card money"><span>Привели за 30 дн.</span><b>{money(data.totals.brought)}</b></div>
        <div className="card">
          <span>К выплате</span><b>{money(data.totals.paidOut)}</b>
          {/* Начислено за 30 дней. Переводит владелец платформы сам —
              система деньги не отправляет, и «к выплате» это долг, а
              не сделанный перевод. */}
          <i>начислено за 30 дней</i>
        </div>
      </div>

      <div className="toolbar">
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Партнёр
        </button>
      </div>

      {/* Создание партнёра — окном, как у них: форма посреди списка
          сдвигает таблицу и заставляет искать место, где остановился. */}
      {adding && (
        <div className="modal"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setAdding(false); }}>
          <div className="modal-card">
            <div className="sheet-head">
              <h2>Новый партнёр</h2>
              <button className="btn small ghost sheet-x" aria-label="Закрыть"
                onClick={() => setAdding(false)}>×</button>
            </div>

            <label>Имя
              <input value={form.name} autoFocus
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>

            <label>Почта
              <input value={form.email} type="email"
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <i className="split">Это будет его вход</i>
            </label>

            <label>Пароль (передайте лично)
              <input value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <i className="split">Не короче восьми знаков</i>
            </label>

            <label>Доля партнёра, %
              <input type="number" min={0} max={100} value={String(form.commissionPercent)}
                onChange={(e) => setForm({ ...form, commissionPercent: Number(e.target.value) || 0 })} />
              <i className="split">С каждой подтверждённой оплаты его клиентов</i>
            </label>

            <div className="modal-actions">
              <button className="btn" onClick={() => setAdding(false)}>Отмена</button>
              <button className="btn primary"
                disabled={!form.name.trim() || !form.email.trim() || form.password.length < 8}
                onClick={async () => {
                  try {
                    await api('/partners', { method: 'POST', body: form });
                    setShown({ title: 'Пароль партнёра', value: form.password,
                      note: 'Показан один раз — передайте лично. В базе хранится отпечатком.' });
                    setAdding(false);
                    setForm({ name: '', email: '', password: '', commissionPercent: 15 });
                    dropCache(); await load();
                  } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
                }}>Завести</button>
            </div>
          </div>
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="all-clear">
          <b>Партнёров нет</b>
          <p>Заведите первого — он сможет вести своих клиентов.</p>
        </div>
      ) : (
        <table className="grid partners">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Почта</th>
              <th className="num">Клиентов</th>
              <th className="num">Доля партнёра</th>
              {/* Привёл и заработал — разные числа, и первое важнее. */}
              <th className="num">Привёл 30 дн.</th>
              <th className="num">Заработал 30 дн.</th>
              <th>Был в системе</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((p: any) => (
              <tr key={p.id}>
                <td data-label="Имя">
                  {/* Правка на месте: опечатку в имени гонять через
                      лист подтверждения незачем — это не деньги.

                      У владельцев платформы правка запрещена: долю им
                      не считают, а пароль каждый меняет себе сам. */}
                  <InlineText value={p.name} label="Имя партнёра"
                    disabled={p.isSuperUser}
                    onSave={(v) => save(p.id, { name: v }, 'Имя сохранено')} />
                  {p.isSuperUser && <span className="badge st-active">супер</span>}
                  {!p.isActive && <div className="sub">вход закрыт</div>}
                </td>
                <td data-label="Почта">
                  {/* Почта — это ВХОД. Занятую сервер не примет: два
                      партнёра с одной почтой означали бы, что один не
                      сможет войти. */}
                  <InlineText value={p.email} label="Почта для входа" mono
                    onSave={(v) => save(p.id, { email: v }, 'Почта сохранена')} />
                  {p.phone && <div className="sub">{p.phone}</div>}
                </td>
                <td className="num" data-label="Клиентов">
                  {p.clients}
                  <div className="sub">
                    работают {p.activeClients}
                    {p.lostClients ? `, ушло ${p.lostClients}` : ''}
                  </div>
                </td>
                <td className="num" data-label="Доля партнёра">
                  {p.isSuperUser ? <span className="nobody">—</span> : `${p.commissionPercent}%`}
                </td>
                <td className="num" data-label="Привёл 30 дн.">
                  {money(p.brought)}
                  <div className="sub">всего {money(p.broughtTotal)}</div>
                </td>
                <td className="num" data-label="Заработал 30 дн.">
                  {money(p.earned)}
                  <div className="sub">клиенты дают {money(p.mrr)}/мес</div>
                </td>
                <td data-label="Был в системе">
                  {p.neverLoggedIn
                    ? <span className="badge st-expired"><i className="dot" />ни разу</span>
                    : p.inactive
                      ? <span className="badge st-pending"><i className="dot" />{p.daysSilent} дн. назад</span>
                      : dateTime(p.lastLoginAt)}
                </td>
                <td className="actions">
                  {/* Два действия в меню, как у них: доля и пароль
                      нужны редко, но нужны — в строке им места нет. */}
                  <RowMenu actions={p.isSuperUser ? [] : [
                    { label: 'Изменить долю…',
                      hint: `сейчас ${p.commissionPercent}%`,
                      onClick: () => editShare(p) },
                    { label: 'Сменить пароль…',
                      hint: 'старый перестанет работать сразу',
                      onClick: () => changePassword(p) },
                    { label: p.isActive ? 'Закрыть вход' : 'Открыть вход',
                      hint: p.isActive
                        ? 'клиенты продолжат работать'
                        : 'партнёр снова сможет войти',
                      danger: p.isActive,
                      onClick: () => toggle(p) },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
