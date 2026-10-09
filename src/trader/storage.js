import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes,randomUUID,createHash,scryptSync,createCipheriv,createDecipheriv } from 'node:crypto';
import { open,lstat,unlink,link } from 'node:fs/promises';
import { dirname,basename } from 'node:path';
import { getHartiiHome } from '../config.js';
import { securePath, atomicPrivateWrite, secureDirectory } from '../secureFiles.js';
import { assertValidWalletName } from '../keystore.js';
import { CliError } from '../errors.js';

export class TraderCliError extends CliError {}
export function profilePaths(opts = {}, deps = {}) {
  const name = assertValidWalletName(opts.profile || 'default');
  const home = opts.home || getHartiiHome(deps.env || deps.io?.env);
  const root = securePath(join(home, 'trader', name)).path;
  return { home, name, root, profile: join(root, 'profile.json'), snapshot: join(root, 'snapshot.json'),
    events: join(root, 'activity.json'), relayCursor:join(root,'relay-cursor.json'),hostedPending:join(root,'hosted-pending.json'),policy: join(root, 'armed-policy.json'),proposal:join(root,'policy-proposal.json'),pause: join(root, 'paused.json'),resumeAck:join(root,'resume-ack.json'),
    credentials: join(root, 'credentials.json'),outbox:join(root,'telemetry.journal.jsonl'),journal: mode => join(root, `${mode}.journal.jsonl`) };
}
export function readPrivateJson(path, { optional = false, maximum = 2_000_000 } = {}) {
  const { stat } = securePath(path, { regularFile: true });
  if (!stat && optional) return null;
  if (!stat || stat.size > maximum) throw new TraderCliError('Local trader file is missing or exceeds its size limit.');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new TraderCliError('Local trader file is not valid JSON.'); }
}
export function writePrivateJson(path, value, { replace = true } = {}) {
  atomicPrivateWrite(path, JSON.stringify(value, null, 2) + '\n', { replace });
}
export function loadProfile(paths) {
  const value = readPrivateJson(paths.profile, { optional: true });
  if (value === null) return null;
  if (value.schemaVersion !== 1 || value.chainId !== 9 || value.profile !== paths.name || !/^[A-Za-z0-9_-]{1,96}$/.test(value.runnerId))
    throw new TraderCliError('Invalid local trader profile.');
  return value;
}
export function requireProfile(paths) {
  const p = loadProfile(paths);
  if (!p) throw new TraderCliError('Run hartii trader init with owner, trading address and explicit budgets first.');
  return p;
}
export function readPauseControl(paths) {
  const value=readPrivateJson(paths.pause,{optional:true});if(!value)return null;
  if(value.schemaVersion!==1 || !Number.isSafeInteger(value.at) || value.at<0 || !['local-pause','remote-pause'].includes(value.reason))throw new TraderCliError('Local pause control is invalid; signing remains blocked.');
  const id=value.id===undefined?'legacy-'+createHash('sha256').update(JSON.stringify({at:value.at,reason:value.reason})).digest('hex'):value.id;
  if(typeof id!=='string' || !/^[A-Za-z0-9_-]{1,96}$/.test(id))throw new TraderCliError('Local pause identity is invalid; signing remains blocked.');
  return {schemaVersion:1,id,at:value.at,reason:value.reason};
}
export function pauseRequested(paths) {
  const pause=readPauseControl(paths);if(!pause)return false;
  const ack=readPrivateJson(paths.resumeAck,{optional:true});
  return !(ack?.schemaVersion===1 && ack.controlPauseId===pause.id && ack.pauseAt===pause.at && ack.pauseReason===pause.reason);
}
export function requestPause(paths, now = Date.now(), reason = 'local-pause') {
  requireProfile(paths); secureDirectory(paths.root);
  writePrivateJson(paths.pause, { schemaVersion: 1,id:randomUUID(),at:now,reason });
  return { ok: true, state: 'paused', latched: true, note: 'Pause is latched locally. A transaction already broadcast still requires reconciliation.' };
}
// Device credentials and BYO model keys are a separate encrypted envelope, never a signing wallet.
export function encryptCredentials(credentials, password) {
  if (typeof password !== 'string' || password.length < 12) throw new TraderCliError('Use at least 12 characters for the local credential password.');
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return { schemaVersion: 1, cipher: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { key.fill(0); }
}
export function decryptCredentials(envelope, password) {
  let key;
  try {
    if (envelope?.schemaVersion !== 1 || envelope.cipher !== 'aes-256-gcm' || envelope.kdf !== 'scrypt') throw Error();
    const salt=Buffer.from(envelope.salt,'base64'), iv=Buffer.from(envelope.iv,'base64'), tag=Buffer.from(envelope.tag,'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw Error();
    key=scryptSync(password,salt,32);
    const decipher=createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
  } catch { throw new TraderCliError('Could not unlock local trader credentials.'); }
  finally { key?.fill(0); }
}

/** Export takes the same non-expiring mode locks as the runner; it never removes another writer's lock. */
export async function withStoppedTraderJournals(paths,modes,operation) {
  const owned=[];
  try {
    for(const mode of modes) {
      const path=securePath(paths.journal(mode)+'.lock',{regularFile:true}).path;
      let handle;
      try {handle=await open(path,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new TraderCliError('Stop trader writers before exporting history; a journal is locked.');throw new TraderCliError('Could not acquire a protected journal export lock.');}
      owned.push({path,handle});await handle.writeFile('hartii-trader-exclusive-writer-v1\n');await handle.sync();
    }
    return await operation(modes.map(mode=>({mode,...securePath(paths.journal(mode),{regularFile:true})})));
  } finally {
    for(const {path,handle} of owned.reverse()) {
      const identity=await handle.stat();await handle.close();
      const current=await lstat(path).catch(()=>null);
      if(current && current.dev===identity.dev && current.ino===identity.ino && !current.isSymbolicLink())await unlink(path);
    }
  }
}

/** Stream to a private temporary file and atomically publish only a complete validated artifact. */
export async function privateStreamExport(path,operation) {
  const target=securePath(path,{regularFile:true});
  if(target.stat)throw new TraderCliError('Export destination already exists; choose another output file.');
  const directory=secureDirectory(dirname(target.path)),temporary=join(directory,`.${basename(target.path)}-${randomUUID()}.tmp`);
  let handle,owned=false;
  try {
    handle=await open(temporary,'wx',0o600);owned=true;
    const result=await operation(async text=>handle.writeFile(text,'utf8'));
    await handle.sync();await handle.close();handle=null;
    if(securePath(target.path,{regularFile:true}).stat)throw new TraderCliError('Export destination changed; it was not overwritten.');
    await link(temporary,target.path);await unlink(temporary);owned=false;
    return {...result,savedTo:target.path};
  } catch(error) {
    if(error instanceof TraderCliError)throw error;
    throw new TraderCliError('Journal export failed; no completed artifact was published.');
  } finally {await handle?.close();if(owned)await unlink(temporary).catch(()=>{});}
}
