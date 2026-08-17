'use client';
/**
 * РАЗДЕЛ «НАСТРОЙКИ» — цены и куда платят магазины.
 *
 * Разметка из их main.tsx: section-title, hint, settings-hint,
 * pay-setup, pay-group, price-book, price-row, cp-frame, cp-main,
 * cp-line, cp-label, cp-sum, cp-qr, cp-btn, cp-none, split, pay-save.
 *
 * Их приём взят целиком: рядом с полями — ЖИВОЙ ПРЕДПРОСМОТР того, что
 * увидит клиент. Заполняешь реквизиты и сразу видишь его экран оплаты.
 * Иначе понять, что получилось, можно только зайдя клиентом.
 */
import { useEffect, useState } from 'react';
import { api, dropCache, money, type Me } from '../lib';

export default function Settings({ me }: { me: Me }) {
  const [prices, setPrices] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  const load = async () => {
    try {
      const [p, s] = await Promise.all([api('/price-book'), api('/pay-settings')]);
      setPrices(p); setPay(s); setErr('');
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !prices) return <div className="err">{err}</div>;
  if (!prices || !pay) return <div className="muted">Загрузка…</div>;

  const save = async (what: 'prices' | 'pay') => {
    try {
      what === 'prices'
        ? await api('/price-book', { method: 'POST', body: prices })
        : await api('/pay-settings', { method: 'POST', body: pay });
      dropCache();
      setSaved(what === 'prices' ? 'Цены сохранены' : 'Реквизиты сохранены');
      setTimeout(() => setSaved(''), 3000);
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      {err && <div className="err">{err}</div>}
      {saved && <div className="all-clear"><b>{saved}</b></div>}

      <h2 className="section-title">Цены платформы</h2>
      <p className="hint settings-hint">
        Новые цены войдут в следующие счета. Оплаченные периоды не меняются —
        клиент платит по той цене, о которой договорились.
      </p>

      <div className="price-book">
        {[
          ['base', 'Тариф «Старт»', 'в него входит одна касса и одна точка'],
          ['pro', 'Тариф «Стандарт»', 'опт, маркировка, техкарты'],
          ['extraPos', 'Вторая и следующая касса', 'в месяц за каждую'],
          ['extraStore', 'Вторая и следующая точка', 'в месяц за каждую'],
        ].map(([k, title, note]) => (
          <div className="price-row" key={k}>
            <label>
              {title}
              <i className="split">{note}</i>
            </label>
            <input value={String(prices[k] ?? 0)} inputMode="numeric"
              onChange={(e) => setPrices({ ...prices, [k]: Number(e.target.value) || 0 })} />
          </div>
        ))}

        {[
          ['discount6', 'Скидка за полгода, %', 'клиент платит вперёд — платформа получает деньги раньше'],
          ['discount12', 'Скидка за год, %', 'то же, но выгоднее обоим'],
        ].map(([k, title, note]) => (
          <div className="price-row" key={k}>
            <label>
              {title}
              <i className="split">{note}</i>
            </label>
            <input value={String(prices[k] ?? 0)} inputMode="numeric"
              onChange={(e) => setPrices({ ...prices, [k]: Number(e.target.value) || 0 })} />
          </div>
        ))}
      </div>

      <div className="pay-save">
        <button className="btn primary" onClick={() => save('prices')}>Сохранить цены</button>
      </div>

      <h2 className="section-title">Куда платят магазины</h2>
      <p className="hint settings-hint">
        Это увидит владелец магазина на странице подписки. Заполните хотя бы
        один путь — иначе он не поймёт, куда переводить.
      </p>

      <div className="pay-setup">
        <section className="pay-group">
          <h3>Как платят</h3>
          <p className="hint">Достаточно одного пути, но лучше оба.</p>

          <label>Картинка QR
            <input value={pay.payQrUrl ?? ''} placeholder="https://.../qr.png"
              onChange={(e) => setPay({ ...pay, payQrUrl: e.target.value })} />
            <i className="split">
              Ссылка на картинку: клиент наводит камеру и платит, не набирая номер
            </i>
          </label>

          <label>Реквизиты словами
            <textarea value={pay.payDetails ?? ''} rows={3}
              placeholder="Kaspi 7777 7777 7777, получатель Магжан С."
              onChange={(e) => setPay({ ...pay, payDetails: e.target.value })} />
            <i className="split">
              Запасной путь: показывается, если QR не открылся или его нет
            </i>
          </label>

          <div className="pay-save">
            <button className="btn primary" onClick={() => save('pay')}>Сохранить реквизиты</button>
          </div>
        </section>

        {/* Живой предпросмотр — их приём: видно, что получит клиент,
            не заходя под ним. */}
        <section className="pay-group">
          <h3>Что увидит клиент</h3>
          <div className="cp-frame">
            <div className="cp-main">
              <div className="cp-line">
                <span className="cp-label">К оплате</span>
                <span className="cp-sum">{money(prices.base ?? 0)}</span>
              </div>

              {pay.payQrUrl
                ? <img className="cp-qr" src={pay.payQrUrl} alt="" />
                : <div className="cp-none">QR не задан</div>}

              {pay.payDetails
                ? <div className="cp-line"><span>{pay.payDetails}</span></div>
                : <div className="cp-none">Реквизиты не заданы</div>}

              <button className="cp-btn" disabled>Я оплатил</button>
            </div>
          </div>
          <p className="hint">Сумма в примере условная — у клиента подставится его счёт.</p>
        </section>
      </div>
    </>
  );
}
