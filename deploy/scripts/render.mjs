#!/usr/bin/env node
// Render one environment overlay with immutable images. Each version is a
// sha256 digest (preferred) or an immutable tag such as 202610261444 (the
// Beijing build time build-images.sh tags with) in the welltop ACR repository
// for that component.
import { execFileSync } from 'node:child_process';

const usage = 'Usage: render.mjs ENV API_VERSION RUNNER_VERSION WEB_VERSION BUILDER_VERSION (ENV: production | test; versions: sha256:<digest> or an immutable tag such as 202610261444)';
const [env, ...versions] = process.argv.slice(2);
if (!['production', 'test'].includes(env) || versions.length !== 4) throw new Error(usage);
const registry = 'registry-vpc.cn-shanghai.aliyuncs.com/welltop';
const image = (repository, version) => {
  if (/^sha256:[a-f0-9]{64}$/.test(version)) return `${registry}/${repository}@${version}`;
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version) && version !== 'latest') return `${registry}/${repository}:${version}`;
  throw new Error(usage);
};
const [api, runner, web, builder] = versions;
const overlay = new URL(`../environments/${env}`, import.meta.url).pathname;
const rendered = execFileSync('kubectl', ['kustomize', overlay], { encoding: 'utf8' });
process.stdout.write(rendered
  .replaceAll('OMA_API_IMAGE', image('oma-server', api))
  .replaceAll('OMA_RUNNER_IMAGE', image('oma-server', runner))
  .replaceAll('OMA_BUILDER_IMAGE', image('oma-server', builder))
  .replaceAll('OMA_WEB_IMAGE', image('oma-web', web)));
