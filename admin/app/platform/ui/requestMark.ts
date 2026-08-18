/**
 * ОТМЕТКА ЗАЯВКИ НА КАРТОЧКЕ ВОРОНКИ — по образцу их requestMark.
 *
 * Их довод виден из кода: партнёр двигает карточку и должен видеть,
 * что по этому клиенту уже запрошено. Иначе он попросит второй раз, а
 * владелец платформы решит дважды.
 *
 * РЕШЕНИЯ ПОКАЗЫВАЮТСЯ ТОЛЬКО НЕДЕЛЮ. Их приём: «одобрено» месячной
 * давности — уже не новость, а шум, который учит не смотреть на
 * отметки вовсе.
 */
export type Mark = { text: string; tone: 'wait' | 'ok' | 'bad' };

const WHAT: Record<string, string> = {
  device: 'устройство',
  tariff: 'смена тарифа',
  grace:  'отсрочка',
  other:  'запрос',
};

export function requestMark(r: {
  kind?: string; status?: string; decidedAt?: string | null; decisionNote?: string | null;
}): Mark | null {
  const what = WHAT[r.kind ?? ''] ?? 'запрос';

  if (r.status === 'pending') return { text: `${what} — ждёт решения`, tone: 'wait' };
  if (!r.decidedAt) return null;

  // Неделя — и отметка уходит: старое решение это шум.
  if (Date.now() - new Date(r.decidedAt).getTime() > 7 * 86_400_000) return null;

  if (r.status === 'approved') return { text: `${what} — одобрено`, tone: 'ok' };
  return {
    text: r.decisionNote ? `отказано: ${r.decisionNote}` : `${what} — отказано`,
    tone: 'bad',
  };
}
