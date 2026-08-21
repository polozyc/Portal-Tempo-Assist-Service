#!/usr/bin/env node
/**
 * Gera um hash bcrypt para usar no .env, evitando senhas em texto puro.
 *
 * Uso:
 *   npm run hash-password -- "minhaSenhaForte"
 */
const bcrypt = require("bcryptjs");

const password = process.argv[2];

if (!password) {
  console.error('Uso: npm run hash-password -- "suaSenhaAqui"');
  process.exit(1);
}

if (password.length < 8) {
  console.error("A senha deve ter pelo menos 8 caracteres.");
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

console.log("\nHash gerado (cole no .env no lugar da senha):\n");
console.log(hash);
console.log("\nExemplos de uso:");
console.log(`  MASTER_PASSWORD=${hash}`);
console.log(`  EXTRA_USERS=joao:${hash}:false\n`);
