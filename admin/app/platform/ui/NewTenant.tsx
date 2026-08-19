'use client';
/**
 * НОВЫЙ КЛИЕНТ — перенесено из их main.tsx (NewTenant).
 *
 * Партнёр или владелец платформы заводит магазин руками, когда клиент
 * пришёл не через сайт. После создания показываются доступы — один
 * раз, поэтому в отдельном окне с копированием.
 *
 * Их поля: название, владелец, телефон, город, тариф. Тип заведения у
 * них ресторанный (кафе, фастфуд, салон, бильярд) — у нас магазин
 * один, и поле не нужно.
 *
 * Телефон владельца — это ВХОД: по нему он войдёт в свой кабинет.
 * Поэтому он обязателен, а почта нет: в Казахстане телефон есть у
 * всех, почта — не у всех.
 */
import { useState } from 'react';
import { useSheet } from './useSheet';
import { api } from '../lib';
import { useToast } from './Toast';
import { humanError } from './errors';
import { Credentials } from './access';

export function NewTenant({ isSuper, partners, onDone }: {
  isSuper: boolean;
  partners: { id: string; name: string }[];
  onDone: (created: boolean) => void;
}) {
  const card = useSheet(() => onDone(false));
  const [f, setF] = useState({
    name: '', ownerName: '', ownerPhone: '', city: '',
    tier: 'base', partnerId: '', trialDays: '14',
  });
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<any[] | null>(null);

  const toast = useToast();
  const ready = f.name.trim().length >= 2 && f.ownerPhone.trim().length >= 10;

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const r = await api('/tenants', { method: 'POST', body: {
        name: f.name.trim(),
        ownerName: f.ownerName.trim() || 'Владелец',
        ownerPhone: f.ownerPhone.trim(),
        city: f.city.trim() || undefined,
        tier: f.tier,
        partnerId: f.partnerId || undefined,
        trialDays: Number(f.trialDays) || 14,
      }});
      // Доступы показываются один раз — отдельным окном с копированием.
      setCreds([
        { label: 'Телефон для входа', value: r.ownerPhone ?? f.ownerPhone },
        { label: 'Пароль', value: r.password ?? '' },
        { label: 'Код привязки кассы', value: r.activationCode ?? '' },
      ]);
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
      setBusy(false);
    }
  };

  if (creds) return <Credentials rows={creds} onClose={() => onDone(true)} />;

  return (
    <div className="modal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}>
      <div className="modal-card" ref={card}
        role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>Новый клиент</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть"
            onClick={() => onDone(false)}>×</button>
        </div>

        <p className="hint">
          Заводится вручную, когда клиент пришёл не через сайт.
          Доступы покажутся сразу после создания — один раз.
        </p>

        <label>Название магазина
          <input value={f.name} autoFocus placeholder="Магазин «Береке»"
            onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>

        <div className="row2">
          <label>Имя владельца
            <input value={f.ownerName} placeholder="Нурлан"
              onChange={(e) => setF({ ...f, ownerName: e.target.value })} />
          </label>
          <label>Город
            <input value={f.city} placeholder="Астана"
              onChange={(e) => setF({ ...f, city: e.target.value })} />
          </label>
        </div>

        <label>Телефон владельца
          <input value={f.ownerPhone} placeholder="+7 701 123-45-67" inputMode="tel"
            onChange={(e) => setF({ ...f, ownerPhone: e.target.value })} />
          {/* Телефон — это ВХОД: по нему владелец войдёт в кабинет.
              Почта не спрашивается: в Казахстане телефон есть у всех,
              почта не у всех. */}
          <i className="split">По нему владелец войдёт в свой кабинет</i>
        </label>

        <div className="row2">
          <label>Тариф
            <select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>
              <option value="base">«Старт»</option>
              <option value="pro">«Стандарт»</option>
            </select>
          </label>
          <label>Пробный период, дней
            <input value={f.trialDays} inputMode="numeric"
              onChange={(e) => setF({ ...f, trialDays: e.target.value })} />
          </label>
        </div>

        {isSuper && partners.length > 0 && (
          <label>Кто ведёт
            <select value={f.partnerId}
              onChange={(e) => setF({ ...f, partnerId: e.target.value })}>
              <option value="">Платформа · клиент ничей</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <i className="split">Доля считается с будущих оплат этого клиента</i>
          </label>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={() => onDone(false)}>Отмена</button>
          <button className="btn primary" disabled={!ready || busy} onClick={send}>
            {busy ? 'Создаём…' : 'Создать клиента'}
          </button>
        </div>
      </div>
    </div>
  );
}
