/*
 * ПРИВЯЗКА КАССЫ.
 *
 * Владелец заводит кассу в кабинете и получает код. Кассир вводит его
 * здесь — один раз, при установке.
 *
 * ФОРМА НЕ ЗНАЕТ ФОРМАТ КОДА. Их урок дословно:
 *
 *   «Форма НЕ знает формат кода: его выдаёт сервер, и в разных местах
 *    по-разному. Проверка формата на клиенте ДВАЖДЫ ПОДВОДИЛА — сначала
 *    требовала ровно 14 символов, потом префикс DSTR.»
 *
 * У меня это уже случалось: поле принимало только цифры, а код стал
 * TBS-4FE2-3137. Кассир видел цифровую клавиатуру и НЕ МОГ ВВЕСТИ
 * БУКВЫ ВОВСЕ — привязка не прошла бы никогда, а причина пряталась в
 * поле ввода, куда никто не смотрит.
 *
 * Здесь проверяем ровно одно: что не пусто. Решает сервер.
 */

/**
 * Привести код к тому виду, в каком его хранит сервер.
 *
 * ВЕРХНИЙ РЕГИСТР обязателен: кассир диктует код по телефону и пишет
 * как слышит — «tbs-4fe2-3137». Без этого сервер не найдёт код и
 * скажет «не подошёл», хотя код верный, и кассир будет вводить его
 * снова и снова.
 *
 * Пробелы по краям убираем: их приносит вставка из сообщения.
 */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase();
}

/**
 * Привязать кассу.
 *
 * Возвращает то, что нужно хранить: токен устройства и кто мы теперь.
 */
async function pairDevice({ ask, store, settings, code, version }) {
  const clean = normalizeCode(code);
  if (!clean) {
    const e = new Error('Введите код привязки из кабинета');
    e.field = true;      // беда в поле, а не в сервере
    throw e;
  }

  const d = await ask('/pos/pair', {
    settings,
    method: 'POST',
    body: {
      code: clean,
      platform: 'windows',
      appVersion: version || '',
    },
  });

  /* Сервер отвечает по-разному в разных сборках: где deviceToken, где
     token. Берём то, что пришло, а не гадаем — иначе привязка «пройдёт»,
     а токена не будет, и касса начнёт биться в закрытую дверь. */
  const token = d.deviceToken || d.token || d.device_token;
  if (!token) {
    throw new Error('Сервер принял код, но не выдал ключ устройства — '
      + 'позовите владельца, это его сторона');
  }

  return {
    deviceToken: token,
    deviceId: d.deviceId || d.device_id || null,
    accountId: d.accountId || d.account_id || null,
    cashRegisterId: d.cashRegisterId || d.cash_register_id || null,
    storeName: d.storeName || d.store_name || d.name || '',
    // Название кассы рядом с магазином: у клиента их несколько, и
    // кассир должен видеть, за какой стоит — «Мини-маркет · Касса 2».
    registerName: d.registerName || d.register_name || '',
  };
}

/**
 * Сохранить привязку. Отдельно от самой привязки нарочно: сохранение
 * должно быть одним действием, иначе останется полусостояние — токен
 * есть, магазина нет.
 */
async function savePairing(store, pairing) {
  return store.saveState({
    deviceToken: pairing.deviceToken,
    deviceId: pairing.deviceId,
    accountId: pairing.accountId,
    cashRegisterId: pairing.cashRegisterId,
    storeName: pairing.storeName,
    registerName: pairing.registerName,
  });
}

/**
 * ОТВЯЗАТЬ. Зовётся, когда сервер сказал «кассу отвязали в кабинете».
 *
 * Стираем ТОЛЬКО привязку. Чеки, очередь и пропуска не трогаем: в
 * очереди могут лежать неотправленные деньги, и стереть их — потерять
 * выручку.
 */
async function forgetPairing(store) {
  return store.saveState({
    deviceToken: null, deviceId: null,
    accountId: null, cashRegisterId: null, storeName: '',
    employee: null, shift: null,
  });
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeCode, pairDevice, savePairing, forgetPairing };
}
