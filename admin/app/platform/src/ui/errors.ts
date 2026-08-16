/*
 * Ошибки сервера человеческими словами.
 *
 * Сервер отвечает кодом — это правильно: код не зависит от языка и
 * не ломается при переводе. Но показывать человеку {"code":"PHONE_TAKEN"}
 * нельзя, поэтому перевод живёт здесь, в одном месте.
 */
import { errText } from './Toast';

type Payload = { code?: string; name?: string; message?: string };

function parse(e: unknown): Payload | null {
  if (!(e instanceof Error)) return null;
  const raw = e.message.trim();
  if (!raw.startsWith('{')) return raw.includes('_') ? { code: raw } : null;
  try {
    return JSON.parse(raw) as Payload;
  } catch {
    /* Тело могло приехать обрезанным — вытащим код глазами. */
    const hit = raw.match(/"code"\s*:\s*"([A-Z_]+)"/);
    const who = raw.match(/"name"\s*:\s*"([^"]+)"/);
    return hit?.[1] ? { code: hit[1], name: who?.[1] } : null;
  }
}

export function humanError(e: unknown): string {
  const p = parse(e);
  const code = p?.code;
  if (!code) return errText(e);

  switch (code) {
    case 'PHONE_TAKEN':
      return p?.name
        ? `Этот телефон уже записан за «${p.name}»`
        : 'Этот телефон уже занят другим заведением';
    case 'EMAIL_TAKEN':
      return 'Эта почта уже занята — вход должен быть у одного человека';
    case 'BAD_COMMISSION':
      return 'Доля партнёра — от 0 до 100%';
    case 'SUPER_ONLY':
      return 'Это решает владелец платформы';
    case 'NOT_YOURS':
      return 'Этот клиент ведётся другим партнёром';
    case 'TENANT_NOT_FOUND':
      return 'Заведение не найдено — обновите список';
    case 'REASON_REQUIRED':
      return 'Нужна причина — её увидит партнёр';
    case 'ALREADY_DECIDED':
      return 'Решение по этой заявке уже принято';
    case 'PAYMENT_NOT_PENDING':
      return 'Эта оплата уже обработана — обновите очередь';
    case 'BAD_CREDENTIALS':
      return 'Не подошли почта или пароль';
    default:
      return errText(e);
  }
}
