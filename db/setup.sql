-- Создание базы и ролей. Запускать от postgres один раз.
-- psql -U postgres -f db\setup.sql
DROP DATABASE IF EXISTS shop_dev;
DROP ROLE IF EXISTS shop_app;
DROP ROLE IF EXISTS shop;

-- роль для миграций: ей нужны права на создание расширений и функций
CREATE ROLE shop WITH LOGIN SUPERUSER PASSWORD 'shop';

-- роль для работы программы. НЕ superuser — иначе изоляция аккаунтов
-- (row level security) не действует: суперпользователь обходит все политики.
CREATE ROLE shop_app WITH LOGIN NOSUPERUSER PASSWORD 'change_me_in_prod';

CREATE DATABASE shop_dev OWNER shop;
\c shop_dev
GRANT USAGE ON SCHEMA public TO shop_app;
GRANT CREATE ON SCHEMA public TO shop;
