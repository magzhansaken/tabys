'use client';
/**
 * Перехват ошибок кабинета (часть 20+). Белый экран — худшее, что можно
 * показать владельцу магазина: вместо него — что случилось и кнопка
 * «Попробовать снова». Текст ошибки помогает и поддержке: его присылают
 * нам, и диагноз ставится за минуту.
 */
export default function CabError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ maxWidth: 560, margin: '10vh auto', fontFamily: 'system-ui', padding: 20 }}>
      <h2 style={{ color: '#b91c1c' }}>Страница споткнулась</h2>
      <p style={{ color: '#6b7280' }}>
        Данные целы — это ошибка отображения. Нажмите «Попробовать снова»;
        если повторится, пришлите в поддержку текст ниже.
      </p>
      <pre style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
        padding: 12, fontSize: 12, whiteSpace: 'pre-wrap' }}>{String(error?.message ?? error)}</pre>
      <button onClick={reset} style={{ background: '#0a9c6d', color: '#fff', border: 0,
        borderRadius: 8, padding: '10px 18px', fontSize: 15, cursor: 'pointer' }}>
        Попробовать снова
      </button>
      {' '}<a href="/dashboard" style={{ marginLeft: 10 }}>На дашборд</a>
    </div>
  );
}
