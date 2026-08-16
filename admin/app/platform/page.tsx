'use client';
/**
 * ПЛАТФОРМА — кабинет владельца сервиса и партнёров.
 *
 * Перенесён целиком из проекта автоматизации ресторанов, где обкатан
 * на живых клиентах: разметка, стили, поведение и тексты — их. У нас
 * изменено ровно одно место: переходник путей к серверу в src/main.tsx.
 *
 * Почему копией, а не переписыванием под нашу дизайн-систему: там
 * пять с половиной тысяч строк, каждая из которых уже проверена
 * работой. Переписывать — значит заново набивать те же шишки, и это
 * видно по их же летописи решений.
 *
 * Приводить к нашему виду будем потом и по частям, когда станет ясно,
 * что из этого действительно нужно магазинам, а что осталось от
 * ресторанов.
 */
import dynamic from 'next/dynamic';
import { QueryClientProvider } from '@tanstack/react-query';
import { qc } from './src/main';
import { ToastHost } from './src/ui/Toast';
import { AskHost } from './src/ui/ConfirmSheet';
import './src/admin.css';

/**
 * Кабинет рисуется ТОЛЬКО в браузере.
 *
 * Он читает ключ входа из хранилища браузера прямо при запуске — на
 * сервере такого хранилища нет, и предварительная отрисовка падает.
 * Для раздела, куда заходят по паролю, предварительная отрисовка и не
 * нужна: там нечего показывать до входа.
 */
const App = dynamic(() => import('./src/main').then((m) => m.App), {
  ssr: false,
  loading: () => <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Загрузка…</div>,
});

export default function PlatformPage() {
  return (
    <QueryClientProvider client={qc}>
      <ToastHost>
        <AskHost>
          <App />
        </AskHost>
      </ToastHost>
    </QueryClientProvider>
  );
}
