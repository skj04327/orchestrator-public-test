// Verify local tarballs and prepare the read-only package input for isolated npm checks.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {readDiskNpmManifests} from './disk-baseline.mjs';
import {ensurePrivateStateRoot} from './private-queue.mjs';
import {makeTarHeader} from './container-tar.mjs';
import {failure} from './docker-command.mjs';

const MAX_ENTRIES = 1000;
export const MAX_TARBALL = 32 * 1024 * 1024;
export const MAX_TOTAL = 256 * 1024 * 1024;
const registryTarball = /^https:\/\/registry\.npmjs\.org\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+\/-\/[a-zA-Z0-9_.+-]+\.tgz$/;
const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const preparedInputs = new WeakMap();

function lockError() {
  return Error('Dependency lock uses an unsupported npm package source or integrity');
}

function registrySpec(spec) {
  if (typeof spec !== 'string' || spec.length > 256) return false;
  const value = spec.trim();
  // Registry ranges and tags cannot name URL, local path or hosted-git sources.
  return /^[a-zA-Z0-9.*+<>=~^| -]*$/.test(value) && !/[\r\n]/.test(value) &&
    !value.startsWith('.') && !/\.(?:tgz|tar|tar\.gz)$/i.test(value);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSourceDeclarations(manifest) {
  if (!record(manifest) || Object.hasOwn(manifest,'workspaces')) throw lockError();
  for (const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) {
    if (!Object.hasOwn(manifest,field)) continue;
    const declarations = manifest[field];
    if (!record(declarations) || !Object.values(declarations).every(registrySpec)) throw lockError();
  }
}

function assertRegistryOverrides(overrides,depth=0) {
  if (!record(overrides) || depth > 32) throw lockError();
  for (const value of Object.values(overrides)) {
    if (record(value)) assertRegistryOverrides(value,depth+1);
    else if (!registrySpec(value)) throw lockError();
  }
}

export async function planOfflineNpmDependencies({diskSnapshot,signal}) {
  const [projectBytes,lockBytes] = await readDiskNpmManifests(diskSnapshot,{signal});
  let project;
  let lock;
  try {
    const decoder = new TextDecoder('utf-8',{fatal:true});
    project = JSON.parse(decoder.decode(projectBytes));
    lock = JSON.parse(decoder.decode(lockBytes));
  } catch {
    throw lockError();
  }
  assertSourceDeclarations(project);
  if (Object.hasOwn(project,'overrides')) assertRegistryOverrides(project.overrides);
  const table = lock?.packages;
  if (![2,3].includes(lock?.lockfileVersion) || !record(table)) throw lockError();
  assertSourceDeclarations(table['']);
  const entries = Object.entries(table);
  if (entries.length > MAX_ENTRIES + 1) throw lockError();
  const packages = new Map();
  for (const [path, entry] of entries) {
    if (path === '') continue;
    assertSourceDeclarations(entry);
    if (!path.startsWith('node_modules/') || entry.link || entry.inBundle ||
      typeof entry.resolved !== 'string' || !registryTarball.test(entry.resolved) ||
      new URL(entry.resolved).href !== entry.resolved ||
      typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw lockError();
    const checksum = Buffer.from(entry.integrity.slice(7),'base64');
    if (checksum.length !== 64 || 'sha512-' + checksum.toString('base64') !== entry.integrity) throw lockError();
    const filename = checksum.toString('hex') + '.tgz';
    if (!packages.has(filename)) packages.set(filename,{filename,resolved:entry.resolved});
  }
  return {lockSha256:sha256(lockBytes),packages:[...packages.values()].sort((a,b)=>a.filename.localeCompare(b.filename,'en'))};
}

function checkSignal(signal) {
  if (signal?.aborted) throw failure('cancelled');
}

async function* verifiedTarball(root,entry,signal,{emit=false}={}) {
  checkSignal(signal);
  const file = await open(join(root,entry.filename),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077) || info.size !== entry.size) {
      throw failure('unsafe_cache_blob');
    }
    if (emit) yield makeTarHeader(entry.archiveName,entry.size);
    const hash = createHash('sha512');
    let received = 0;
    while (true) {
      checkSignal(signal);
      const chunk = Buffer.alloc(65536);
      const {bytesRead} = await file.read(chunk,0,chunk.length,null);
      if (!bytesRead) break;
      received += bytesRead;
      if (received > entry.size) throw failure('blob_integrity');
      const bytes = chunk.subarray(0,bytesRead);
      hash.update(bytes);
      if (emit) yield bytes;
    }
    checkSignal(signal);
    if (received !== entry.size || hash.digest('hex') + '.tgz' !== entry.filename) throw failure('blob_integrity');
  } finally {
    await file.close();
  }
  if (emit && entry.size % 512) yield Buffer.alloc(512 - entry.size % 512);
}

// Caller supplies the validated private root and a content-addressed name from the lock plan.
export async function measureOfflineNpmTarball(root,filename,{signal,maxBytes=MAX_TARBALL}={}) {
  if(typeof filename!=='string'||! /^[a-f0-9]{128}\.tgz$/.test(filename))throw failure('invalid_configuration');
  checkSignal(signal);
  const info=await lstat(join(root,filename));
  if(!info.isFile()||info.size<1||info.size>Math.min(MAX_TARBALL,maxBytes))throw failure('unsafe_cache_blob');
  for await(const unused of verifiedTarball(root,{filename,size:info.size},signal))void unused;
  return info.size;
}

export async function prepareOfflineNpmDependencies({diskSnapshot,tarballRoot,signal}) {
  const plan = await planOfflineNpmDependencies({diskSnapshot,signal});
  const root = await ensurePrivateStateRoot(tarballRoot);
  const entries = [];
  let totalBytes = 0;
  for (const {filename} of plan.packages) {
    checkSignal(signal);
    const size=await measureOfflineNpmTarball(root,filename,{signal,maxBytes:MAX_TOTAL-totalBytes});
    const entry={filename,size,archiveName:'npm-dependency-'+entries.length+'.tgz'};
    entries.push(entry);
    totalBytes += entry.size;
  }
  checkSignal(signal);
  const proof = Object.freeze({
    schemaVersion:1,baselineManifestSha256:diskSnapshot.manifestSha256,lockSha256:plan.lockSha256,
    tarballsSha256:sha256(JSON.stringify(entries.map(entry=>[entry.filename,entry.size]))),
    tarballCount:entries.length,totalBytes,
  });
  const capability = Object.freeze({kind:'offline-npm-dependencies-v1'});
  preparedInputs.set(capability,{root,entries,diskSnapshot,proof});
  return capability;
}

function boundInput(dependencies,diskSnapshot) {
  const state = preparedInputs.get(dependencies);
  if (process.env.GITHUB_ACTIONS === 'true' || !state || state.diskSnapshot !== diskSnapshot) throw failure('invalid_configuration');
  return state;
}

export function offlineNpmProvenance(dependencies,diskSnapshot) {
  return dependencies === undefined ? null : boundInput(dependencies,diskSnapshot).proof;
}

export function validateOfflineNpmProvenance(proof,baselineManifestSha256) {
  const fields = ['baselineManifestSha256','lockSha256','schemaVersion','tarballCount','tarballsSha256','totalBytes'];
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) ||
    Object.keys(proof).sort().join(',') !== fields.join(',') || proof.schemaVersion !== 1 ||
    !digest(proof.baselineManifestSha256) || proof.baselineManifestSha256 !== baselineManifestSha256 ||
    !digest(proof.lockSha256) || !digest(proof.tarballsSha256) ||
    !Number.isSafeInteger(proof.tarballCount) || proof.tarballCount < 0 || proof.tarballCount > MAX_ENTRIES ||
    !Number.isSafeInteger(proof.totalBytes) || proof.totalBytes < proof.tarballCount || proof.totalBytes > MAX_TOTAL ||
    (proof.tarballCount === 0 && proof.totalBytes !== 0)) throw Error('Invalid offline dependency provenance');
}

export function createOfflineNpmArchive(dependencies,diskSnapshot,{signal}={}) {
  if (dependencies === undefined) return null;
  const {root,entries} = boundInput(dependencies,diskSnapshot);
  return (async function*(){
    const directory = await ensurePrivateStateRoot(root);
    checkSignal(signal);
    const count = Buffer.from(String(entries.length));
    yield makeTarHeader('npm-dependency-count',count.length);
    yield count;
    yield Buffer.alloc(512 - count.length);
    for (const entry of entries) yield* verifiedTarball(directory,entry,signal,{emit:true});
    checkSignal(signal);
    yield Buffer.alloc(1024);
  })();
}
