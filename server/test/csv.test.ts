import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/lib/csv';

describe('csvCell', () => {
  it('leaves plain text and numbers alone', () => {
    expect(csvCell('Asha Rao')).toBe('Asha Rao');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(null)).toBe('');
  });

  it('quotes fields containing commas, quotes or line breaks', () => {
    expect(csvCell('Rao, Asha')).toBe('"Rao, Asha"');
    expect(csvCell('The "Saturday" crew')).toBe('"The ""Saturday"" crew"');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('neutralises text that a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('toCsv', () => {
  it('joins rows with CRLF and ends with a newline', () => {
    expect(toCsv(['name', 'hours'], [['Asha', 4], ['Ben', 0]])).toBe('name,hours\r\nAsha,4\r\nBen,0\r\n');
  });
});
