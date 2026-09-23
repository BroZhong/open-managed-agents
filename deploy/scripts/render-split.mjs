#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const [apiVersion, runnerVersion] = process.argv.slice(2);
for (const version of [apiVersion, runnerVersion]) {
  if (!version || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)) throw new Error('Usage: render-split.mjs API_VERSION RUNNER_VERSION (immutable tags)');
}
const repository = 'registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server';
const source = readFileSync(new URL('../k8s.split.yaml', import.meta.url), 'utf8');
process.stdout.write(source.replaceAll('OMA_API_IMAGE', `${repository}:${apiVersion}`).replaceAll('OMA_RUNNER_IMAGE', `${repository}:${runnerVersion}`));
