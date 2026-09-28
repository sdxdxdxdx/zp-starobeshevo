// Интерфейс калькулятора ЗП: загрузка xlsx, форма исходных данных, вывод расчёта.
(function () {
  'use strict';

  const { compute, marginPreview, TARIFFS } = window.ZpCalc;
  const X = window.ZpExtract;

  const SALARY_KEY = 'zp.salary';
  const DEFAULT_SALARY = 32600;
  const FIELD_LABELS = {
    telFact: 'маржа тел (факт)', telPlan: 'маржа тел (план)',
    accFact: 'маржа акс (факт)', accPlan: 'маржа акс (план)',
    airFact: 'воздух', staffCount: 'сотрудников в штате',
  };
  for (const t of TARIFFS) FIELD_LABELS['sims.' + t.key] = t.label;

  let sheets = [];      // [{ name, rows }] загруженной книги
  let staffRows = [];   // строки листа «Штат»
  let touched = false;  // пока нет файла и ввода, ошибки не показываем

  const $ = (selector) => document.querySelector(selector);

  function money(n) { return Number(n).toLocaleString('ru-RU'); }
  function pct(rate) { return (rate / 10).toLocaleString('ru-RU') + '%'; }
  function percentText(p) { return p.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%'; }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    const list = children === undefined || children === null ? [] : [].concat(children);
    for (const child of list) node.append(child instanceof Node ? child : String(child));
    return node;
  }

  function status(text, bad) {
    const node = $('#load-status');
    node.textContent = text;
    node.classList.toggle('status-bad', Boolean(bad));
  }

  function readSalary() {
    try {
      const saved = X.toNumber(localStorage.getItem(SALARY_KEY));
      return saved === null ? DEFAULT_SALARY : saved;
    } catch (e) {
      return DEFAULT_SALARY;
    }
  }

  function saveSalary(value) {
    try {
      if (value !== null) localStorage.setItem(SALARY_KEY, String(value));
    } catch (e) {
      // хранилище недоступно — оклад просто не запомнится
    }
  }

  function setField(key, value) {
    $(`[data-field="${key}"]`).value = value === null || value === undefined ? '' : String(value);
  }

  function addEmployee(name) {
    const tr = el('tr', null, [
      el('td', null, el('input', { value: name || '' })),
      el('td', null, el('input', { inputMode: 'decimal' })),
      el('td', null, el('input', { inputMode: 'decimal', placeholder: '0' })),
      el('td', null, el('input', { inputMode: 'decimal', placeholder: '0' })),
      el('td', { className: 'no-print' }, el('button', { type: 'button', title: 'Удалить', textContent: '✕' })),
    ]);
    ['name', 'shifts', 'fine', 'advance'].forEach((key, i) => {
      tr.querySelectorAll('input')[i].dataset.emp = key;
    });
    tr.querySelector('button').addEventListener('click', () => {
      tr.remove();
      recalc();
    });
    $('#emp-table tbody').append(tr);
  }

  function readInput() {
    const data = { sims: {} };
    for (const input of document.querySelectorAll('[data-field]')) {
      const key = input.dataset.field;
      const value = X.toNumber(input.value);
      if (key.startsWith('sims.')) data.sims[key.slice(5)] = value;
      else data[key] = value;
    }
    const orZero = (text) => (text.trim() === '' ? 0 : X.toNumber(text));
    data.employees = Array.from(document.querySelectorAll('#emp-table tbody tr'), (tr) => {
      const get = (key) => tr.querySelector(`[data-emp="${key}"]`).value;
      return {
        name: get('name').trim(),
        shifts: X.toNumber(get('shifts')),
        fine: orZero(get('fine')),
        advance: orZero(get('advance')),
      };
    });
    return data;
  }

  function highlight(field) {
    let node = null;
    const m = /^employees\.(\d+)\.(\w+)$/.exec(field);
    if (m) {
      const tr = document.querySelectorAll('#emp-table tbody tr')[Number(m[1])];
      node = tr && tr.querySelector(`[data-emp="${m[2]}"]`);
    } else if (field === 'employees') {
      node = $('#emp-table');
    } else {
      node = $(`[data-field="${field}"]`);
    }
    if (node) node.classList.add('invalid');
  }

  function renderBonusNote(staffCount) {
    $('#bonus-note').textContent = staffCount >= 3
      ? 'В штате 3+ человека: к ставкам тел и акс добавляется +2,5%.'
      : 'В штате меньше 3 человек: +2,5% не добавляется.';
  }

  // Процент выполнения и ставка прямо у полей факта/плана — видны до ввода смен.
  function renderMarginNotes(input) {
    for (const kind of ['tel', 'acc']) {
      const p = marginPreview(kind, input[kind + 'Fact'], input[kind + 'Plan'], input.staffCount);
      $(`#${kind}-note`).textContent = p ? `Выполнено ${percentText(p.percent)} → ставка ${pct(p.rate)}` : '';
    }
  }

  function stepRows(r) {
    const margin = (x) => `${money(x.fact)} × ${pct(x.rate)} (план ${money(x.plan)}, выполнено ${percentText(x.percent)})`;
    const simParts = r.sims.filter((s) => s.count > 0).map((s) => `${s.label} ${money(s.count)} × ${money(s.rate)}`);
    return [
      ['Премия за телефоны', margin(r.tel), r.tel.premium],
      ['Премия за аксессуары', margin(r.acc), r.acc.premium],
      ['Премия за воздух', `${money(r.air.fact)} × ${pct(r.air.rate)}`, r.air.premium],
      ['Премия за симки', simParts.join(' + ') || 'продаж нет', r.simsTotal],
      ['Премия всего', [r.tel.premium, r.acc.premium, r.air.premium, r.simsTotal].map(money).join(' + '), r.premiumTotal],
      ['Премия после НДФЛ 13%', `${money(r.premiumTotal)} × 0,87, без копеек`, r.premiumNet],
      ['Всего смен', r.employees.map((e) => money(e.shifts)).join(' + '), r.totalShifts],
      ['Премия за смену', `${money(r.premiumNet)} ÷ ${money(r.totalShifts)}, без копеек`, r.premiumPerShift],
      ['Оклад после НДФЛ 13%', `${money(r.salary)} × 0,87, без копеек`, r.salaryNet],
      ['Оклад за смену', `${money(r.salaryNet)} ÷ ${money(r.totalShifts)}, без копеек`, r.salaryPerShift],
      ['Итого за смену', `${money(r.premiumPerShift)} + ${money(r.salaryPerShift)}`, r.perShift],
    ];
  }

  function renderSteps(r) {
    const body = el('tbody', null, stepRows(r).map((s, i) => el('tr', null, [
      el('td', null, i + 1),
      el('td', null, s[0]),
      el('td', { className: 'formula' }, s[1]),
      el('td', { className: 'num total' }, money(s[2])),
    ])));
    $('#steps').replaceChildren(el('div', { className: 'table-wrap' }, el('table', { className: 'steps' }, body)));
  }

  function renderPayout(r) {
    const titles = ['ФИО', 'Смены', 'Начислено', 'Штраф', 'Аванс', 'К выплате'];
    const head = el('thead', null, el('tr', null, titles.map((t, i) => el('th', { className: i ? 'num' : '' }, t))));
    const body = el('tbody', null, r.employees.map((e) => el('tr', null, [
      el('td', null, e.name),
      el('td', { className: 'num' }, money(e.shifts)),
      el('td', { className: 'num' }, money(e.earned)),
      el('td', { className: 'num' }, money(e.fine)),
      el('td', { className: 'num' }, money(e.advance)),
      el('td', { className: 'num total' + (e.pay < 0 ? ' negative' : '') }, money(e.pay)),
    ])));
    const sum = r.employees.reduce((s, e) => s + e.pay, 0);
    const foot = el('tfoot', null, el('tr', null, [
      el('td', { className: 'total', colSpan: 5 }, 'Всего к выплате'),
      el('td', { className: 'num total' }, money(sum)),
    ]));
    $('#payout').replaceChildren(
      el('h3', null, 'К выплате'),
      el('div', { className: 'table-wrap' }, el('table', null, [head, body, foot])),
    );
  }

  function recalc() {
    document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
    const input = readInput();
    renderBonusNote(input.staffCount);
    renderMarginNotes(input);
    const r = compute(input);
    if (!r.ok) {
      $('#steps').replaceChildren();
      $('#payout').replaceChildren();
      if (!touched) {
        $('#errors').replaceChildren(el('p', { className: 'muted' }, 'Загрузите файл месяца или заполните поля вручную.'));
        return;
      }
      r.errors.forEach((e) => highlight(e.field));
      $('#errors').replaceChildren(el('ul', { className: 'errors' }, r.errors.map((e) => el('li', null, e.message))));
      return;
    }
    $('#errors').replaceChildren();
    renderSteps(r);
    renderPayout(r);
  }

  function monthTitle(date) {
    const text = date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function applyPoint(name) {
    const sheet = sheets.find((s) => s.name === name);
    const point = X.extractPoint(sheet.rows);
    for (const key of ['telFact', 'telPlan', 'accFact', 'accPlan', 'airFact']) setField(key, point.values[key]);
    for (const t of TARIFFS) setField('sims.' + t.key, point.values.sims[t.key]);
    const staff = X.extractStaffCount(staffRows, name);
    setField('staffCount', staff);

    $('#emp-table tbody').replaceChildren();
    point.employees.forEach((employee) => addEmployee(employee));
    if (point.employees.length === 0) addEmployee('');

    $('#month').textContent = (point.month ? monthTitle(point.month) + ' · ' : '') + name;
    const missing = point.missing.concat(staff === null ? ['staffCount'] : []);
    if (missing.length) {
      status('Не нашёл в файле: ' + missing.map((k) => FIELD_LABELS[k]).join(', ') + '. Заполните вручную.', true);
    } else {
      status('Данные загружены. Введите смены сотрудников.', false);
    }
    touched = true;
    recalc();
  }

  // После неудачной загрузки не оставляем на экране (и в печати) цифры прошлого файла.
  function resetLoaded() {
    sheets = [];
    staffRows = [];
    $('#point').replaceChildren();
    $('#point').disabled = true;
    $('#month').textContent = '';
    for (const input of document.querySelectorAll('[data-field]')) {
      if (input.dataset.field !== 'salary') input.value = '';
    }
    $('#emp-table tbody').replaceChildren();
    addEmployee('');
    touched = false;
    recalc();
  }

  function loadWorkbook(wb) {
    const loaded = wb.SheetNames.map((name) => ({ name, rows: X.sheetToRows(XLSX, wb.Sheets[name]) }));
    const names = X.findPointSheets(loaded);
    if (names.length === 0) {
      resetLoaded();
      status('В файле нет листа точки: не найдена шапка «Итого:» / «План продаж».', true);
      return;
    }
    sheets = loaded;
    const staffSheet = sheets.find((s) => X.normalize(s.name) === 'штат');
    staffRows = staffSheet ? staffSheet.rows : [];
    const select = $('#point');
    select.replaceChildren(...names.map((n) => el('option', { value: n, textContent: n })));
    select.disabled = false;
    select.value = X.defaultPoint(names);
    applyPoint(select.value);
  }

  $('#file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      status('Не загрузилась библиотека чтения Excel — нужен интернет.', true);
      return;
    }
    try {
      loadWorkbook(XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true }));
    } catch (err) {
      resetLoaded();
      status('Не удалось прочитать файл: ' + err.message, true);
    }
  });

  document.addEventListener('input', (event) => {
    if (!event.target.matches('input[data-field], input[data-emp]')) return;
    touched = true;
    if (event.target.dataset.field === 'salary') saveSalary(X.toNumber(event.target.value));
    recalc();
  });

  $('#point').addEventListener('change', (event) => applyPoint(event.target.value));
  $('#add-emp').addEventListener('click', () => {
    addEmployee('');
    recalc();
  });
  $('#print').addEventListener('click', () => window.print());

  setField('salary', readSalary());
  addEmployee('');
  recalc();

  window.zpApp = { loadWorkbook };
})();
