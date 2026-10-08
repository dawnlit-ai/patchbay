import { open, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * A workbook an email carries, as CSV for a run whose only file tool is Read,
 * which cannot open one. Each cell reads as the sheet shows it rather than as
 * it is stored — 51% rather than 0.51, a date rather than a count of days —
 * since a rate sheet's figures mean what their format says. Read here with
 * nothing but zlib: the file is from outside, and so is kept to what is needed.
 */

/** The workbooks read here, both a zip of XML parts. `.xls` and `.xlsb` are binary and are not. */
export const WORKBOOK_EXTENSIONS = ['.xlsx', '.xlsm'];

/** A part past this is refused rather than inflated: no real sheet comes near it, and a zip bomb does. */
const MAX_PART_BYTES = 64 * 1024 * 1024;

export interface CsvSheet {
    sheet: string;
    path: string;
    /** Rows holding a value. */
    rows: number;
}

/**
 * Writes each visible sheet of the workbook at `path` beside it as CSV: `rates.csv`
 * for a workbook of one sheet, `rates - Mobile.csv` and so on for more. A name
 * already taken gets a number rather than being written over.
 */
export async function saveWorkbookAsCsv(path: string): Promise<{ sheets: CsvSheet[]; hidden: string[] }> {
    const workbook = readWorkbook(await readFile(path));
    const stem = basename(path, extname(path));
    const one = workbook.sheets.length === 1;
    const sheets: CsvSheet[] = [];
    for (const { name, rows } of workbook.sheets) {
        const file = await writeNew(dirname(path), one ? stem : `${stem} - ${fileSafe(name)}`, '.csv', toCsv(rows));
        sheets.push({ sheet: name, path: file, rows: rows.filter((row) => row.length > 0).length });
    }
    return { sheets, hidden: workbook.hidden };
}

async function writeNew(dir: string, stem: string, extension: string, content: string): Promise<string> {
    for (let n = 1; ; n++) {
        const path = join(dir, `${stem}${n === 1 ? '' : ` (${n})`}${extension}`);
        try {
            const handle = await open(path, 'wx');
            try {
                await handle.writeFile(content, 'utf8');
            } finally {
                await handle.close();
            }
            return path;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
    }
}

function fileSafe(name: string): string {
    return name.replace(/[\\/:*?"<>|\0]/g, '_').trim() || 'sheet';
}

/** Line N is row N and field N is column N, so a figure can be traced to its cell. */
function toCsv(rows: string[][]): string {
    const field = (text: string): string => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    return rows.map((row) => row.map(field).join(',')).join('\n') + '\n';
}

// ── The zip ──────────────────────────────────────────────────────────────

/** A part of the zip by name, inflated, or undefined when there is none. */
type Parts = (name: string) => string | undefined;

function zipParts(file: Buffer): Parts {
    // The directory's end record: 22 bytes, then a comment of up to 64 KB.
    let end = -1;
    for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i--) {
        if (file.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0) {
        // A password-protected workbook is an OLE file with the zip encrypted inside.
        throw new Error(
            file.length >= 4 && file.readUInt32LE(0) === 0xe011cfd0
                ? 'it is protected with a password, or is an .xls under another name'
                : 'it is not a zip, as a workbook is',
        );
    }

    const entries = new Map<string, { method: number; start: number; size: number; declared: number }>();
    let at = file.readUInt32LE(end + 16);
    for (let n = file.readUInt16LE(end + 10); n > 0; n--) {
        if (at + 46 > file.length || file.readUInt32LE(at) !== 0x02014b50) throw new Error('its zip directory is damaged');
        const encrypted = (file.readUInt16LE(at + 8) & 1) === 1;
        const method = file.readUInt16LE(at + 10);
        const size = file.readUInt32LE(at + 20);
        const declared = file.readUInt32LE(at + 24);
        const nameLength = file.readUInt16LE(at + 28);
        const local = file.readUInt32LE(at + 42);
        const name = file.toString('utf8', at + 46, at + 46 + nameLength);
        at += 46 + nameLength + file.readUInt16LE(at + 30) + file.readUInt16LE(at + 32);
        if (encrypted || local + 30 > file.length || file.readUInt32LE(local) !== 0x04034b50) continue;
        const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
        // Part names are case-insensitive in a workbook.
        entries.set(name.toLowerCase(), { method, start, size, declared });
    }

    return (name) => {
        const entry = entries.get(name.toLowerCase());
        if (!entry) return undefined;
        if (entry.declared > MAX_PART_BYTES) throw new Error(`${name} is too large to read`);
        const raw = file.subarray(entry.start, entry.start + entry.size);
        if (entry.method === 0) return raw.toString('utf8');
        if (entry.method !== 8) throw new Error(`${name} is compressed in a way this reader does not know`);
        try {
            // Capped as well, since the size a zip declares is only its say-so.
            return inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES }).toString('utf8');
        } catch {
            throw new Error(`${name} is damaged or too large to read`);
        }
    };
}

// ── The XML ──────────────────────────────────────────────────────────────

/** Any namespace prefix: some writers put every element under `x:`. */
const NS = '(?:[\\w.-]+:)?';

/** Every `tag` element in `xml`: its attributes, and what it holds ('' when it closes itself). */
function elements(xml: string, tag: string): { attrs: string; inner: string }[] {
    const pattern = new RegExp(`<${NS}${tag}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</${NS}${tag}>)`, 'g');
    return Array.from(xml.matchAll(pattern), (m) => ({ attrs: m[1] ?? '', inner: m[2] ?? '' }));
}

/** `name` may be a pattern, for an attribute whose prefix varies. */
function attr(attrs: string, name: string): string | undefined {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
    return m ? unescapeXml(m[1] ?? m[2] ?? '') : undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text: string): string {
    return text.replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (whole, hex?: string, dec?: string, named?: string) => {
        if (named) return ENTITIES[named.toLowerCase()] ?? whole;
        const code = hex ? parseInt(hex, 16) : Number(dec);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

/** A string cell's text: every run of it, less the phonetic guide, with `_x000D_`-style escapes read. */
function stringText(xml: string): string {
    const runs = xml.replace(new RegExp(`<${NS}rPh\\b[\\s\\S]*?</${NS}rPh>`, 'g'), '');
    return elements(runs, 't')
        .map(({ inner }) => unescapeXml(inner))
        .join('')
        .replace(/_x([\da-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ── The workbook ─────────────────────────────────────────────────────────

interface Sheet {
    name: string;
    /** Row N at index N - 1, column N at index N - 1; a row with no value is empty. */
    rows: string[][];
}

function readWorkbook(file: Buffer): { sheets: Sheet[]; hidden: string[] } {
    const parts = zipParts(file);
    const book = relationships(parts, '').find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
    const bookXml = parts(book);
    if (bookXml === undefined) throw new Error('it holds no workbook');

    const related = relationships(parts, book);
    const partOfType = (type: string): string | undefined => {
        const target = related.find((r) => r.type.endsWith(type))?.target;
        return target === undefined ? undefined : parts(target);
    };
    const strings = elements(partOfType('/sharedStrings') ?? '', 'si').map(({ inner }) => stringText(inner));
    const formats = cellFormats(partOfType('/styles') ?? '');
    const date1904 = ['1', 'true'].includes(attr(elements(bookXml, 'workbookPr')[0]?.attrs ?? '', 'date1904') ?? '');

    const sheets: Sheet[] = [];
    const hidden: string[] = [];
    for (const { attrs } of elements(bookXml, 'sheet')) {
        const name = attr(attrs, 'name') ?? '';
        const id = attr(attrs, '[\\w.-]+:id');
        const part = related.find((r) => r.id === id);
        // A chart sheet holds no cells.
        if (!part?.type.endsWith('/worksheet')) continue;
        const state = attr(attrs, 'state');
        if (state === 'hidden' || state === 'veryHidden') {
            hidden.push(name);
            continue;
        }
        const xml = parts(part.target);
        if (xml !== undefined) sheets.push({ name, rows: sheetRows(xml, strings, formats, date1904) });
    }
    return { sheets, hidden };
}

/** What a part links to, by its `_rels` file: resolved to part names. */
function relationships(parts: Parts, part: string): { id: string; type: string; target: string }[] {
    const dir = posix.dirname(part);
    const xml = parts(posix.join(dir, '_rels', `${posix.basename(part)}.rels`)) ?? '';
    return elements(xml, 'Relationship').flatMap(({ attrs }) => {
        const target = attr(attrs, 'Target');
        if (!target || attr(attrs, 'TargetMode') === 'External') return [];
        return [{
            id: attr(attrs, 'Id') ?? '',
            type: attr(attrs, 'Type') ?? '',
            target: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(dir, target)),
        }];
    });
}

/**
 * The formats Excel builds in, which a workbook uses by id without writing out.
 * The currency ones follow the machine's locale in Excel; they are read as dollars.
 */
const BUILT_IN_FORMATS: Record<number, string> = {
    0: 'General',
    1: '0',
    2: '0.00',
    3: '#,##0',
    4: '#,##0.00',
    5: '"$"#,##0_);("$"#,##0)',
    6: '"$"#,##0_);[Red]("$"#,##0)',
    7: '"$"#,##0.00_);("$"#,##0.00)',
    8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
    9: '0%',
    10: '0.00%',
    11: '0.00E+00',
    12: '# ?/?',
    13: '# ??/??',
    14: 'mm-dd-yy',
    15: 'd-mmm-yy',
    16: 'd-mmm',
    17: 'mmm-yy',
    18: 'h:mm AM/PM',
    19: 'h:mm:ss AM/PM',
    20: 'h:mm',
    21: 'h:mm:ss',
    22: 'm/d/yy h:mm',
    37: '#,##0_);(#,##0)',
    38: '#,##0_);[Red](#,##0)',
    39: '#,##0.00_);(#,##0.00)',
    40: '#,##0.00_);[Red](#,##0.00)',
    41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
    42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
    43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
    44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
    45: 'mm:ss',
    46: '[h]:mm:ss',
    47: 'mm:ss.0',
    48: '##0.0E+0',
    49: '@',
};

/** The built-in ids that are East Asian dates, whose codes depend on the locale. */
const isBuiltInDate = (id: number): boolean => (id >= 27 && id <= 36) || (id >= 50 && id <= 58);

/** Each cell style's number format code, by the style index a cell's `s` gives. */
function cellFormats(styles: string): string[] {
    const custom = new Map(
        elements(styles, 'numFmt').map(({ attrs }) => [Number(attr(attrs, 'numFmtId')), attr(attrs, 'formatCode') ?? '']),
    );
    return elements(elements(styles, 'cellXfs')[0]?.inner ?? '', 'xf').map(({ attrs }) => {
        const id = Number(attr(attrs, 'numFmtId') ?? 0);
        return custom.get(id) ?? BUILT_IN_FORMATS[id] ?? (isBuiltInDate(id) ? 'yyyy-mm-dd' : 'General');
    });
}

function sheetRows(xml: string, strings: string[], formats: string[], date1904: boolean): string[][] {
    const rows: string[][] = [];
    let rowNumber = 0;
    for (const row of elements(elements(xml, 'sheetData')[0]?.inner ?? '', 'row')) {
        rowNumber = Number(attr(row.attrs, 'r')) || rowNumber + 1;
        const cells: string[] = [];
        let column = 0;
        for (const cell of elements(row.inner, 'c')) {
            column = columnNumber(attr(cell.attrs, 'r') ?? '') || column + 1;
            const text = cellText(cell.attrs, cell.inner, strings, formats, date1904).trim();
            if (text) cells[column - 1] = text;
        }
        if (cells.length > 0) rows[rowNumber - 1] = cells;
    }
    // Filled in: an empty row keeps its line, an empty cell its column.
    return Array.from(rows, (row) => Array.from(row ?? [], (cell) => cell ?? ''));
}

/** B12 → 2. */
function columnNumber(ref: string): number {
    const letters = /^[A-Z]+/i.exec(ref)?.[0] ?? '';
    return [...letters.toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
}

function cellText(attrs: string, inner: string, strings: string[], formats: string[], date1904: boolean): string {
    const type = attr(attrs, 't') ?? 'n';
    if (type === 'inlineStr') return stringText(elements(inner, 'is')[0]?.inner ?? '');
    const stored = elements(inner, 'v')[0];
    // A formula no program ever calculated holds no value to show.
    if (!stored) return '';
    const value = unescapeXml(stored.inner);
    switch (type) {
        case 's':
            return strings[Number(value)] ?? '';
        case 'str':
            return value.replace(/_x([\da-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        case 'b':
            return value === '1' ? 'TRUE' : 'FALSE';
        case 'e':
        case 'd':
            // An error such as #N/A, or a date already written as ISO 8601.
            return value;
        default: {
            const n = Number(value);
            if (value.trim() === '' || !Number.isFinite(n)) return value;
            return formatNumber(n, formats[Number(attr(attrs, 's') ?? 0)] ?? 'General', date1904);
        }
    }
}

// ── Number formats ───────────────────────────────────────────────────────

/**
 * A number as a format code shows it: its currency sign, grouping, decimals,
 * percent and the words around it. Dates come out as YYYY-MM-DD and times as
 * 24-hour HH:MM, which read one way in every locale, and zero takes the
 * positive section, since an accounting format's lone dash reads as no value.
 */
function formatNumber(n: number, format: string, date1904 = false): string {
    const sections = splitSections(format);
    const signed = n < 0 && sections.length > 1;
    // The negative section shows the sign itself, as a minus or parentheses.
    const section = (signed ? sections[1] : sections[0]) ?? '';
    const value = signed ? -n : n;

    // The code less the text it shows.
    const bare = section.replace(/"[^"]*"|\\.|\[[^\]]*\]|[_*]./g, '').replace(/AM\/PM|A\/P/gi, '');
    if (/general/i.test(bare)) return renderLiterals(section.replace(/general/i, '\u0000')).replace('\u0000', plain(value));
    if (/\[(h+|m+|s+)\]/i.test(section)) return elapsed(n, /s/i.test(bare));
    if (/[ydhsm]/i.test(bare)) return dateTime(n, bare, date1904);
    if (!/[0#?]/.test(bare)) {
        // Text alone, such as "Call", shows as it is; a section left empty hides
        // the number, which is shown all the same.
        const shown = renderLiterals(section).trim();
        return shown && shown !== '@' ? shown : plain(n);
    }
    // A fraction: the same number in decimal, and plainer.
    if (/[0#?]\s*\/\s*[0#?\d]/.test(bare)) return plain(n);
    return renderNumber(value, section);
}

/** A format's `;`-separated sections, a `;` inside quotes or brackets excepted. */
function splitSections(format: string): string[] {
    return format.match(/(?:"[^"]*"|\\.|\[[^\]]*\]|[^;"\\[])+|(?<=^|;)(?=;|$)/g) ?? [format];
}

/** The text a section shows around its number, the placeholder marked by \u0000. */
function renderLiterals(section: string): string {
    let out = '';
    for (let i = 0; i < section.length; i++) {
        const ch = section[i] ?? '';
        if (ch === '"') {
            const close = section.indexOf('"', i + 1);
            out += section.slice(i + 1, close < 0 ? undefined : close);
            i = close < 0 ? section.length : close;
        } else if (ch === '\\') {
            out += section[++i] ?? '';
        } else if (ch === '_' || ch === '*') {
            // Padding as wide as the next character, or a fill: nothing to read.
            i++;
        } else if (ch === '[') {
            const close = section.indexOf(']', i);
            const inner = section.slice(i + 1, close < 0 ? undefined : close);
            // [$€-1809] shows €; [Red], [>=100] and [$-409] show nothing.
            if (inner.startsWith('$')) out += inner.slice(1).split('-')[0] ?? '';
            i = close < 0 ? section.length : close;
        } else {
            out += ch;
        }
    }
    return out;
}

function renderNumber(value: number, section: string): string {
    // The digit placeholders become one run where the first of them stands;
    // everything else is text shown as it is, the % signs included.
    let pattern = '';
    let marked = '';
    for (let i = 0; i < section.length; i++) {
        const ch = section[i] ?? '';
        const next = section[i + 1] ?? '';
        if (ch === '"') {
            const close = section.indexOf('"', i + 1);
            marked += section.slice(i, close < 0 ? undefined : close + 1);
            i = close < 0 ? section.length : close;
        } else if (ch === '\\' || ch === '_' || ch === '*') {
            marked += ch + next;
            i++;
        } else if (ch === '[') {
            const close = section.indexOf(']', i);
            marked += section.slice(i, close < 0 ? undefined : close + 1);
            i = close < 0 ? section.length : close;
        } else if (/[0#?]/.test(ch) || (/[.,]/.test(ch) && (pattern || /[0#?]/.test(next))) || (pattern && /[eE]/.test(ch) && /[+-]/.test(next))) {
            if (!pattern) marked += '\u0000';
            pattern += ch;
            if (/[eE]/.test(ch)) pattern += section[++i] ?? '';
        } else {
            marked += ch;
        }
    }
    const shown = renderLiterals(marked);
    if (!pattern) return shown || plain(value);

    const percent = (shown.match(/%/g) ?? []).length;
    const scale = /[0#?](,+)(?![0#?])/.exec(pattern)?.[1]?.length ?? 0;
    const decimals = /\.([0#?]*)/.exec(pattern)?.[1]?.length ?? 0;
    const scaled = Math.abs(value) * 100 ** percent / 1000 ** scale;

    let digits: string;
    if (/E[+-]/i.test(pattern)) {
        digits = scaled.toExponential(decimals).toUpperCase();
    } else {
        const [whole = '0', fraction] = fixed(scaled, decimals).split('.');
        const grouped = /[0#?],+[0#?]/.test(pattern) ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
        digits = fraction === undefined ? grouped : `${grouped}.${fraction}`;
    }
    return `${value < 0 ? '-' : ''}${shown.replace('\u0000', digits)}`;
}

/** Rounded in decimal, not binary: 1.005 to two places is 1.01, as the sheet shows it. */
function fixed(value: number, decimals: number): string {
    const rounded = Number(`${Math.round(Number(`${value}e${decimals}`))}e-${decimals}`);
    return (Number.isFinite(rounded) ? rounded : value).toFixed(decimals);
}

/** A number with the float noise off it: 0.30000000000000004 is 0.3. */
function plain(value: number): string {
    return String(Number(value.toPrecision(15)));
}

function dateTime(serial: number, code: string, date1904: boolean): string {
    const hasTime = /[hs]/i.test(code);
    // m is minutes beside h or s, and months otherwise.
    const hasDate = /[yd]/i.test(code) || !hasTime;
    // Excel counts 1900 as a leap year, so its days after February 1900 are one ahead.
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const at = new Date(epoch + Math.round(serial * 86_400) * 1000);
    // Past the dates a Date holds, where Excel shows ####.
    if (Number.isNaN(at.getTime())) return plain(serial);
    const iso = at.toISOString();
    const time = /s/i.test(code) ? iso.slice(11, 19) : iso.slice(11, 16);
    return [hasDate ? iso.slice(0, 10) : '', hasTime ? time : ''].filter(Boolean).join(' ');
}

/** [h]:mm — a length of time, which runs past 24 hours. */
function elapsed(days: number, seconds: boolean): string {
    const total = Math.round(Math.abs(days) * 86_400);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const clock = `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}${seconds ? `:${pad(total % 60)}` : ''}`;
    return days < 0 ? `-${clock}` : clock;
}
