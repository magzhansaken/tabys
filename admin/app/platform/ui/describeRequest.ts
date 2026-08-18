/**
 * ЗАЯВКА СЛОВАМИ — по образцу их describeRequest из main.tsx.
 *
 * Их довод виден из кода: «Просит устройство» ничего не говорит
 * владельцу платформы. Он должен видеть, ЧТО именно просят и на каких
 * условиях, не открывая заявку.
 *
 * Отличие по делу: у них устройства ресторанные — экраны кухни,
 * телефоны официантов, курьеры. У магазина их два: касса и точка.
 */
export function describeRequest(kind: string, payload: any): string {
  const p = payload ?? {};

  if (kind === 'device') {
    const what = p.device === 'store' ? 'вторую точку' : 'ещё одну кассу';
    return `Подключить ${what}`;
  }

  if (kind === 'tariff') {
    const name = p.tier === 'base' ? '«Старт»' : '«Стандарт»';
    return `Сменить тариф на ${name}`;
  }

  if (kind === 'grace') {
    const d = Number(p.days) || 7;
    return `Продлить срок на ${d} дн. без оплаты`;
  }

  return 'Прочее';
}
