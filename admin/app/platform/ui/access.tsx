'use client';
/**
 * ДОСТУПЫ КЛИЕНТА — перенесено из их ui/access.tsx.
 *
 * Их довод, взятый как есть: раньше доступы показывались один раз при
 * заведении и терялись навсегда — партнёр звонил владельцу платформы,
 * тот лез в базу. Теперь пароль пересоздаётся из карточки, а коды
 * ждущих устройств видно рядом с самими устройствами.
 *
 * Их приёмы:
 *   значение МОНОШИРИННО и с кнопкой копирования — его диктуют по
 *     телефону, и «скопировать» вернее, чем читать вслух;
 *   пароль с почтой копируются ОДНОЙ кнопкой: диктовать два поля
 *     подряд — значит один раз ошибиться.
 */
import { useState } from 'react';
import { useToast } from './Toast';

/** Одно значение моноширинно и с копированием: диктовать по телефону. */
export function CopyValue({ label, value, big }: {
  label: string; value: string; big?: boolean;
}) {
  const [done, setDone] = useState(false);
  const toast = useToast();

  return (
    <div className={`copy-value ${big ? 'big' : ''}`}>
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <button className="btn small"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setDone(true);
          toast({ text: `${label} скопирован` });
          window.setTimeout(() => setDone(false), 1600);
        }}>
        {done ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  );
}

/**
 * Новый пароль владельцу. Показан один раз — поэтому копируется
 * вместе с телефоном входа: диктовать два поля подряд значит один раз
 * ошибиться.
 */
export function NewPassword({ phone, password, onClose }: {
  phone: string; password: string; onClose: () => void;
}) {
  const toast = useToast();

  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <div className="sheet-head">
          <h2>Новый пароль владельцу</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть"
            onClick={onClose}>×</button>
        </div>

        <p className="hint">
          Старый пароль перестал работать. Этот показан один раз —
          продиктуйте владельцу сейчас или скопируйте.
        </p>

        <CopyValue label="Телефон для входа" value={phone} />
        <CopyValue label="Пароль" value={password} big />

        <div className="modal-actions">
          <button className="btn" onClick={() => {
            void navigator.clipboard?.writeText(`Вход: ${phone}\nПароль: ${password}`);
            toast({ text: 'Вход и пароль скопированы' });
          }}>Скопировать оба</button>
          <button className="btn primary" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  );
}

/**
 * ДОСТУПЫ ПОСЛЕ ЗАВЕДЕНИЯ КЛИЕНТА — их окно «Клиент создан».
 *
 * Их довод: эти данные показываются ОДИН РАЗ. Дальше пароль
 * пересоздаётся из карточки, но код привязки и вход придётся искать
 * заново — а партнёр в этот момент уже стоит в магазине.
 *
 * Поэтому: всё в одном месте, каждое поле копируется отдельно, и есть
 * кнопка «скопировать всё» — чтобы отправить владельцу одним
 * сообщением.
 */
export function Credentials({ rows, onClose }: {
  rows: { label: string; value: string }[];
  onClose: () => void;
}) {
  const toast = useToast();
  const all = rows.map((r) => `${r.label}: ${r.value}`).join('\n');

  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <div className="sheet-head">
          <h2>Клиент создан</h2>
        </div>

        <div className="creds">
          {rows.filter((r) => r.value).map((r) => (
            <CopyValue key={r.label} label={r.label} value={r.value} />
          ))}
        </div>

        <p className="hint">
          Эти данные показываются один раз — сохраните и передайте владельцу.
        </p>

        <div className="modal-actions">
          <button className="btn" onClick={() => {
            void navigator.clipboard?.writeText(all);
            toast({ text: 'Все доступы скопированы' });
          }}>Скопировать всё</button>
          <button className="btn primary" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  );
}
