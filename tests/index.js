// Node 22 resolves `node --test tests/` as a module path, so this entry loads every *.test.mjs.
const { readdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, f)).href);
}
