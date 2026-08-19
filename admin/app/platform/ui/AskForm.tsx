'use client';
/**
 * ОКНО ПОДАЧИ ЗАЯВКИ — перенесено из их main.tsx (AskForm).
 *
 * Партнёр не меняет деньги сам: он просит платформу. Вызывается из
 * меню строки клиента пунктом «Запросить у платформы».
 *
 * Их приёмы, взятые целиком:
 *   честная подсказка: «Всё, что меняет деньги, решает владелец
 *     платформы. Опишите, что нужно клиенту и почему — так решение
 *     придёт быстрее»;
 *   у каждого вида заявки СВОИ поля: устройство — какое и сколько,
 *     тариф — название и цена, отсрочка — дней;
 *   ПРИЧИНА ОБЯЗАТЕЛЬНА, и порог пять знаков: «надо» причиной не
 *     является, а владелец платформы решает по ней.
 *
 * Отличие по делу: у них устройства ресторанные (экран кухни, телефон
 * официанта, курьер), у магазина их два — касса и точка.
 */
import { useState } from 'react';
import { useSheet } from './useSheet';
import { api } from '../lib';
import { useToast } from './Toast';
import { humanError } from './errors';

const KINDS = [
  { value: 'device', label: 'Больше устройств' },
  { value: 'tariff', label: 'Другой тариф' },
  { value: 'grace',  label: 'Отсрочку оплаты' },
  { value: 'other',  label: 'Прочее' },
];

const DEVICES = [
  { value: 'pos',   title: 'Касса' },
  { value: 'store', title: 'Точка' },
];

export function AskForm({ client, onDone }: {
  client: { id: string; name: string };
  onDone: (sent: boolean) => void;
}) {
  const card = useSheet(() => onDone(false));
  const [kind, setKind] = useState('device');
  const [device, setDevice] = useState('pos');
  const [tier, setTier] = useState('pro');
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const toast = useToast();

  // Причина от пяти знаков: «надо» причиной не является, а владелец
  // платформы решает именно по ней.
  const ready = reason.trim().length >= 5;

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    const payload =
      kind === 'device' ? { device }
      : kind === 'tariff' ? { tier }
      : kind === 'grace' ? { days: Number(days) || 7 }
      : {};
    try {
      await api('/requests', { method: 'POST',
        body: { accountId: client.id, kind, payload, comment: reason.trim() } });
      toast({ text: 'Заявка отправлена владельцу платформы' });
      onDone(true);
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
      setBusy(false);
    }
  };

  return (
    <div className="modal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}>
      <div className="modal-card" ref={card}
        role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>Запрос по «{client.name}»</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть"
            onClick={() => onDone(false)}>×</button>
        </div>

        <p className="hint">
          Всё, что меняет деньги, решает владелец платформы. Опишите,
          что нужно клиенту и почему — так решение придёт быстрее.
        </p>

        <label>Что просим
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>

        {/* У каждого вида свои поля: спрашивать «сколько дней» при
            смене тарифа незачем. */}
        {kind === 'device' && (
          <label>Что подключаем
            <select value={device} onChange={(e) => setDevice(e.target.value)}>
              {DEVICES.map((d) => <option key={d.value} value={d.value}>{d.title}</option>)}
            </select>
          </label>
        )}

        {kind === 'tariff' && (
          <label>Какой тариф
            <select value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="base">«Старт»</option>
              <option value="pro">«Стандарт»</option>
            </select>
          </label>
        )}

        {kind === 'grace' && (
          <label>Дней отсрочки
            <input type="number" min={1} max={90} value={days}
              onChange={(e) => setDays(e.target.value)} />
          </label>
        )}

        <label>Почему
          <input value={reason} placeholder="Открывают вторую точку, нужна ещё касса"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready) send(); }} />
        </label>

        <div className="modal-actions">
          <button className="btn" onClick={() => onDone(false)}>Отмена</button>
          <button className="btn primary" disabled={!ready || busy} onClick={send}>
            {busy ? 'Отправляем…' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}
