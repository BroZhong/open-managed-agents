#!/usr/bin/env node
// Print a migration rewritten for one environment's schema and application role.
// Production migrations are written against oma/oma_app; test uses oma_test/oma_test_app.
import { readFileSync } from 'node:fs';

const targets = { production: { schema: 'oma', role: 'oma_app' }, test: { schema: 'oma_test', role: 'oma_test_app' } };
const [env, file] = process.argv.slice(2);
const target = targets[env];
if (!target || !file) throw new Error('Usage: migration-for-env.mjs production|test deploy/migrations/<file>.sql');
process.stdout.write(readFileSync(file, 'utf8')
  .replace(/\boma_app\b/g, target.role)
  .replace(/\boma\./g, `${target.schema}.`)
  .replace(/\bSCHEMA oma\b/g, `SCHEMA ${target.schema}`));
