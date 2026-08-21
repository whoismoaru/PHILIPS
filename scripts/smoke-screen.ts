import { screenToken, formatScreen } from '../src/screening.js';

const addr = process.argv[2] ?? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const s = await screenToken(addr);
console.log(formatScreen(s));
process.exit(0);
