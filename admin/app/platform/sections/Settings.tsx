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
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { Failed, SkeletonCards } from '../ui/States';

export default function Settings({ me }: { me: Me }) {
  const [prices, setPrices] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  const load = async () => {
    try {
      const [p, s] = await Promise.all([api('/price-book'), api('/pay-settings')]);
      setPrices(p); setPay(s); setErr('');
    } catch (e: any) { setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, []);

  if (err && !prices) return <Failed text={err} onRetry={load} />;
  if (!prices || !pay) return <SkeletonCards count={2} height={240} />;

  const nothing = !pay.payUrl?.trim() && !pay.payQrUrl?.trim()
    && !pay.payPhone?.trim() && !pay.payName?.trim();

  const save = async (what: 'prices' | 'pay') => {
    try {
      what === 'prices'
        ? await api('/price-book', { method: 'POST', body: prices })
        : await api('/pay-settings', { method: 'POST', body: pay });
      dropCache();
      setSaved(what === 'prices' ? 'Цены сохранены' : 'Реквизиты сохранены');
      setTimeout(() => setSaved(''), 3000);
    } catch (e: any) { setErr(humanError(e)); }
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

          <label>Ссылка на оплату
            <input value={pay.payUrl ?? ''} placeholder="https://pay.kaspi.kz/..."
              onChange={(e) => setPay({ ...pay, payUrl: e.target.value })} />
            <i className="split">Kaspi, Halyk — любая ссылка, по которой можно заплатить</i>
          </label>

          <label>Картинка QR
            <input value={pay.payQrUrl ?? ''} placeholder="https://.../qr.png"
              onChange={(e) => setPay({ ...pay, payQrUrl: e.target.value })} />
            <i className="split">
              Прямая ссылка на КАРТИНКУ, а не на страницу, где она показана
            </i>
          </label>
        </section>

        <section className="pay-group">
          <h3>Перевод руками</h3>
          <p className="hint">Запасной путь: показывается, если ссылка не открылась.</p>

          <label>Получатель
            <input value={pay.payName ?? ''} placeholder="Магжан С."
              onChange={(e) => setPay({ ...pay, payName: e.target.value })} />
            <i className="split">Клиент проверяет, туда ли он платит</i>
          </label>

          <label>Номер для перевода
            <input value={pay.payPhone ?? ''} placeholder="+7 777 777 77 77"
              onChange={(e) => setPay({ ...pay, payPhone: e.target.value })} />
            {/* Отдельным полем, а не в общем тексте: строку целиком
                человек копирует и вставляет в поле номера — перевод не
                проходит, и виноватой оказывается система. */}
            <i className="split">Отдельным полем — его копируют целиком</i>
          </label>

          <label>Что писать в комментарии
            <input value={pay.payNote ?? ''} placeholder="Название магазина"
              onChange={(e) => setPay({ ...pay, payNote: e.target.value })} />
            <i className="split">Чтобы платёж нашли, когда он придёт</i>
          </label>

          <div className="pay-save">
            <button className="btn primary" onClick={() => save('pay')}>Сохранить реквизиты</button>
          </div>
        </section>

        {/* Живой предпросмотр — их приём: видно, что получит клиент,
            не заходя под ним. */}
        <section className="pay-group">
          <h3>Что увидит клиент</h3>

          {/* Их проверка: ссылка на страницу вместо картинки — частая
              ошибка, и клиент увидит пустое место. */}
          {pay.payQrUrl && !/\.(png|jpe?g|webp|svg)(\?|$)/i.test(pay.payQrUrl) && (
            <p className="bad">
              Ссылка не работает: клиент увидит пустое место. Нужна прямая ссылка
              на картинку, а не страница, где она показана.
            </p>
          )}

          <div className={`cp-frame ${nothing ? 'empty' : ''}`}>
            {nothing ? (
              <div className="cp-none">
                <b>Реквизиты не настроены</b>
                <span>Клиент не поймёт, куда платить</span>
              </div>
            ) : (
              <div className="cp-main">
                <span className="cp-label">К оплате</span>
                <b className="cp-sum">{money(prices.base ?? 0)}</b>

                {pay.payUrl?.trim() && (
                  <span className="cp-btn">Оплатить {money(prices.base ?? 0)}</span>
                )}
                {pay.payQrUrl?.trim() && <img className="cp-qr" src={pay.payQrUrl} alt="" />}
                {pay.payName?.trim() && (
                  <span className="cp-line">Получатель: {pay.payName}</span>
                )}
                {pay.payPhone?.trim() && (
                  <span className="cp-line">Перевод: {pay.payPhone}</span>
                )}
                {pay.payNote?.trim() && (
                  <span className="cp-line">В комментарии: {pay.payNote}</span>
                )}
              </div>
            )}
          </div>
          <p className="hint">Сумма в примере условная — у клиента подставится его счёт.</p>
        </section>
      </div>
    </>
  );
}
