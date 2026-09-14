export const CSV_FIELDS = ['studentId', 'givenName', 'surname', 'classLevel', 'room', 'drugAllergies', 'foodAllergies', 'schoolEmail'];
export function parseCsv(text) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('CSV exceeds 1 MiB');
    text = text.replace(/^\uFEFF/, '');
    const rows = []; let row = [], cell = '', quoted = false, closed = false;
    function pushCell() {
        if (cell.length > 2000) throw new Error('Cell exceeds 2000 characters');
        row.push(/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell); cell = ''; closed = false;
    }
    function pushRow() { pushCell(); if (row.some(value => value !== '')) rows.push(row); row = []; if (rows.length > 201) throw new Error('Maximum 200 students per import'); }
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += ch; }
        else if (ch === ',') pushCell();
        else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; pushRow(); }
        else if (ch === '"' && !cell && !closed) quoted = true;
        else if (closed || ch === '"') throw new Error('Malformed CSV quoting');
        else cell += ch;
        if (cell.length > 2001) throw new Error('Cell exceeds 2000 characters');
        if (row.length > CSV_FIELDS.length) throw new Error('Too many columns');
    }
    if (quoted) throw new Error('Unclosed CSV quote');
    if (cell || row.length || closed) pushRow();
    const header = rows.shift();
    if (!header || header.join(',') !== CSV_FIELDS.join(',')) throw new Error('Invalid CSV columns');
    return rows.map((values, i) => {
        if (values.length !== header.length) throw new Error('Wrong column count on record ' + (i + 2));
        return Object.fromEntries(header.map((key, index) => [key, values[index]]));
    });
}
export function exportCsv(rows) {
    const quote = value => {
        let text = String(value ?? '');
        if (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
    };
    return '\uFEFF' + [CSV_FIELDS.join(','), ...rows.map(row => CSV_FIELDS.map(key => quote(row[key])).join(','))].join('\r\n') + '\r\n';
}
