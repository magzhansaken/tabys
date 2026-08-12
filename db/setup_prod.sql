-- Боевая инициализация (идемпотентна, без DROP — в отличие от dev setup.sql).
-- Пароль shop_app задаётся отдельно после (compose делает ALTER ROLE).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shop_app') THEN
    CREATE ROLE shop_app WITH LOGIN NOSUPERUSER PASSWORD 'change_me';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO shop_app;
