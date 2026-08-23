#!/usr/bin/env node
// Thin launcher — implementation lives in lib/menu.js
const { main } = require('./lib/menu');
main().catch(e => { console.error(e); process.exit(1); });
