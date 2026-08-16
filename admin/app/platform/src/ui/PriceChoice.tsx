/*
 * Цена: по прайсу или своя.
 *
 * Партнёр берёт готовую цену платформы одним нажатием, а не набирает
 * её заново на каждой сделке. Отступить можно — но это видно, и рядом
 * сказано, чем оно обернётся: решением владельца платформы.
 */
import { useState } from 'react';
import { money } from '../main';

export function PriceChoice({ listPrice, value, onChange, label, note }: {
  /** Цена по прайсу в тиынах; null — прайс ещё не загружен. */
  listPrice: number | null;
  /** Текущее значение в тиынах. */
  value: number;
  onChange: (tiyn: number) => void;
  label: string;
  /** Что будет, если отступить от прайса. */
  note?: string;
}) {
  const [custom, setCustom] = useState(listPrice === null ? true : value !== listPrice);

  const pickList = () => {
    setCustom(false);
    if (listPrice !== null) onChange(listPrice);
  };

  return (
    <div className="price-choice">
      <span className="price-label">{label}</span>
      <div className="price-modes">
        <button
          type="button"
          className={`chip ${!custom ? 'on' : ''}`}
          disabled={listPrice === null}
          onClick={pickList}
        >
          {listPrice === null ? 'По прайсу' : `По прайсу — ${money(listPrice)}`}
        </button>
        <button
          type="button"
          className={`chip ${custom ? 'on' : ''}`}
          onClick={() => setCustom(true)}
        >
          Своя цена
        </button>
      </div>

      {custom && (
        <label className="price-own">
          Цена в месяц, ₸
          <input
            type="number"
            inputMode="numeric"
            value={Math.round(value / 100)}
            onChange={(e) => onChange(Math.round(Number(e.target.value) * 100) || 0)}
          />
        </label>
      )}

      {custom && note && <i className="split price-note">{note}</i>}
      {!custom && listPrice !== null && (
        <i className="split">Цена платформы. Изменится в прайсе — новые сделки пойдут по новой.</i>
      )}
    </div>
  );
}
