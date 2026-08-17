'use client';
/**
 * ОКНО ОТМЕТКИ ОПЛАТЫ — перенесено из их main.tsx (PayForm).
 *
 * Вызывается кнопкой «Оплата» из списка клиентов. Партнёр получил
 * деньги — отмечает здесь, доступ продлевает владелец платформы после
 * проверки.
 *
 * Их приёмы, взятые целиком:
 *   СУММА ПОДСТАВЛЯЕТСЯ ИЗ ТАРИФА клиента — не надо вспоминать;
 *   честная строка сверху: «доступ продлит владелец платформы после
 *     проверки». Партнёр должен понимать, что от его отметки доступ
 *     НЕ откроется, иначе он скажет клиенту «всё готово» и ошибётся;
 *   способ оплаты списком, а не полем: «Каспи» и «каспи» в отчёте
 *     станут двумя разными способами;
 *   комментарий с подсказкой, что туда писать.
 *
 * Разметка их: modal, modal-card, sheet-head, sheet-x, hint, row2,
 * modal-actions.
 */
import { useState } from 'react';
import { api, money } from '../lib';
import { useToast } from './Toast';
import { humanError } from './errors';

const METHODS = [
  { value: 'kaspi', label: 'Каспи' },
  { value: 'cash',  label: 'Наличные' },
  { value: 'bank',  label: 'Перевод на счёт' },
  { value: 'other', label: 'Другое' },
];

export function PayForm({ client, onDone }: {
  client: { id: string; name: string; monthly: number };
  onDone: (saved: boolean) => void;
}) {
  // Сумма из тарифа клиента: партнёр не должен вспоминать, сколько тот
  // платит. Поправить можно — но начинать с пустого поля незачем.
  const [amount, setAmount] = useState(String(Math.round(client.monthly)));
  const [months, setMonths] = useState('1');
  const [method, setMethod] = useState('kaspi');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const toast = useToast();

  const n = Number(amount) || 0;
  const m = Math.min(24, Math.max(1, Number(months) || 1));

  const send = async () => {
    if (n <= 0) return;
    setBusy(true);
    try {
      await api('/payments', { method: 'POST',
        body: { accountId: client.id, amount: n, months: m, method, comment } });
      toast({ text: 'Оплата отмечена, ждёт подтверждения платформы' });
      onDone(true);
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
      setBusy(false);
    }
  };

  return (
    <div className="modal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}>
      <div className="modal-card">
        <div className="sheet-head">
          <h2>Оплата · {client.name}</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть"
            onClick={() => onDone(false)}>×</button>
        </div>

        {/* Честно о том, что произойдёт: партнёр не должен сказать
            клиенту «всё готово» и ошибиться. */}
        <p className="hint">
          Отметьте полученные деньги. Доступ продлит владелец платформы после проверки.
        </p>

        <div className="row2">
          <label>Сумма, ₸
            <input type="number" value={amount} inputMode="numeric"
              onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>Месяцев
            <input type="number" min={1} max={24} value={months}
              onChange={(e) => setMonths(e.target.value)} />
          </label>
        </div>

        <label>Как получены
          {/* Списком, а не полем: «Каспи» и «каспи» в отчёте стали бы
              двумя разными способами. */}
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>

        <label>Комментарий
          <input value={comment} placeholder="номер платежа, кто передал…"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && n > 0) send(); }} />
        </label>

        {n > 0 && (
          <p className="hint">
            {money(n)} за {m} мес. · {METHODS.find((x) => x.value === method)?.label}
          </p>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={() => onDone(false)}>Отмена</button>
          <button className="btn primary" disabled={busy || n <= 0} onClick={send}>
            {busy ? 'Отправляем…' : 'Отправить на подтверждение'}
          </button>
        </div>
      </div>
    </div>
  );
}
