
import { execSync } from 'node:child_process'
const out = execSync('node -e "console.log(101)"')
console.log('CAPTURED=' + JSON.stringify(out.toString().trim()))
