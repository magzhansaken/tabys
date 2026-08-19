'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login } from '../../lib/api';
import { C } from '../../lib/ui';

/**
 * Вход по номеру телефона — как у UMAG и Wipon.
 * У МоегоСклада вход по e-mail: для владельца магазина в Казахстане
 * это лишний барьер, почты у половины просто нет.
 *
 * ВНЕШНИЙ ВИД: телефон — основной случай, компьютер второй. Одна карточка
 * шириной 390 px: на телефоне во весь экран, на компьютере по центру.
 * Отдельной десктопной вёрстки нет — меньше мест, где что-то разъедется.
 *   • поля 52 px и кнопка 54 px: попадает палец, а не курсор;
 *   • номер набран моноширинным — цифры одной ширины, опечатку видно;
 *   • ошибка показывается ПОД полем, а не общей строкой сверху: человек
 *     сразу видит, куда смотреть.
 * Формат номера строгий: +7 и десять цифр.
 */
const PHONE_OK = /^\+7\d{10}$/;

export default function LoginPage() {
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const submit = async () => {
    setErr(''); setBusy(true);
    try { await login(phone, password); router.push('/stores'); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // Показываем только когда человек уже что-то набрал: пустое поле — не ошибка.
  const badPhone = phone.length > 2 && !PHONE_OK.test(phone.replace(/\s/g, ''));

  const field: any = {
    width: '100%', height: 52, padding: '0 14px', borderRadius: 10, fontSize: 16,
    border: `1px solid #D8D8CF`, background: C.card, color: C.text, outline: 'none',
  };

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'start center', background: C.bg }}>
      <div style={{ width: '100%', maxWidth: 390, padding: '34px 24px 40px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 30 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accent, color: '#fff', fontSize: 16,
            fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Табыс</div>
        </div>

        <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em', margin: 0 }}>Вход в кабинет</h1>
        <p style={{ fontSize: 14.5, color: C.dim, lineHeight: 1.55, margin: '8px 0 26px' }}>
          Номер телефона и пароль владельца или администратора.
        </p>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13,
          color: badPhone ? C.red : C.dim, marginBottom: badPhone ? 8 : 16 }}>
          Номер телефона
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+77011234567"
            inputMode="tel" autoComplete="tel"
            style={{ ...field, fontFamily: 'var(--font-mono), monospace', letterSpacing: '.02em',
              borderColor: badPhone ? C.red : '#D8D8CF', background: badPhone ? '#FFFBFA' : C.card }} />
        </label>
        {badPhone && (
          <div style={{ fontSize: 13.5, color: C.red, lineHeight: 1.5, marginBottom: 16 }}>
            Номер должен быть из 11 цифр: +7 и десять знаков
          </div>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, color: C.dim }}>
          Пароль
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} autoComplete="current-password"
            style={field} />
        </label>

        <a href="/register" style={{ fontSize: 14, minHeight: 44, display: 'flex', alignItems: 'center', marginTop: 4 }}>
          Забыли пароль — восстановим по SMS
        </a>

        {err && <div style={{ color: C.red, fontSize: 13.5, lineHeight: 1.5, margin: '4px 0 10px' }}>{err}</div>}

        <button onClick={submit} disabled={busy}
          style={{ width: '100%', minHeight: 54, marginTop: 10, border: 0, borderRadius: 10, background: C.accent,
            color: '#fff', fontSize: 16.5, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.4 : 1 }}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>

        <div style={{ fontSize: 14, color: C.dim, lineHeight: 1.6, marginTop: 28 }}>
          Нет аккаунта? <a href="/register">Зарегистрировать магазин</a>
        </div>
      </div>
    </main>
  );
}
