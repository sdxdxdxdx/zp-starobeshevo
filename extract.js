// Извлечение исходных данных для расчёта из книги Excel.
// Работает со строками листа (массив массивов), которые отдаёт sheetToRows.
// В браузере доступен как window.ZpExtract, в Node — через require.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZpExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Что берём с листа точки: подпись в колонке A и колонка по шапке.
  const FIELDS = [
    { key: 'telFact', label: 'Прибыль Тел', col: 'total' },
    { key: 'telPlan', label: 'Прибыль Тел', col: 'plan' },
    { key: 'accFact', label: 'Прибыль акс', col: 'total' },
    { key: 'accPlan', label: 'Прибыль акс', col: 'plan' },
    { key: 'airFact', label: 'Воздух', col: 'total' },
    { key: 'sims.smart', label: 'Смарт М', col: 'total' },
    { key: 'sims.prosto', label: 'Просто М', col: 'total' },
    { key: 'sims.super', label: 'Супер М', col: 'total' },
    { key: 'sims.ultra', label: 'Ультра М', col: 'total' },
    { key: 'sims.mega', label: 'Мега М', col: 'total' },
  ];

  function normalize(value) {
    if (value === null || value === undefined) return '';
    return String(value).toLowerCase().replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  }

  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const s = value.replace(/[\s  ]/g, '').replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
  }

  // Лист SheetJS → строки, начиная с A1. Размер берётся по реальным ячейкам, а не по !ref:
  // отформатированный целиком столбец раздувает !ref до миллиона строк и вешает вкладку.
  // Ячейки с ошибкой формулы (#REF!, #DIV/0!) → null.
  function sheetToRows(XLSX, ws) {
    if (!ws) return [];
    const cells = [];
    let lastRow = -1;
    let lastCol = -1;
    for (const address of Object.keys(ws)) {
      if (address.charAt(0) === '!') continue;
      const { r, c } = XLSX.utils.decode_cell(address);
      cells.push([r, c, ws[address]]);
      lastRow = Math.max(lastRow, r);
      lastCol = Math.max(lastCol, c);
    }
    const rows = Array.from({ length: lastRow + 1 }, () => new Array(lastCol + 1).fill(null));
    for (const [r, c, cell] of cells) rows[r][c] = cell.t === 'e' ? null : cell.v;
    return rows;
  }

  function cellAt(rows, r, c) {
    const row = rows[r];
    return row ? row[c] : undefined;
  }

  // Шапка листа точки: строка, где есть и «Итого:», и «План продаж».
  function findHeader(rows) {
    for (let r = 0; r < rows.length; r++) {
      const norm = Array.from(rows[r] || [], normalize);
      const total = norm.indexOf('итого:');
      const plan = norm.indexOf('план продаж');
      if (total !== -1 && plan !== -1) return { row: r, total, plan };
    }
    return null;
  }

  // Первая строка с такой подписью в диапазоне [from, to).
  function findLabelRow(rows, label, from, to = rows.length) {
    const target = normalize(label);
    for (let r = from; r < to; r++) {
      if (normalize(cellAt(rows, r, 0)) === target) return r;
    }
    return -1;
  }

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let node = obj;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = node[parts[i]] || {};
    node[parts[parts.length - 1]] = value;
  }

  function extractPoint(rows) {
    const header = findHeader(rows);
    if (!header) return null;
    // Личный блок сотрудника начинается строкой с «Итого» в колонке итогов (ФИО — в колонке A).
    const blockStarts = [];
    for (let r = header.row + 1; r < rows.length; r++) {
      if (normalize(cellAt(rows, r, header.total)) === 'итого') blockStarts.push(r);
    }
    // Подписи ищем только в общем блоке точки: в личных блоках те же подписи с цифрами сотрудника.
    const pointEnd = blockStarts.length ? blockStarts[0] : rows.length;
    const values = { sims: {} };
    const missing = [];
    for (const f of FIELDS) {
      const r = findLabelRow(rows, f.label, header.row + 1, pointEnd);
      const value = r === -1 ? null : toNumber(cellAt(rows, r, header[f.col]));
      setPath(values, f.key, value);
      if (value === null) missing.push(f.key);
    }
    const employees = blockStarts
      .map((r) => cellAt(rows, r, 0))
      .filter((name) => typeof name === 'string' && name.trim())
      .map((name) => name.trim());
    const first = cellAt(rows, header.row, 1);
    return { month: first instanceof Date ? nearestDay(first) : null, values, missing, employees };
  }

  // SheetJS 0.18.5 отдаёт дату Excel с отставанием на секунды (01.09 → 31.08 23:59:43),
  // поэтому округляем до ближайшей полуночи по местному времени.
  function nearestDay(date) {
    const extra = date.getHours() >= 12 ? 1 : 0;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + extra);
  }

  function findPointSheets(sheets) {
    return sheets
      .filter((s) => extractPoint(s.rows) !== null && findLabelRow(s.rows, 'Прибыль Тел', 0) !== -1)
      .map((s) => s.name);
  }

  function defaultPoint(names) {
    return names.find((n) => normalize(n).includes('старобешево')) || names[0] || null;
  }

  function tokens(text) {
    return normalize(text).split(/[\s,.]+/).filter((t) => t.length >= 4);
  }

  // Штат факт: строка листа «Штат», в адресе которой есть все слова названия листа точки
  // (от 4 букв). Совпадение по одному городу не считается: ошибка в штате молча меняет +2,5%.
  // Не нашлось или нашлось несколько — null (вводится вручную).
  function extractStaffCount(rows, sheetName) {
    let header = null;
    for (let r = 0; r < rows.length && !header; r++) {
      const norm = Array.from(rows[r] || [], normalize);
      const address = norm.indexOf('адрес');
      const count = norm.indexOf('штат факт');
      if (address !== -1 && count !== -1) header = { row: r, address, count };
    }
    if (!header) return null;
    const wanted = tokens(sheetName);
    if (wanted.length === 0) return null;
    const matches = [];
    for (let r = header.row + 1; r < rows.length; r++) {
      const address = normalize(cellAt(rows, r, header.address));
      if (address && wanted.every((t) => address.includes(t))) matches.push(r);
    }
    if (matches.length !== 1) return null;
    return toNumber(cellAt(rows, matches[0], header.count));
  }

  return { normalize, toNumber, sheetToRows, extractPoint, findPointSheets, defaultPoint, extractStaffCount };
});
