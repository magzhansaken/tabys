/*
 * СПИСОК МАГАЗИНОВ: что настоящее, что проверочное.
 *
 * В боевой базе накопились магазины, заведённые при проверках: имена
 * набраны наугад, торговли не было. Они попадают в отчёты платформы, в
 * счёт клиентов и в доход партнёров — цифры получаются неправдой.
 *
 * УДАЛЯТЬ САМ НЕ БУДУ, и по имени тем более: «Сат» выглядит случайным,
 * а это может быть настоящий магазин. Показываю признаки, решает
 * владелец платформы.
 *
 * Запуск:
 *   docker exec tabys-server node scripts/list-shops.js
 */
const { Client } = require('pg');

const деньги = (v) => Math.round(Number(v) || 0)
  .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';

const дата = (d) => (d
  ? new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
  : '—');

(async () => {
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || 'shop_app',
    password: process.env.PGPASSWORD || 'change_me_in_prod',
    database: process.env.PGDATABASE || 'shop',
  });
  await c.connect();

  let магазины = [];
  try {
    магазины = (await c.query(
      `SELECT id, name FROM platform_clients('super', NULL, NULL) ORDER BY name`)).rows;
  } catch {
    магазины = (await c.query(
      `SELECT id, name FROM account WHERE deleted_at IS NULL ORDER BY name`)).rows;
  }

  console.log('');
  console.log('═══ МАГАЗИНЫ: ' + магазины.length + ' ═══');
  console.log('');
  console.log('  ' + 'Магазин'.padEnd(24) + 'Чеков  Выручка      Своих    Заведён  Признак');
  console.log('  ' + '─'.repeat(76));

  const пустые = [];

  for (const м of магазины) {
    await c.query(`SET app.account_id = '${м.id}'`);

    const п = (await c.query(
      `SELECT
         (SELECT count(*) FROM sale WHERE return_of_id IS NULL)::int чеков,
         (SELECT coalesce(sum(total),0) FROM sale WHERE return_of_id IS NULL) выручка,
         /* УЧЕБНЫЕ УЗНАЁМ ПО ИМЕНАМ, а не по пометке.
            Пометку «УЧЕБНЫЙ» завели поздно: у магазинов, заведённых до
            неё, учебные товары лежат БЕЗ пометки — и считались своими.
            Магазин с набранным наугад именем выглядел живым. */
         (SELECT count(*) FROM product WHERE deleted_at IS NULL
            AND coalesce(article,'') <> 'УЧЕБНЫЙ'
            AND replace(name, ' (учебный)', '') NOT IN (
              'Хлеб «Тандыр»','Батон нарезной','Молоко 2,5% 1 л','Айран 0,5 л',
              'Сыр «Российский»','Картофель','Яблоки','Сахар 1 кг',
              'Масло подсолнечное','Вода 1,5 л','Сигареты','Пакет-майка'))::int товаров,
         (SELECT count(*) FROM product WHERE deleted_at IS NULL)::int всего_товаров,
         (SELECT min(created_at) FROM account WHERE id = $1) заведён,
         (SELECT count(*) FROM device WHERE paired_at IS NOT NULL)::int касс`,
      [м.id])).rows[0];

    /* ПРИЗНАК ПРОВЕРОЧНОГО — по делам, а не по имени.
       Магазин без торговли и без своих товаров заводили, чтобы
       посмотреть. Настоящий за день обзаводится хотя бы одним. */
    /* КАССА — ГЛАВНЫЙ ПРИЗНАК ЖИЗНИ.
       Магазин с тремя кассами попал в пустые, хотя кассы заводят,
       когда собираются торговать, и деньги за них уже платят.
       Товаров нет, потому что владелец только начал — это не повод
       записывать его в мусор. */
    const пусто = п.чеков === 0 && п.товаров === 0 && п.касс === 0;
    if (пусто) пустые.push(м.name);

    console.log('  ' + м.name.slice(0, 23).padEnd(24)
      + String(п.чеков).padEnd(7)
      + деньги(п.выручка).padEnd(13)
      + String(п.товаров).padEnd(9)
      + дата(п.заведён).padEnd(9)
      + (пусто ? 'ни торговли, ни товаров, ни касс'
        : (п.чеков === 0 && п.товаров === 0 ? 'касс ' + п.касс + ' — только начал' : '')));
  }

  await c.end();

  console.log('');
  if (!пустые.length) {
    console.log('  Все магазины с делом: пустых нет.');
    console.log('');
    process.exit(0);
  }

  console.log('  ПУСТЫХ: ' + пустые.length + ' — ' + пустые.join(', '));
  console.log('');
  console.log('  Это НЕ приговор: магазин мог завестись вчера и ещё не');
  console.log('  начать торговать. Смотрите на дату и решайте сами.');
  console.log('');
  console.log('  Удалять — из кабинета платформы, карточка клиента.');
  console.log('  Там удаление мягкое и с историей: кто и когда.');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
