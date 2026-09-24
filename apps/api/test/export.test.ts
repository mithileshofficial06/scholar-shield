import { describe, expect, it } from 'vitest';

import { csvCell } from '../src/routes/queue.js';

/**
 * A decision reason is free text typed by a reviewer. It will contain commas,
 * quotation marks and newlines, and a committee's export is evidence — a row
 * that splits across columns silently attributes a reason to the wrong person.
 */
describe('csvCell', () => {
  it('leaves ordinary values alone', () => {
    expect(csvCell('Coimbatore')).toBe('Coimbatore');
    expect(csvCell(46)).toBe('46');
  });

  it('renders null and undefined as empty, not as the word null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes values containing a comma', () => {
    expect(csvCell('Raman, Karthik')).toBe('"Raman, Karthik"');
  });

  it('doubles embedded quotes', () => {
    expect(csvCell('Guardian said "no other income"')).toBe(
      '"Guardian said ""no other income"""',
    );
  });

  it('quotes values containing newlines', () => {
    expect(csvCell('Sibling contradiction.\nVerified by phone.')).toBe(
      '"Sibling contradiction.\nVerified by phone."',
    );
    expect(csvCell('carriage\r\nreturn')).toBe('"carriage\r\nreturn"');
  });

  it('neutralises a value a spreadsheet would evaluate as a formula', () => {
    // The applicant name is typed into a public form and opened in Excel.
    expect(csvCell('=HYPERLINK("http://evil.test","x")')).toBe(
      '"\'=HYPERLINK(""http://evil.test"",""x"")"',
    );
    expect(csvCell('+91 cmd')).toBe("'+91 cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('\t=1')).toBe("'\t=1");
  });

  it('leaves numbers, including negative ones, as numbers', () => {
    expect(csvCell(-45)).toBe('-45');
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(94500)).toBe('94500');
  });
});
