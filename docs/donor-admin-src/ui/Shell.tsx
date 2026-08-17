/*
 * Оболочка панели: боковая колонка, счётчики, роль, тема.
 *
 * Семь вкладок одного веса не показывали, где сегодня работа.
 * Теперь ежедневное сверху со счётчиками, настройка — внизу,
 * отдельно. У партнёра свой порядок пунктов: он ведёт клиентов,
 * а не подтверждает деньги.
 *
 * На телефоне колонка уезжает в нижнюю панель: владелец платформы
 * подтверждает оплату из машины, большим пальцем.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type TabKey =
  | 'today' | 'summary' | 'funnel' | 'tenants' | 'payments' | 'requests' | 'partners' | 'journal' | 'pay';

export type Counts = { today: number; payments: number; requests: number; approvals: number };

type Item = { key: TabKey; label: string; count?: number };

const LS_THEME = 'dastarhan.platform.theme';

/** Тема живёт на <html data-theme>: роли берутся из tokens.css. */
export function useTheme(): ['light' | 'dark', () => void] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem(LS_THEME) === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

export function Shell({
  userName,
  isSuper,
  tab,
  onTab,
  counts,
  onLogout,
  children,
}: {
  userName: string;
  isSuper: boolean;
  tab: TabKey;
  onTab: (t: TabKey) => void;
  counts: Counts;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [theme, toggleTheme] = useTheme();

  const main: Item[] = isSuper
    ? [
      { key: 'today', label: 'Сегодня', count: counts.today },
      { key: 'tenants', label: 'Клиенты', count: counts.approvals },
      { key: 'payments', label: 'Деньги', count: counts.payments },
      { key: 'requests', label: 'Заявки', count: counts.requests },
      { key: 'funnel', label: 'Воронка' },
      { key: 'partners', label: 'Партнёры' },
      { key: 'summary', label: 'Сводка' },
      { key: 'journal', label: 'Журнал' },
    ]
    : [
      { key: 'today', label: 'Сегодня', count: counts.today },
      { key: 'tenants', label: 'Мои клиенты' },
      { key: 'funnel', label: 'Воронка' },
      { key: 'requests', label: 'Мои заявки' },
      { key: 'payments', label: 'Оплаты' },
      { key: 'journal', label: 'Мои события' },
    ];

  const initials = userName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <b>Дастархан</b>
          <span>панель платформы</span>
        </div>

        <nav className="side-nav">
          {main.map((i) => (
            <NavButton key={i.key} item={i} on={tab === i.key} onClick={() => onTab(i.key)} />
          ))}
          {isSuper && (
            <>
              <div className="side-sep" />
              <NavButton
                item={{ key: 'pay', label: 'Настройки' }}
                on={tab === 'pay'}
                onClick={() => onTab('pay')}
              />
            </>
          )}
        </nav>

        <div className="side-foot">
          <div className="me">
            <span className="ava" aria-hidden="true">{initials}</span>
            <span className="me-text">
              <b>{userName}</b>
              <i>{isSuper ? 'супер-админ' : 'партнёр'}</i>
            </span>
          </div>
          <div className="side-row">
            <button className="side-mini" onClick={toggleTheme}>
              {theme === 'light' ? 'Светлая тема' : 'Тёмная тема'}
            </button>
            <button className="side-mini" onClick={onLogout}>Выйти</button>
          </div>
        </div>
      </aside>

      <div className="frame">
        <header className="topbar">
          <b>Дастархан · платформа</b>
          <span className="badge">{isSuper ? 'супер-админ' : 'партнёр'}</span>
          <button className="btn small ghost" onClick={toggleTheme}>
            {theme === 'light' ? 'Тёмная' : 'Светлая'}
          </button>
          <button className="btn small ghost" onClick={onLogout}>Выйти</button>
        </header>

        <main>{children}</main>
      </div>

      <nav className="tabbar">
        {main.map((i) => (
          <button
            key={i.key}
            className={tab === i.key ? 'on' : ''}
            onClick={() => onTab(i.key)}
          >
            {i.label}
            {i.count ? <span className="count">{i.count}</span> : null}
          </button>
        ))}
        {isSuper && (
          <button className={tab === 'pay' ? 'on' : ''} onClick={() => onTab('pay')}>
            Ещё
          </button>
        )}
      </nav>
    </div>
  );
}

function NavButton({ item, on, onClick }: { item: Item; on: boolean; onClick: () => void }) {
  return (
    <button className={on ? 'on' : ''} onClick={onClick}>
      <span>{item.label}</span>
      {item.count ? <span className="count">{item.count}</span> : null}
    </button>
  );
}
