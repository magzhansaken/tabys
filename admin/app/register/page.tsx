'use client';
/**
 * Самостоятельная регистрация владельца: телефон → SMS-код → магазин готов.
 * Пробный период включается сервером сразу — можно пробивать чеки в день
 * регистрации, без звонка менеджеру (в отличие от подключения UMAG).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { tokens } from '../../lib/api';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function RegisterPage() {
  const [step, setStep] = useState<1 | 2>(1);
  const [phone, setPhone] = useState('+7');
  const [devHint, setDevHint] = useState('');
  const [form, setForm] = useState({ businessName: '', ownerName: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const post = async (path: string, body: any) => {
    const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.message ?? 'Ошибка');
    return d;
  };

  // Код из СМС не запрашиваем: заявку подтверждает оператор звонком.
  // Функция оставлена — вернётся, когда подключим СМС-шлюз.
  const sendCode = async () => {
    setErr('');
    if (!/^\+7\d{10}$/.test(phone)) { setErr('Телефон в формате +7XXXXXXXXXX'); return; }
    setStep(2);
  };

  const register = async () => {
    setErr(''); setBusy(true);
    try {
      const d = await post('/auth/register', { phone, ...form });
      tokens.set(d.access, d.refresh);
      // Заявка ждёт активации оператором — ведём на понятный экран,
      // а не в кабинет, где всё равно всё закрыто.
      router.push('/pending');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const inp = { width: '100%', padding: 10, margin: '4px 0 14px', border: '1px solid #ddd', borderRadius: 8, fontSize: 15 } as const;
  const lbl = { fontSize: 13, color: '#666' } as const;

  return (
    <main style={{ maxWidth: 380, margin: '80px auto', background: '#fff', padding: 28, borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)' }}>
      <h1 style={{ fontSize: 22, marginTop: 0 }}>Регистрация магазина</h1>
      {step === 1 ? (
        <>
          <label style={lbl}>Номер телефона</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+77011234567" style={inp} />
          {err && <div style={{ color: '#c00', fontSize: 13, marginBottom: 10 }}>{err}</div>}
          <button onClick={sendCode} disabled={busy}
                  style={{ width: '100%', padding: 11, background: '#0a7', color: '#fff', border: 0, borderRadius: 8, fontSize: 15, cursor: 'pointer' }}>
            {busy ? 'Отправляем…' : 'Получить код по SMS'}
          </button>
        </>
      ) : (
        <>
          {devHint && <div style={{ background: '#fff4e5', padding: 8, borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{devHint}</div>}

          <label style={lbl}>Название магазина</label>
          <input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} placeholder="Продукты у дома" style={inp} />
          <label style={lbl}>Ваше имя</label>
          <input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} style={inp} />
          <label style={lbl}>Пароль</label>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                 onKeyDown={(e) => e.key === 'Enter' && register()} style={inp} />
          {err && <div style={{ color: '#c00', fontSize: 13, marginBottom: 10 }}>{err}</div>}
          <button onClick={register} disabled={busy}
                  style={{ width: '100%', padding: 11, background: '#0a7', color: '#fff', border: 0, borderRadius: 8, fontSize: 15, cursor: 'pointer' }}>
            {busy ? 'Создаём…' : 'Создать магазин'}
          </button>
        </>
      )}
      <p style={{ fontSize: 12, color: '#999', marginTop: 14 }}>
        Уже есть аккаунт? <a href="/login" style={{ color: '#087a5c' }}>Войти</a>
      </p>
    </main>
  );
}
