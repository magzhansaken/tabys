/**
 * Корневой каркас. Здесь два дела: шрифт и базовые стили.
 *
 * ШРИФТ. IBM Plex закрывает казахскую кириллицу целиком (ә ғ қ ң ө ұ ү һ і).
 * Обязателен поднабор 'cyrillic-ext': ә ө ұ ү живут именно в нём, без него
 * казахский лендинг будет в дырах, и заметят это клиенты, а не мы.
 * Начертания взяты ровно те, что используются: Sans 400/500/600, Mono 400/500.
 *
 * Шрифт уже лежит у нас в public/fonts (github.com/IBM/plex, лицензия
 * OFL 1.1 разрешает размещать у себя). Обратно на внешний сервис не
 * переводить: сборка на этом уже падала, а у клиентов в областях
 * медленный интернет — внешний запрос задерживает первый показ.
 *
 * БАЗОВЫЕ СТИЛИ. <BaseStyles /> подключается ОДИН раз и на всё приложение:
 * сброс страницы, цвета ссылок, печать и превращение таблиц в карточки
 * на телефоне. Страницам ничего для этого делать не нужно.
 */
import localFont from 'next/font/local';
import { BaseStyles } from '../lib/ui';

/**
 * Шрифт лежит У НАС в public/fonts, а не тянется с чужого сервера.
 * Три причины: у клиентов в областях интернет медленный и внешний
 * запрос задерживает первый показ; сборка не должна зависеть от
 * доступности чужого сервиса; шрифт не пропадёт, если сервис закроют.
 *
 * Проверено байтами, а не на слово: в файле есть все девять казахских
 * букв (ә ғ қ ң ө ұ ү һ і) и символ тенге ₸.
 * Лицензия OFL 1.1 — размещать у себя разрешено.
 */
const sans = localFont({
  src: [
    { path: '../public/fonts/IBMPlexSans-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/IBMPlexSans-Medium.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/IBMPlexSans-SemiBold.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
});

const mono = localFont({
  src: [
    { path: '../public/fonts/IBMPlexMono-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/IBMPlexMono-Medium.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata = {
  title: 'Табыс — кабинет магазина',
  description: 'Табыс — учёт для магазина. Тәртіп — табыстың басы',
  manifest: '/manifest.webmanifest',
  themeColor: '#0B6B4F',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Табыс' },
};

// maximumScale: 1 оставлен как был. Он безопасен только потому, что все поля
// ввода в системе набраны шрифтом 16 px — иначе iOS увеличивал бы страницу
// сам, а запрет мешал бы вернуть масштаб обратно.
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, themeColor: '#0B6B4F' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${sans.variable} ${mono.variable}`}>
      <body style={{ margin: 0, background: '#F5F5F1', fontFamily: 'var(--font-sans), system-ui, sans-serif' }}>
        <BaseStyles />
        {children}
      </body>
    </html>
  );
}
