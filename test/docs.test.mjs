// The English and Turkish guides must have the same structure: headings, code blocks, table rows
// and command lines. A change in one language needs the same change in the other one.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const en = readdirSync(new URL('docs/en/', root)).sort();
const tr = readdirSync(new URL('docs/tr/', root)).sort();
const pairs = [['README.md', 'README.tr.md'], ...en.map((file, i) => [`docs/en/${file}`, `docs/tr/${tr[i]}`])];

const shape = (text) => ({
  headings: (text.match(/^#{1,6} /gm) ?? []).length,
  codeBlocks: (text.match(/^```/gm) ?? []).length,
  tableRows: (text.match(/^\|/gm) ?? []).length,
  commandLines: (text.match(/^(sudo|gcloud|node|git|cd|npm|curl|echo|ssh)\b/gm) ?? []).length,
});

test('docs/en and docs/tr have the same files', () => {
  assert.equal(en.length, tr.length);
  assert.deepEqual(
    en.map((file) => file.slice(0, 3)),
    tr.map((file) => file.slice(0, 3)),
  );
});

for (const [english, turkish] of pairs) {
  test(`${english} and ${turkish} have the same structure`, () => {
    assert.deepEqual(shape(read(turkish)), shape(read(english)));
  });
}
