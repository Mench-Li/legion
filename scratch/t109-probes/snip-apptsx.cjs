
const fs = require('fs');
const lines = fs.readFileSync('workbench/src/App.tsx', 'utf8').split('\n');
for (let i = 313; i < 331; i++) console.log((i + 1) + ': ' + lines[i]);
