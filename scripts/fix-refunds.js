/*
 * ВОЗВРАТЫ, КОТОРЫЕ ЛЕГЛИ КАК ПРОДАЖИ.
 *
 * Старая касса слала возврат словом «refund», а ссылку на исходный чек
 * звала «ofReceiptId». Перевод искал другое имя — ссылка терялась, и
 * возврат ложился в продажи с ПОЛОЖИТЕЛЬНОЙ суммой.
 *
 * Выручка от этого ЗАВЫШЕНА: деньги покупателю отданы, а в отчёте они
 * как приход. Владелец заплатит налог с денег, которых не получал.
 *
 * ОПОЗНАЁМ ТОЧНО, А НЕ ПО ДОГАДКЕ. В журнале событие лежит под своим
 * именем — entity = 'refund'. Эта же строка в продажах стоит без
 * ссылки. Совпадение по ключу, а не по сумме.
 *
 * Запуск:
 *   docker exec tabys-server node scripts/fix-refunds.js        смотрит
 *   docker exec tabys-server node scripts/fix-refunds.js --fix  правит
 */
const { Client } = require('pg');

const ЧИНИТЬ = process.argv.includes('--fix');

const деньги = (v) => Math.round(Number(v) || 0)
  .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';

const дата = (d) => (d
  ? new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit' })
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
  console.log('═══ ВОЗВРАТЫ, ЛЕГШИЕ КАК ПРОДАЖИ ═══');

  let всего = 0;
  let сумма = 0;
  let поправлено = 0;
  let деньгиПравда = 0;

  for (const м of магазины) {
    await c.query(`SET app.account_id = '${м.id}'`);

    /* Ищем по ЖУРНАЛУ: событие звалось «refund», а строка в продажах
       стоит без ссылки. Это точное совпадение по ключу. */
    const найдены = (await c.query(
      `SELECT s.id, s.number, s.total, s.created_at,
              /* ССЫЛКУ ИЩЕМ ВСЕМИ ИМЕНАМИ, какими её звали.
                 Очень старая касса звала «returnOf», нынешняя —
                 «ofReceiptId», перевод ставит «refundOf». Смотреть одно
                 имя значит не найти возврат и оставить выручку
                 завышенной, а владелец решит, что таких нет. */
              coalesce(o.payload->>'ofReceiptId',
                       o.payload->>'returnOf',
                       o.payload->>'refundOf') AS исходный,
              coalesce(o.payload->>'ofReceiptNumber',
                       o.payload->>'returnOfNumber') AS номер_исходного,
              o.payload->>'reason' AS причина
         FROM sale s
         JOIN oplog o ON o.entity_id = s.id AND o.entity = 'refund'
        WHERE s.account_id = $1 AND s.return_of_id IS NULL
        ORDER BY s.created_at`, [м.id])).rows;

    if (!найдены.length) continue;

    const деньгиТут = найдены.reduce((a, r) => a + Number(r.total || 0), 0);
    всего += найдены.length;
    сумма += деньгиТут;

    console.log('');
    console.log('  ' + м.name + ': ' + найдены.length + ' на ' + деньги(деньгиТут));

    for (const r of найдены) {
      const метка = `чек №${r.number} · ${деньги(r.total)} · ${дата(r.created_at)}`;

      if (!r.исходный) {
        /* ИСХОДНОГО ЧЕКА НЕ НАЗВАНО. Ставить ссылку наугад нельзя:
           привяжем не к тому чеку — испортим и его. */
        console.log('      ✘ ' + метка + ' — исходный чек не назван, руками');
        continue;
      }

      const есть = (await c.query(
        `SELECT id, number FROM sale WHERE id = $1 AND account_id = $2`,
        [r.исходный, м.id])).rows[0];

      if (!есть) {
        console.log('      ✘ ' + метка + ' — исходный чек №'
          + (r.номер_исходного || '?') + ' не дошёл до сервера');
        continue;
      }

      /* ЦЕПОЧЕК НЕ СТРОИМ.
       *
       * Найдено у «lkndglth»: чек №12 возвращает чек №8, а №8 сам
       * возврат. Выйдет «возврат возврата» — сервер такое прямо
       * запрещает, и обходить его правкой в базе значит завести учёт,
       * которого он не допускает. */
      const целькОн = найдены.some((x) => x.id === r.исходный)
        || (await c.query(
          `SELECT 1 FROM sale WHERE id = $1 AND return_of_id IS NOT NULL`,
          [r.исходный])).rowCount;

      if (целькОн) {
        console.log('      ✘ ' + метка + ' — чек №' + есть.number
          + ' САМ ВОЗВРАТ: возврат возврата не бывает, разберите руками');
        continue;
      }

      if (!ЧИНИТЬ) {
        console.log('      ' + метка + ' → возврат чека №' + есть.number
          + (r.причина ? ' · ' + r.причина : ''));
        continue;
      }

      await c.query(
        `UPDATE sale SET return_of_id = $2 WHERE id = $1 AND account_id = $3`,
        [r.id, r.исходный, м.id]);

      поправлено += 1;
      /* СЧИТАЕМ ТО, ЧТО ВПРАВДУ ПОПРАВИЛИ. Раньше итог называл сумму
         всего найденного, включая нетронутые — владелец сверяет по
         тенге, и врать нельзя. */
      деньгиПравда += Number(r.total || 0);
      console.log('      ✔ ' + метка + ' → возврат чека №' + есть.number);
    }
  }

  await c.end();

  console.log('');
  if (!всего) {
    console.log('═══ ТАКИХ ВОЗВРАТОВ НЕТ ═══');
    console.log('');
    process.exit(0);
  }

  console.log('═══ ВСЕГО: ' + всего + ' на ' + деньги(сумма) + ' ═══');

  if (!ЧИНИТЬ) {
    console.log('');
    console.log('  Поправить: node scripts/fix-refunds.js --fix');
    console.log('');
    console.log('  Это уменьшит выручку на ' + деньги(сумма) + ' — и это');
    console.log('  ВЕРНО: деньги покупателям отданы, приходом они не были.');
    console.log('');
    process.exit(0);
  }

  console.log('  Поправлено: ' + поправлено
    + (поправлено < всего ? ' из ' + всего + ' — остальные названы выше' : ''));
  console.log('');
  console.log('  Выручка уменьшилась на ' + деньги(деньгиПравда) + ' — так и должно');
  console.log('  быть. Проверьте: node scripts/check-receipts.js');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
