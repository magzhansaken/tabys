'use client';
/**
 * Настройки: чек-лист запуска, фискализация, оборудование, учёт и доступ,
 * фирменный стиль. Подписка вынесена отдельным разделом — это деньги, куда
 * возвращаются каждый месяц, а не настройка при запуске. Чек-лист — модель онбординга из части 12:
 * владелец видит, что осталось сделать до первого чека.
 *
 * Таблицы разведены по вкладкам: без этого человек не понимает, где
 * находится. Вкладка «Учёт и доступ» новая — туда собраны граница
 * операционного дня и ключи публичного API.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, RevealOnce, Btn, Field, Input, Select,
  confirmDanger, money, dt, MONO, C, ErrLine, Badge } from '../../../lib/ui';

export default function SettingsPage() {
  const [tab, setTab] = useState('onboarding');
  const [onb, setOnb] = useState<any>(null);
  const [fiscal, setFiscal] = useState<any>(null);
  const [readiness, setReadiness] = useState<any[]>([]);
  const [equipment, setEquipment] = useState<any[]>([]);
  const [keys, setKeys] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [dayHour, setDayHour] = useState('0');
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [freshKey, setFreshKey] = useState<any>(null);
  const [keyName, setKeyName] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [brand, setBrand] = useState<any>(null);
  const [adText, setAdText] = useState('');

  const load = async () => {
    try {
      if (tab === 'onboarding') setOnb(await api('/onboarding'));
      if (tab === 'fiscal') { setFiscal(await api('/fiscal/health')); setKeys(await api('/documents/keys/health')); setReadiness(await api('/fiscal/readiness')); }
      if (tab === 'equipment') setEquipment(await api('/equipment'));
      if (tab === 'access') {
        const c = await api('/company/settings');
        setCompany(c); setDayHour(String(c.dayStartHour ?? 0));
        setApiKeys(await api('/api-keys'));
      }
      if (tab === 'branding') {
        const b = await api('/branding');
        setBrand(b); setAdText(b.receiptAdText ?? '');
      }
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { setErr(''); load(); }, [tab]);

  const stepDone = async (code: string) => {
    try { await api(`/onboarding/steps/${code}/complete`, { method: 'POST', body: JSON.stringify({}) }); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const steps: any[] = onb?.steps ?? (Array.isArray(onb) ? onb : []);
  const done = steps.filter((s: any) => s.status === 'done' || s.completed).length;
  const waiting = steps.filter((s: any) => !(s.status === 'done' || s.completed) && s.status !== 'skipped').length;

  const fact = tab === 'onboarding'
    ? (steps.length ? `${done} из ${steps.length} шагов готово${waiting ? ` · осталось ${waiting}` : ''}` : 'Чек-лист загружается…')
    : tab === 'fiscal'
        ? `${readiness.filter((r: any) => r.env === 'production').length} касс в боевом режиме из ${readiness.length}`
        : tab === 'equipment'
          ? `${equipment.length} устройств${equipment.filter((e: any) => !e.online).length ? ` · ${equipment.filter((e: any) => !e.online).length} без связи` : ''}`
          : tab === 'access'
            ? (company ? `День с ${company.dayStartHour}:00 · ${apiKeys.length} ключей API` : 'Загрузка…')
            : 'Логотип и текст на чеке';

  return (
    <>
      <PageHeader title="Настройки" fact={fact} />
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'onboarding', label: 'Чек-лист запуска' },
          { key: 'fiscal', label: 'Фискализация и ЭЦП' },
          { key: 'equipment', label: 'Оборудование' },
          { key: 'access', label: 'Учёт и доступ' },
          { key: 'branding', label: 'Фирменный стиль' },
        ]} />

        {tab === 'onboarding' && (
          <Card title="До первого чека">
            {steps.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
                  <p style={{ fontSize: 13.5, color: C.dim, margin: 0, lineHeight: 1.55, maxWidth: '76ch' }}>
                    Продавать можно и раньше — касса работает. Но пока не подключён оператор
                    фискальных данных, чеки не уходят в налоговую.
                  </p>
                  <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em',
                    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {done} из {steps.length}
                  </div>
                </div>
                <div style={{ height: 6, background: '#EBEBE3', borderRadius: 3, overflow: 'hidden', margin: '16px 0 20px' }}>
                  <div data-bar="" style={{ width: `${Math.round((done / steps.length) * 100)}%`, height: '100%', background: C.accent, borderRadius: 3 }} />
                </div>
              </>
            )}
            <DataTable storageKey="settings" exportName="settings" search={false}
              hint="Пропущенный шаг — не ошибка: к нему можно вернуться в любой момент. Красным ничего не помечаем намеренно."
              empty="Чек-лист загружается…"
              cols={[
                { h: 'Шаг', r: (r) => (
                    <span style={{ color: r.status === 'skipped' ? C.faint : C.text,
                      fontWeight: (r.status === 'done' || r.completed) ? 400 : 600 }}>
                      {r.title ?? r.name ?? r.code}
                    </span>
                  ) },
                { h: 'Статус', r: (r) => r.status === 'done' || r.completed
                    ? <Badge tone="ok">готово</Badge>
                    : r.status === 'skipped' ? <Badge tone="dim">пропущен</Badge> : <Badge tone="warn">ожидает</Badge> },
                { h: '', r: (r) => (r.status === 'done' || r.completed) ? null
                    : <Btn kind="ghost" onClick={() => stepDone(r.code)}>Отметить готовым</Btn> },
              ]}
              rows={steps} />
          </Card>
        )}

        {tab === 'fiscal' && (
          <>
            <Card title="Фискализация (WebKassa/ReKassa)">
              {fiscal ? (
                <div style={{ fontSize: 14, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                  {(fiscal.ok ?? fiscal.healthy) ? <Badge tone="ok">Связь в порядке</Badge> : <Badge tone="warn">{fiscal.message ?? 'ККМ не подключены'}</Badge>}
                  {fiscal.queued != null && <span style={{ color: C.dim }}>В очереди чеков: <b style={{ color: C.text }}>{fiscal.queued}</b></span>}
                  {fiscal.failed != null && Number(fiscal.failed) > 0 && <span style={{ color: C.red, fontWeight: 600 }}>Ошибок: {fiscal.failed}</span>}
                </div>
              ) : 'Загрузка…'}
              <p style={{ fontSize: 13.5, color: C.prose, margin: '14px 0 0', lineHeight: 1.6, maxWidth: '84ch' }}>
                Чеки, пробитые без интернета, фискализируются, когда связь появится.
                Продажа в долг не фискализируется — деньги ещё не получены, и налоговой
                показывать нечего. Для боевой работы нужны договор с оператором и
                регистрация ККМ в КГД, это в чек-листе запуска.
              </p>
            </Card>

            <Card title="Боевой режим касс" style={{ marginTop: 14 }}>
              <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '84ch' }}>
                В тестовом режиме чеки оператору не уходят. Кнопка «В боевой режим»
                неактивна намеренно, пока не внесены РНМ и ЗНМ (получите в Кабинете
                налогоплательщика) и не прошла проверка связи.
              </p>
              <DataTable storageKey="settings-4" exportName="settings-4" search={false}
                hint="Колонки «Ключи» и «РНМ/ЗНМ» отвечают на вопрос «почему кнопка неактивна»: красный прочерк и есть причина."
                empty="Кассы с фискализацией не настроены. Сначала договор с оператором фискальных данных и регистрация ККМ в КГД — это в чек-листе запуска" cols={[
                    { h: 'Касса', k: 'cashRegister' },
                    { h: 'Оператор', k: 'provider' },
                    { h: 'Режим', r: (r: any) => r.env === 'production'
                        ? <Badge tone="ok">боевой</Badge> : <Badge tone="dim">тест</Badge> },
                    { h: 'Ключи', r: (r: any) => r.hasCredentials
                        ? <span style={{ color: C.accent }}>✓</span> : <span style={{ color: C.red, fontWeight: 600 }}>—</span> },
                    { h: 'РНМ/ЗНМ', r: (r: any) => r.hasRegNumber
                        ? <span style={{ color: C.accent }}>✓</span> : <span style={{ color: C.red, fontWeight: 600 }}>—</span> },
                    { h: 'Связь', r: (r: any) => r.connectionOk
                        ? <Badge tone="ok">есть</Badge> : <Badge tone="warn">не проверена</Badge> },
                    { h: '', r: (r: any) => (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Btn kind="ghost" onClick={async () => {
                          setErr(''); setMsg('');
                          try { const res = await api('/fiscal/check-connection', { method: 'POST', body: JSON.stringify({ kkmId: r.kkmId }) });
                            setMsg(res.message); load(); } catch (e: any) { setErr(e.message); }
                        }}>Проверить связь</Btn>
                        {r.env !== 'production'
                          ? <Btn onClick={async () => {
                              setErr(''); setMsg('');
                              if (!confirmDanger(`Перевести «${r.cashRegister}» в боевой режим?`,
                                'С этого момента чеки уходят оператору фискальных данных и попадают в налоговую. Тестовые чеки больше пробивать нельзя.')) return;
                              try { const res = await api('/fiscal/set-env', { method: 'POST', body: JSON.stringify({ kkmId: r.kkmId, env: 'production' }) });
                                setMsg(res.message); load(); } catch (e: any) { setErr(e.message); }
                            }} disabled={!r.readyForProduction}>В боевой режим</Btn>
                          : <Btn kind="ghost" style={{ color: C.dim }} onClick={async () => {
                              if (!confirmDanger(`Вернуть «${r.cashRegister}» в тестовый режим?`,
                                'Чеки перестанут уходить в налоговую. Реальные продажи в тестовом режиме — нарушение.')) return;
                              await api('/fiscal/set-env', { method: 'POST', body: JSON.stringify({ kkmId: r.kkmId, env: 'test' }) }); load();
                            }}>В тест</Btn>}
                      </div>
                    ) },
                  ]} rows={readiness} />
            </Card>

            <Card title="ЭЦП для счетов-фактур" style={{ marginTop: 14 }}>
              <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '84ch' }}>
                Ключ нужен только для выписки ЭСФ. Истёкшим ключом счёт-фактуру не
                подписать — обновляйте в НУЦ РК заранее, это занимает день. Узнаётся
                обычно в тот момент, когда оптовый клиент просит счёт.
              </p>
              {keys ? (
                <DataTable storageKey="settings-5" exportName="settings-5" search={false}
                  hint="Ключ выдаётся на год и истекает тихо. Заглядывайте сюда раз в месяц, а не в день, когда понадобилась СФ."
                  empty="Ключи не загружены. Они нужны только для выписки счетов-фактур — розничной торговле обычно не требуются" cols={[
                      { h: 'Ключ', r: (r: any) => r.name ?? r.owner ?? '—' },
                      { h: 'Действует до', r: (r: any) => r.expires_at
                          ? <span style={{ color: r.expired ? C.red : C.text, fontWeight: r.expired ? 600 : 400, whiteSpace: 'nowrap' }}>
                              {new Date(r.expires_at).toLocaleDateString('ru-RU')}
                            </span>
                          : <span style={{ color: C.faint }}>—</span> },
                      { h: 'Статус', r: (r: any) => r.expired ? <Badge tone="bad">истёк</Badge> : <Badge tone="ok">действует</Badge> },
                  ]} rows={Array.isArray(keys) ? keys : keys.keys ?? []} />
              ) : 'Загрузка…'}
            </Card>
          </>
        )}

        {tab === 'equipment' && (
          <Card title="Весы, принтеры, дисплеи">
            <DataTable storageKey="settings-6" exportName="settings-6"
              hint="Если сетевое устройство «не отвечает», сначала проверьте, что касса и оно в одной сети — это причина в девяти случаях из десяти."
              empty="Оборудование не добавлено. Весы Rongta и принтеры Xprinter подключаются по сети — см. документацию."
              cols={[
                { h: 'Название', k: 'name' },
                { h: 'Тип', k: 'kind' },
                { h: 'Адрес', r: (r) => r.ip
                    ? <span style={{ fontFamily: MONO, fontSize: 13, whiteSpace: 'nowrap' }}>{r.ip}:{r.port ?? ''}</span>
                    : <span style={{ color: C.faint }}>—</span> },
                { h: 'Состояние', r: (r) => r.online ? <Badge tone="ok">на связи</Badge> : <Badge tone="dim">не проверялось</Badge> },
              ]}
              rows={equipment} />
          </Card>
        )}

        {tab === 'access' && (
          <>
            <Card title="Граница операционного дня">
              <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.6, maxWidth: '84ch' }}>
                С какого часа начинается «день» в отчётах. Магазину подходит полночь.
                Если смена закрывается в час ночи, при полуночной границе выручка
                разъезжается по двум дням, и отчёт «за вчера» не сходится с деньгами
                в кассе.
              </p>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
                <Field label="День начинается в">
                  <Select value={dayHour} onChange={(e: any) => setDayHour(e.target.value)}
                    options={Array.from({ length: 24 }, (_, h) => ({
                      value: String(h),
                      label: h === 0 ? '00:00 — полночь (магазин)'
                        : h === 6 ? '06:00 — утро (общепит, круглосуточные)'
                        : `${String(h).padStart(2, '0')}:00`,
                    }))} />
                </Field>
                <Btn onClick={async () => {
                  setErr(''); setMsg('');
                  if (!confirmDanger(`Сдвинуть начало дня на ${dayHour}:00?`,
                    'Уже показанные отчёты изменятся: ночные продажи перейдут в предыдущий день. Числа за прошлые месяцы станут другими — это правильно, но предупредите бухгалтера.')) return;
                  try { const r = await api('/company/day-start', { method: 'PATCH', body: JSON.stringify({ hour: Number(dayHour) }) });
                    setMsg(r.note); load(); }
                  catch (e: any) { setErr(e.message); }
                }}>Сохранить</Btn>
              </div>
              {company?.dayStartHint && (
                <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', marginTop: 18,
                  background: C.sunken, border: `1px solid ${C.lineIn}`, borderRadius: 10, padding: '13px 15px' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.accent, flex: '0 0 7px', marginTop: 7 }} />
                  <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.55 }}>{company.dayStartHint}</div>
                </div>
              )}
            </Card>

            <Card title="Ключи публичного API" style={{ marginTop: 14 }}>
              <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.6, maxWidth: '84ch' }}>
                Ключ выдаётся программе — бухгалтерской, сайту, доставке — вместо вашего
                пароля. Пароль даёт всё, включая смену тарифа и удаление данных; ключ
                ограничен правами и отзывается одной кнопкой.
              </p>

              {freshKey && (
                <div style={{ margin: '18px 0' }}>
                  <RevealOnce
                    title={`Ключ «${freshKey.name ?? 'новый'}» создан. Скопируйте его сейчас`}
                    value={freshKey.key ?? freshKey.token ?? freshKey.apiKey ?? ''}
                    note="Мы храним только отпечаток ключа, как пароль. Подсмотреть его потом не сможем ни мы, ни вы: если потеряете — выдадим новый, а этот придётся отозвать."
                  />
                  <div style={{ marginTop: 10 }}>
                    <Btn kind="ghost" onClick={() => setFreshKey(null)}>Скопировал, закрыть</Btn>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
                <Field label="Для какой программы">
                  <Input placeholder="Например: 1С, сайт магазина" value={keyName} onChange={(e: any) => setKeyName(e.target.value)} w={280} />
                </Field>
                <Btn disabled={!keyName.trim()} onClick={async () => {
                  setErr(''); setMsg('');
                  try { const r = await api('/api-keys', { method: 'POST', body: JSON.stringify({ name: keyName.trim() }) });
                    setFreshKey({ ...r, name: r.name ?? keyName.trim() }); setKeyName(''); load(); }
                  catch (e: any) { setErr(e.message); }
                }}>Создать ключ</Btn>
              </div>

              <DataTable storageKey="settings-7" exportName="settings-7" search={false}
                hint="Забытый ключ — это дверь, о которой никто не помнит. Смотрите на «Последний вызов»: если ключ молчит месяцами, отзовите его."
                empty="Ключей нет. Создавайте отдельный ключ на каждую программу — тогда отзыв одного не сломает остальные"
                cols={[
                  { h: 'Название', k: 'name' },
                  { h: 'Ключ', r: (r: any) => (
                      <span style={{ fontFamily: MONO, fontSize: 13, whiteSpace: 'nowrap', color: C.dim }}>
                        {r.prefix ?? r.masked ?? '••••'}
                      </span>
                    ) },
                  { h: 'Права', r: (r: any) => Array.isArray(r.scopes) ? r.scopes.join(', ') : (r.scopes ?? '—') },
                  { h: 'Последний вызов', r: (r: any) => r.last_used_at
                      ? dt(r.last_used_at)
                      : <span style={{ color: C.faint }}>ни разу</span> },
                  { h: 'Статус', r: (r: any) => r.revoked_at
                      ? <Badge tone="dim">{r.status ?? 'отозван'}</Badge>
                      : <Badge tone="ok">{r.status ?? 'работает'}</Badge> },
                  { h: '', r: (r: any) => r.revoked_at ? null : (
                      <Btn kind="danger" onClick={async () => {
                        if (!confirmDanger(`Отозвать ключ «${r.name}»?`,
                          'Программа, которая им пользуется, перестанет работать сразу. Вернуть этот ключ нельзя — только выдать новый и прописать его заново.')) return;
                        try { await api(`/api-keys/${r.id}`, { method: 'DELETE' }); load(); }
                        catch (e: any) { setErr(e.message); }
                      }}>Отозвать</Btn>
                    ) },
                ]} rows={apiKeys} />
            </Card>
          </>
        )}

        {tab === 'branding' && (
          <Card title="Логотип и чек">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '84ch' }}>
              Один логотип — и на чеке, и в документах. PNG или JPG до 500 КБ.
              Для чека мы сами переведём картинку в чёрно-белый растр нужной ширины —
              на кассе настраивать нечего.
            </p>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 18 }}>
              <div>
                {brand?.logo
                  ? <img src={brand.logo} alt="логотип" style={{ maxWidth: 220, maxHeight: 120, border: `1px solid ${C.line}`, borderRadius: 10, background: '#fff', padding: 6 }} />
                  : <div style={{ width: 220, height: 120, border: `1.5px dashed #C9C9BE`, borderRadius: 10, display: 'grid', placeItems: 'center', color: C.faint, fontSize: 13 }}>Логотипа нет</div>}
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }}
                      onChange={async (e: any) => {
                        const f = e.target.files?.[0]; if (!f) return;
                        setErr(''); setMsg('');
                        if (f.size > 500 * 1024) { setErr(`Файл ${Math.round(f.size/1024)} КБ — больше 500 КБ`); return; }
                        const b64: string = await new Promise((res, rej) => {
                          const r = new FileReader();
                          r.onload = () => res(String(r.result).split(',')[1]);
                          r.onerror = () => rej(new Error('Не удалось прочитать файл'));
                          r.readAsDataURL(f);
                        });
                        try {
                          const r = await api('/branding/logo', { method: 'POST',
                            body: JSON.stringify({ base64: b64, mime: f.type, printerWidth: 384 }) });
                          setMsg(`Логотип загружен, для чека — ${r.receiptLogo.width}×${r.receiptLogo.height} точек`);
                          load();
                        } catch (e: any) { setErr(e.message); }
                      }} />
                    <span style={{ display: 'inline-flex', alignItems: 'center', minHeight: 38, border: `1px solid #D8D8CF`,
                      borderRadius: 8, padding: '0 15px', fontSize: 14, background: C.card }}>Загрузить логотип</span>
                  </label>
                  {brand?.logo && <Btn kind="ghost" onClick={async () => {
                    if (!confirmDanger('Убрать логотип?', 'Чеки начнут печататься без него после ближайшей синхронизации касс. Файл придётся загрузить заново.')) return;
                    await api('/branding/logo/clear', { method: 'POST' }); load();
                  }}>Убрать</Btn>}
                </div>
                {brand?.hasReceiptLogo && (
                  <p style={{ fontSize: 12.5, color: C.dim, marginTop: 10, lineHeight: 1.5, maxWidth: 230 }}>
                    Для чека готов растр {brand.receiptLogoSize?.width}×{brand.receiptLogoSize?.height} —
                    кассы получат его при следующей синхронизации.
                  </p>
                )}
              </div>

              <div style={{ minWidth: 280, flex: 1 }}>
                <Field label="Рекламный текст на чеке (до 200 символов)">
                  <textarea value={adText} onChange={(e: any) => setAdText(e.target.value)}
                    maxLength={200}
                    placeholder="Рахмет! Молочный вторник — кешбэк 7%"
                    style={{ width: '100%', minHeight: 84, padding: '11px 13px', border: `1px solid #D8D8CF`,
                      borderRadius: 8, fontSize: 16, fontFamily: 'inherit', color: C.text,
                      lineHeight: 1.5, boxSizing: 'border-box', outline: 'none', resize: 'vertical' }} />
                </Field>
                <div style={{ fontSize: 12.5, color: C.faint, marginTop: 6 }}>
                  {adText.length} из 200 символов · печатается внизу чека по центру
                </div>
                <Btn style={{ marginTop: 12 }} onClick={async () => {
                  setErr(''); setMsg('');
                  try { await api('/branding/ad-text', { method: 'POST', body: JSON.stringify({ text: adText }) });
                    setMsg('Текст сохранён — появится на чеках после синхронизации касс'); load(); }
                  catch (e: any) { setErr(e.message); }
                }}>Сохранить текст</Btn>
                <p style={{ fontSize: 13, color: C.dim, marginTop: 14, lineHeight: 1.6 }}>
                  Строка сама переносится по ширине ленты. Долг и бонусы печатаются на
                  чеке отдельно и всегда — покупателю не приходится верить на слово.
                </p>
              </div>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
