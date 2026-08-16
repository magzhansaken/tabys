'use client';
/**
 * Вход в кабинет платформы.
 *
 * Отдельный от входа магазина: это другие люди, другой ключ и другая
 * задача. Вход по ПОЧТЕ, а не по телефону, — у владельца сервиса и
 * партнёров почта есть, они работают за компьютером.
 *
 * Одна карточка 390 px: на телефоне во весь экран, на компьютере по
 * центру. Отдельной десктопной вёрстки нет — меньше мест, где разъедется.
 * Поля 52 px, кнопка 54 px: попадает палец, а не курсор.
 */
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { C, MONO } from '../../../lib/ui';
import { platformLogin } from '../lib';

export default function PlatformLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const submit = async () => {
    if (!email.trim() || !password) {
      setErr('Введите почту и пароль. Партнёру пароль выдаёт владелец платформы.');
      return;
    }
    setErr(''); setBusy(true);
    try {
      const u = await platformLogin(email.trim(), password);
      // Партнёр приходит за оплатами: отметить полученные деньги — его
      // главное дело. Владелец начинает со списка клиентов.
      router.replace(u.role === 'partner' ? '/platform/payments' : '/platform');
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const field: any = {
    width: '100%', height: 52, padding: '0 14px', borderRadius: 10, fontSize: 16,
    border: `1px solid #D8D8CF`, background: C.card, color: C.text, outline: 'none',
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'start center', background: C.bg }}>
      <div style={{ width: '100%', maxWidth: 390, padding: '34px 24px 40px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 30 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, background: C.accent, color: '#fff', fontSize: 16,
            fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          }}>Т</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Табыс</div>
        </div>

        <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em', margin: 0 }}>Кабинет платформы</h1>
        <p style={{ fontSize: 14.5, color: C.dim, lineHeight: 1.55, margin: '8px 0 26px' }}>
          Вход для владельца сервиса и партнёров. Кабинет магазина — по своему адресу и со своим паролем.
        </p>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, color: C.dim, marginBottom: 16 }}>
          Почта
          <input value={email} onChange={(e) => { setEmail(e.target.value); setErr(''); }}
            placeholder="owner@tabys.kz" inputMode="email" autoComplete="username"
            style={{ ...field, fontFamily: MONO }} />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, color: C.dim }}>
          Пароль
          <input type="password" value={password}
            onChange={(e) => { setPassword(e.target.value); setErr(''); }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            autoComplete="current-password" style={field} />
        </label>

        {err && <div style={{ color: C.red, fontSize: 13.5, lineHeight: 1.5, margin: '12px 0 0' }}>{err}</div>}

        <button onClick={submit} disabled={busy}
          style={{
            width: '100%', minHeight: 54, marginTop: 18, border: 0, borderRadius: 10, background: C.accent,
            color: '#fff', fontSize: 16.5, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.4 : 1,
          }}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>

        <div style={{ fontSize: 13.5, color: C.dim, lineHeight: 1.6, marginTop: 26 }}>
          Пароль партнёру выдаёт владелец платформы: он показывается один раз при заведении.
          Забыли — попросите новый, старый не восстанавливается: в базе он хранится отпечатком.
        </div>
      </div>
    </main>
  );
}
