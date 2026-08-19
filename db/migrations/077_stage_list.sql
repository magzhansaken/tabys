-- =====================================================================
-- 077_stage_list.sql — три разных списка этапов воронки.
--
-- НАЙДЕНО СВЕРКОЙ. Обычный сдвиг карточки в «Пробный» падал с
-- «Internal server error». Причина: список этапов разошёлся ТРОЕКРАТНО.
--
--   база:    new · contacted · demo · proposal · won · lost
--   сервер:  new · called · demo · won · lost
--   воронка: new · contacted · trial · paid · lost
--
-- База и сервер остались от старого замысла (продажная воронка с
-- «предложением» и «сделкой»), а воронка платформы живёт по своему:
-- новый → связались → пробный → оплатил → отказ.
--
-- Работало только потому, что живая воронка двигает карточки сама и
-- ручной сдвиг делали редко. При первом же нажатии — ошибка базы.
--
-- Приводим к списку ВОРОНКИ: он единственный, что видит человек, и
-- единственный, у которого этапы означают состояние клиента, а не
-- стадию продажи.
-- =====================================================================
ALTER TABLE tenant_card DROP CONSTRAINT IF EXISTS tenant_card_deal_stage_check;

-- Старые значения переводим в новые: 'demo' и 'proposal' — это
-- «связались», 'won' — «оплатил».
UPDATE tenant_card SET deal_stage = CASE deal_stage
  WHEN 'demo'     THEN 'contacted'
  WHEN 'proposal' THEN 'contacted'
  WHEN 'won'      THEN 'paid'
  WHEN 'called'   THEN 'contacted'
  ELSE deal_stage END
 WHERE deal_stage IN ('demo', 'proposal', 'won', 'called');

ALTER TABLE tenant_card ADD CONSTRAINT tenant_card_deal_stage_check
  CHECK (deal_stage = ANY (ARRAY['new','contacted','trial','paid','lost']));
