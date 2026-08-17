/*
 * Состав тарифа диалогом — быстрый доступ из списка клиентов.
 *
 * Сама таблица счёта живёт в ui/PlanLines.tsx и одинакова здесь и на
 * странице клиента: цена и количество правятся в ячейке, удаление
 * строки и смена уровня — через лист с последствием. Системных
 * окошек браузера в этом пути больше нет.
 */
import { PlanLines } from './ui/PlanLines';

export function PlanDialog({ token, tenantId, tenantName, tenantTier, isSuper, onClose, onOpenCard }: {
  token: string;
  tenantId: string;
  tenantName: string;
  tenantTier?: string;
  isSuper: boolean;
  onClose: () => void;
  /** Перейти на страницу клиента: там же платежи, устройства и история. */
  onOpenCard?: () => void;
}) {
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card wide" role="dialog" aria-modal="true" aria-label={`Состав счёта · ${tenantName}`}>
        <div className="sheet-head">
          <h2>Состав счёта · {tenantName}</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={onClose}>×</button>
        </div>
        <p className="hint">
          Каждая строка — деньги в месяц. Основа, доплата за устройства,
          персональная скидка (цена со знаком минус). Итог считается по
          действующим строкам.
        </p>

        <PlanLines token={token} tenantId={tenantId} tenantTier={tenantTier} isSuper={isSuper} />

        <div className="modal-actions">
          {onOpenCard && <button className="btn" onClick={onOpenCard}>Открыть карточку клиента</button>}
          <button className="btn primary" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  );
}
