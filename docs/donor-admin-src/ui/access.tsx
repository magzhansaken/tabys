/*
 * Доступы клиента: пароль владельца и коды устройств.
 *
 * Раньше доступы показывались один раз при заведении и терялись
 * навсегда: партнёр звонил владельцу платформы, тот лез в базу.
 * Теперь пароль пересоздаётся из карточки, а коды ждущих устройств
 * видно рядом с самими устройствами.
 *
 * Сброс пароля — опасное действие: старый умирает, живые сессии
 * владельца гаснут. Поэтому лист с последствиями, а новый пароль
 * показывается крупно и один раз.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { call } from '../main';
import { useAsk } from './ConfirmSheet';
import { humanError } from './errors';
import { useToast } from './Toast';

export type Activation = { name: string; kind: string; code: string | null; activated: boolean };

export function useActivationCodes(token: string, tenantId: string) {
  return useQuery({
    queryKey: ['activation', tenantId],
    queryFn: () => call<{ rows: Activation[] }>(`/tenant/activation?tenantId=${tenantId}`, { token }),
  });
}

/** Одно значение моноширинно и с копированием: диктовать по телефону. */
export function CopyValue({ label, value, big }: { label: string; value: string; big?: boolean }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <div className={`copy-value ${big ? 'big' : ''}`}>
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <button
        className="btn small"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setDone(true);
          toast({ text: `${label} скопирован` });
          window.setTimeout(() => setDone(false), 1600);
        }}
      >
        {done ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  );
}

/** Новый пароль: показываем один раз, поэтому крупно и с копированием. */
export function NewPassword({ email, password, onClose }: {
  email: string; password: string; onClose: () => void;
}) {
  const toast = useToast();
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card wide" role="dialog" aria-modal="true" aria-label="Новый пароль владельца">
        <div className="sheet-head">
          <h2>Новый пароль владельца</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={onClose}>×</button>
        </div>
        <p className="hint">
          Пароль показывается один раз — скопируйте и передайте владельцу.
          Прежний пароль уже не работает.
        </p>
        <CopyValue label="Вход в офис" value={email} />
        <CopyValue label="Пароль" value={password} big />
        <div className="modal-actions">
          <button className="btn" onClick={() => {
            void navigator.clipboard?.writeText(`Офис: ${email}\nПароль: ${password}`);
            toast({ text: 'Доступы скопированы' });
          }}>Скопировать всё</button>
          <button className="btn primary" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  );
}

export function useResetPassword(token: string): {
  reset: (t: { id: string; name: string; ownerName: string | null }) => Promise<void>;
  issued: { email: string; password: string } | null;
  clear: () => void;
} {
  const ask = useAsk();
  const toast = useToast();
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  const m = useMutation({
    mutationFn: (tenantId: string) =>
      call<{ email: string; password: string }>('/tenant/reset-password', {
        method: 'POST', token, body: { tenantId },
      }),
    onSuccess: (r) => setIssued(r),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const reset = async (t: { id: string; name: string; ownerName: string | null }) => {
    const answer = await ask({
      title: `Сбросить пароль · ${t.name}`,
      sub: 'Новый пароль появится сразу, показать его можно будет только один раз.',
      effects: [
        ['Заведение', t.name],
        ['Владелец', t.ownerName ?? '—'],
        ['Прежний пароль', 'перестанет работать'],
        ['Открытые сеансы', 'владельца выбросит из офиса'],
        ['Касса и кухня', 'продолжат работать — у них свои коды'],
      ],
      danger: true,
      confirmLabel: 'Сбросить пароль',
    });
    if (!answer) return;
    m.mutate(t.id);
  };

  return { reset, issued, clear: () => setIssued(null) };
}
