// Convert CDISCPILOT01 CSV files to a single JSON for embedding in the Vite build
import { readFileSync, writeFileSync } from 'fs';

function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuote = false;
  
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === '\n' && !inQuote) {
      if (current.trim()) lines.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current.trim());

  if (lines.length === 0) return [];
  
  const parseRow = (line) => {
    const fields = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { field += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        fields.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field);
    return fields;
  };

  const headers = parseRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseRow(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      let val = (vals[j] || '').trim();
      // Clean multi-line values
      val = val.replace(/\s+/g, ' ');
      // Convert numeric-looking values
      if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
      obj[headers[j].trim()] = val;
    }
    rows.push(obj);
  }
  return rows;
}

const ae = parseCSV(readFileSync(new URL('./ae.csv', import.meta.url), 'utf-8'));
const dm = parseCSV(readFileSync(new URL('./dm.csv', import.meta.url), 'utf-8'));
const cm = parseCSV(readFileSync(new URL('./cm.csv', import.meta.url), 'utf-8'));

// Filter DM to only safety population (SAFFL=Y, exclude screen failures)
const dmSafe = dm.filter(r => r.SAFFL === 'Y');

const pilotData = { AE: ae, DM: dmSafe, CM: cm };

const json = JSON.stringify(pilotData);
writeFileSync(new URL('../src/pilotData.json', import.meta.url), json);

console.log(`AE: ${ae.length} rows, DM: ${dmSafe.length} rows, CM: ${cm.length} rows`);
console.log(`Output: ${(json.length / 1024).toFixed(1)}KB`);
