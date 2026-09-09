'use strict';

/**
 * CSV serialisation for the export endpoints.
 *
 * RFC 4180 with the three concessions a real spreadsheet needs, each of which is
 * a bug the first time it is left out:
 *
 *   BOM          Excel on Windows reads a CSV as the system codepage unless the
 *                file opens with a UTF-8 byte order mark. Without it a company
 *                called "Grüber & Co" arrives as "GrÃ¼ber". Every other reader
 *                skips the mark, so it costs nothing.
 *   CRLF         the line ending RFC 4180 specifies, and the one Excel expects.
 *   formula      a leading =, +, - or @ makes a spreadsheet treat the cell as a
 *   neutering    FORMULA rather than text, so a project someone named
 *                `=cmd|'/c calc'!A1` becomes an execution prompt when a
 *                colleague opens the export. Every value in these files is
 *                user-supplied free text — project names, task names, people's
 *                names — so the leader is escaped on the way out.
 *
 * The formula guard is the reason this file exists at all rather than a
 * three-line join(): quoting alone is NOT protection. `"=1+1"` is still parsed
 * as a formula, because the quotes are CSV syntax and the spreadsheet strips
 * them before it looks at the value.
 */

const DELIMITER = ',';
const ROW_SEPARATOR = '\r\n';
const BOM = '\ufeff';

/*
 * The characters a spreadsheet reads as "this cell is code".
 *
 * `-` is on the list even though `-5` is an ordinary negative number: the parser
 * decides on the first character alone, so `-1+1` and `-cmd` take the same path.
 * Tab and carriage return are here because a leading one is stripped before the
 * next character is examined, which is how `\t=1+1` slips past a naive check.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Everything that forces a field to be quoted, per RFC 4180. */
const MUST_QUOTE = /[",\r\n]/;

/**
 * A value as the text a cell should hold.
 *
 * null and undefined both become an empty cell rather than the strings "null"
 * and "undefined" — an unstaffed project has no specialist, and the honest
 * rendering of that is a blank, not a word.
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * One field, escaped.
 *
 * The trim comparison is not cosmetic: a field with leading or trailing spaces
 * has them silently eaten by some readers unless it is quoted, which turns
 * " 001" into "001" and loses the distinction the exporter meant to keep.
 */
function escapeField(value) {
  let text = toText(value);
  if (text === '') return '';

  if (FORMULA_LEADERS.has(text[0])) text = `'${text}`;

  if (MUST_QUOTE.test(text) || text !== text.trim()) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * A header row plus body rows as one CSV document.
 *
 * @param {string[]} headers  the column titles
 * @param {Array<Array>} rows one array per line, same length as `headers`
 */
function toCsv(headers, rows) {
  const lines = [headers.map(escapeField).join(DELIMITER)];
  for (const row of rows ?? []) {
    lines.push(row.map(escapeField).join(DELIMITER));
  }
  // A trailing separator, so the last row is terminated like every other one.
  return `${BOM}${lines.join(ROW_SEPARATOR)}${ROW_SEPARATOR}`;
}

/**
 * A string reduced to what is safe in a filename on every platform.
 *
 * Deliberately aggressive — ASCII letters, digits and hyphens only. A company
 * name reaches this function unfiltered, and a filename is one of the few places
 * where a quote or a semicolon is not merely ugly but changes how the
 * Content-Disposition header parses.
 */
function slugify(value, fallback = 'export') {
  const slug = toText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** Today as YYYY-MM-DD, for stamping a filename. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/*
 * The characters that cannot appear in a filename.
 *
 * The union of what Windows forbids and what breaks a Content-Disposition
 * header, which is nearly the same list: the path separators, the wildcards,
 * the redirection characters, the quote, the colon, and the C0 controls. A
 * colon is on it even though POSIX allows one — a download named
 * "Acme : projects.csv" is silently rewritten by the browser on Windows and
 * macOS, so the server picks the substitute rather than leaving it to chance.
 */
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * A string as a filename a person would recognise.
 *
 * Unlike slugify this KEEPS the spaces, the capitals and the accents, because
 * these two exports are named after things people named — a project, a company —
 * and "Q4 Books Close.csv" is the file they were looking for while
 * "q4-books-close.csv" is a file they have to read twice. Only the characters
 * that a filesystem or the header itself rejects are replaced.
 *
 * Leading dots and trailing dots or spaces are stripped as well: a name
 * beginning with a dot is hidden on POSIX, and Windows quietly drops a trailing
 * one, which would leave the extension attached to a name the server did not
 * choose.
 */
function filenameSafe(value, fallback = 'export') {
  const name = toText(value)
    .replace(UNSAFE_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .replace(/[. ]+$/, '')
    .trim();
  return name || fallback;
}

/**
 * Write a CSV as a download.
 *
 * `filename*=UTF-8''…` is sent alongside the plain `filename=` because the two
 * serve different readers: the quoted form is what an older client understands,
 * the extended form (RFC 5987) is what carries a non-ASCII name intact. Both are
 * built from the slug, so they agree.
 *
 * `nosniff` and `no-store` are not boilerplate here. The first stops a browser
 * from deciding a CSV full of user-supplied text is really HTML and rendering it
 * against this origin; the second keeps a client's project list out of every
 * shared cache between here and them.
 */
function sendCsv(res, { filename, headers, rows }) {
  const body = toCsv(headers, rows);
  const name = `${filenameSafe(filename)}.csv`;
  // The plain parameter is ASCII-only by the same rule projectDocumentController
  // follows: an older client reads it byte for byte, and a header carrying a
  // raw "é" is either mojibake or a parse error depending on who is reading.
  const ascii = `${slugify(filename)}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).send(body);
}

module.exports = {
  DELIMITER,
  ROW_SEPARATOR,
  escapeField,
  toCsv,
  slugify,
  filenameSafe,
  today,
  sendCsv,
};
