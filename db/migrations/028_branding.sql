-- =====================================================================
-- 028_branding.sql — Часть 21: фирменный стиль.
--
-- Модель Wipon «Брендирование чека»: загрузить логотип (PNG/JPG, ≤500 КБ)
-- и указать рекламный текст. Модель МоегоСклада «Логотип, печать и подпись
-- в документах»: те же картинки в печатных формах.
--
-- Решение по хранению: картинки лежат в БД как base64, а НЕ файлами на диске.
-- Причина: у магазина один логотип и одна печать (десятки килобайт), зато
-- бэкап базы становится полным — восстановил базу, и фирменный стиль на
-- месте. Файловое хранилище ради 50 КБ — лишняя точка отказа при деплое.
--
-- Ключевое: для чека логотип хранится ЕЩЁ И в виде готового ESC/POS-растра
-- (1 бит на пиксель), собранного сервером. Касса печатает готовые байты —
-- ей не нужен декодер PNG, а результат одинаков на всех принтерах.
-- =====================================================================
CREATE TABLE IF NOT EXISTS branding (
  account_id      uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,

  -- документы (печатные формы)
  logo_base64     text,          -- data:image/png;base64,... для HTML-форм
  logo_mime       text,

  -- чек (модель Wipon)
  receipt_logo_raster  text,     -- base64 готового 1-битного растра ESC/POS
  receipt_logo_width   integer,  -- ширина в пикселях (кратна 8)
  receipt_logo_height  integer,
  receipt_ad_text      text,     -- рекламный текст под итогом («Спасибо!», акция)

  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

ALTER TABLE branding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branding_isolation ON branding;
CREATE POLICY branding_isolation ON branding
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON branding TO shop_app;

-- печать и подпись уже есть в organization (stamp_url/signature_url) с части 1 —
-- добавляем base64-варианты: URL требует внешнего хостинга, которого у
-- магазина нет
ALTER TABLE organization ADD COLUMN IF NOT EXISTS stamp_base64 text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS signature_base64 text;
