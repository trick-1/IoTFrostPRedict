// gen-basic-hash.js
const crypto = require('crypto');
const pass = process.argv[2] || 'change-me';
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pass, salt, 32);
console.log('BASIC_SALT_B64=' + salt.toString('base64'));
console.log('BASIC_HASH_B64=' + hash.toString('base64'));
