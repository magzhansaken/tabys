'use client';
/**
 * Экран «заявка принята» (часть 38). Человек зарегистрировался, но доступ
 * открывает оператор после звонка. Важно: это НЕ ошибка, поэтому экран
 * спокойный и объясняет, что произойдёт дальше.
 *
 * ВНЕШНИЙ ВИД
 *   • Ни одного красного пикселя: красный в системе означает потерянные
 *     деньги, а здесь всё в порядке.
 *   • Вместо списка «что дальше» — дорожка из трёх шагов: первый закрашен,
 *     остальные ждут. Видно, где человек сейчас, и ожидание перестаёт быть
 *     пустой паузой.
 *   • ТИХАЯ ПРОВЕРКА. Страница переспрашивает статус раз в 20 секунд, но
 *     крутящегося круга нет — он читается как «что-то пошло не так».
 *     Вместо него зелёная точка и одна строка: система следит сама,
 *     человеку делать нечего. Кнопка «Проверить сейчас» — вторичная,
 *     для нетерпеливых.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';
import { C } from '../../lib/ui';

export default function PendingPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(false);

  // Проверяем статус: как только оператор активирует — сразу пускаем в кабинет,
  // человеку не придётся гадать и перезаходить.
  const check = async () => {
    setChecking(true);
    try {
      const me = await api('/auth/me');
      if (me?.accountStatus && me.accountStatus !== 'pending') { router.push('/dashboard'); return; }
      if (me?.businessName) setName(me.businessName);
    } catch { /* не вышло — просто ждём дальше */ }
    setChecking(false);
  };

  useEffect(() => {
    check();
    const t = setInterval(check, 20000);   // тихо переспрашиваем раз в 20 секунд
    return () => clearInterval(t);
  }, []);

  const steps: [string, string][] = [
    ['Звоним и знакомимся', 'Уточняем, чем торгует ваш магазин'],
    ['Открываем доступ', 'И даём 14 дней бесплатно'],
    ['Помогаем завести товары', 'И настроить кассу'],
  ];

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'start center', background: C.bg }}>
      <div style={{ width: '100%', maxWidth: 390, padding: '34px 24px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 34 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accent, color: '#fff', fontSize: 16,
            fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Табыс</div>
        </div>

        <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#E8F1EC',
          display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4 10.5 L8 14.5 L16 5.5" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em', margin: 0, lineHeight: 1.2 }}>
          Заявка принята
        </h1>
        <p style={{ fontSize: 15, color: C.prose, lineHeight: 1.6, margin: '12px 0 0' }}>
          Спасибо за регистрацию{name ? ` магазина «${name}»` : ' в «Табысе»'}. Мы позвоним вам на указанный
          номер, познакомимся и откроем доступ — обычно в тот же день.
        </p>

        <div style={{ marginTop: 26 }}>
          {steps.map(([title, sub], i) => (
            <div key={title} style={{ display: 'flex', gap: 14, paddingBottom: i === steps.length - 1 ? 0 : 18 }}>
              <div style={{ flex: '0 0 26px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', fontSize: 13, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: i === 0 ? C.accent : 'transparent', color: i === 0 ? '#fff' : C.dim,
                  border: i === 0 ? 0 : `1px solid #D3D3C9` }}>{i + 1}</div>
                {i < steps.length - 1 && <div style={{ flex: 1, width: 1, background: C.line, marginTop: 6 }} />}
              </div>
              <div style={{ paddingTop: 2 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
                <div style={{ fontSize: 13.5, color: C.dim, lineHeight: 1.55, marginTop: 3 }}>{sub}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 34 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, color: C.dim, lineHeight: 1.5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flex: '0 0 7px',
              background: checking ? C.gold : C.accent }} />
            Страница откроет кабинет сама, как только доступ будет открыт
          </div>
          <button onClick={check}
            style={{ width: '100%', minHeight: 48, marginTop: 14, border: `1px solid #D8D8CF`, borderRadius: 10,
              background: C.card, color: C.text, fontSize: 15, cursor: 'pointer' }}>
            Проверить сейчас
          </button>
          <div style={{ textAlign: 'center', fontSize: 13, color: C.faint, marginTop: 14 }}>
            Вопросы — <a href="tel:+77000000000">+7 700 000 00 00</a>
          </div>
        </div>
      </div>
    </main>
  );
}
