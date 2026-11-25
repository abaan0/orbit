import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/vault.js';

// Mock Upstash's REST interface. No real database, secrets or workplace code needed.
const db = new Map();
const originalFetch = globalThis.fetch;
const originalEnv = {...process.env};
let beforeCAS = null;
let failGET = false;
const slotKey = n => 'orbit:shared-code-vault:v1:' + n;
const limiter = 'orbit:vault:login-limit:v1';
const password = 'test-only-a-long-random-password';
before(() => {
  process.env.APP_PASSWORD = password;
  delete process.env.VAULT_PASSWORD;
  delete process.env.VAULT_SESSION_SECRET;
  process.env.KV_REST_API_URL = 'https://mock-redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  globalThis.fetch = async (_url, options) => {
    const [op, ...args] = JSON.parse(options.body);
    let result;
    if (op === 'GET') {
      if (failGET) { failGET = false; throw new Error('simulated network failure'); }
      result = db.get(args[0]) ?? null;
    } else if (op === 'EVAL') {
      const [script, count, key, ...argv] = args;
      assert.equal(count, '1');
      if (script.includes("redis.call('INCR'")) {
        const n = Number(db.get(key) || 0);
        if (n >= Number(argv[0])) result = 0;
        else { db.set(key, String(n + 1)); result = 1; }
      } else {
        assert.match(script, /current ~= ARGV\[2\]/);
        if (beforeCAS) { const fn = beforeCAS; beforeCAS = null; fn(key); }
        const old = db.get(key);
        const [kind, expected, action, raw] = argv;
        const matches = kind === 'empty' ? old === undefined : old === expected;
        if (!matches) result = 0;
        else { if (action === 'delete') db.delete(key); else db.set(key, raw); result = 1; }
      }
    } else throw new Error('Unexpected command: ' + op);
    return new Response(JSON.stringify({result}), {status:200});
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv,key)) delete process.env[key];
  Object.assign(process.env,originalEnv);
});
async function call(method, {slot=1, cookie='', body, header=true}={}) {
  const headers = {}; const output = {};
  const res = {setHeader(k,v){headers[k.toLowerCase()] = v;},status(code){output.status=code;return this;},json(data){output.data=data;return this;}};
  await handler({method,headers:{...(header?{'x-vault-request':'1'}:{}),cookie},query:{slot},body},res);
  return {...output,headers};
}
async function login(p=password) {
  const result = await call('POST',{body:{action:'login',password:p}});
  return {...result,cookie:result.headers['set-cookie']?.split(';')[0]};
}

test('reject unauthenticated calls, invalid requests, incorrect password; cookie is HttpOnly/Secure', async()=>{
  assert.equal((await call('GET')).status,401);
  assert.equal((await call('GET',{header:false})).status,403);
  assert.equal((await login('wrong')).status,401);
  const auth = await login(); assert.equal(auth.status,200);
  assert.match(auth.headers['set-cookie'],/HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await call('GET',{cookie:auth.cookie+'bad'})).status,401);
  assert.equal((await call('GET',{cookie:auth.cookie,slot:6})).status,400);
  const logout = await call('POST',{cookie:auth.cookie,body:{action:'logout'}});
  assert.match(logout.headers['set-cookie'],/Max-Age=0/);
});
test('legacy records, exact 6,000 lines, independent slots and deletion', async()=>{
  const cookie = (await login()).cookie;
  db.set(slotKey(1),JSON.stringify({title:'Legacy',code:'hello\n',updatedAt:123456789}));
  const old = (await call('GET',{cookie})).data;
  assert.equal(old.code,'hello\n'); assert.match(old.revision,/^[0-9a-f]{64}$/);
  const code = Array.from({length:6000},(_,i)=>`* Sample ${i+1}\t\"नमस्ते\"`).join('\n')+'\n';
  const saved = await call('PUT',{cookie,body:{title:'  Synthetic  ',code,revision:old.revision}});
  assert.equal(saved.status,200);
  const loaded = (await call('GET',{cookie})).data;
  assert.equal(loaded.code,code); assert.equal(loaded.title,'Synthetic'); assert.equal(loaded.revision,saved.data.revision);
  assert.equal((await call('GET',{cookie,slot:2})).data.revision,'empty');
  assert.equal((await call('DELETE',{cookie,body:{revision:loaded.revision}})).status,200);
  assert.equal((await call('GET',{cookie})).data.revision,'empty');
});
test('stale saves and deletes are rejected; check-then-write race also rejected', async()=>{
  const a=(await login()).cookie, b=(await login()).cookie;
  const first = await call('PUT',{cookie:a,slot:2,body:{title:'one',code:'old',revision:'empty'}});
  const base=first.data.revision;
  const newer=await call('PUT',{cookie:b,slot:2,body:{title:'two',code:'new',revision:base}});
  assert.equal(newer.status,200);
  assert.equal((await call('PUT',{cookie:a,slot:2,body:{title:'stale',code:'old',revision:base}})).status,409);
  assert.equal((await call('DELETE',{cookie:a,slot:2,body:{revision:base}})).status,409);
  assert.equal((await call('GET',{cookie:a,slot:2})).data.code,'new');
  beforeCAS=key=>db.set(key,JSON.stringify({title:'raced',code:'third',updatedAt:Date.now()}));
  assert.equal((await call('PUT',{cookie:a,slot:2,body:{title:'stale',code:'fourth',revision:newer.data.revision}})).status,409);
  assert.equal((await call('GET',{cookie:a,slot:2})).data.code,'third');
});
test('invalid, oversized and failed storage requests never overwrite saved content', async()=>{
  const cookie=(await login()).cookie;
  const old=(await call('GET',{cookie,slot:2})).data;
  assert.equal((await call('PUT',{cookie,slot:2,body:{title:'no revision',code:'x'}})).status,428);
  assert.equal((await call('PUT',{cookie,slot:2,body:{title:'oversize',code:'x'.repeat(800001),revision:old.revision}})).status,413);
  failGET=true;
  assert.equal((await call('PUT',{cookie,slot:2,body:{title:'fail',code:'x',revision:old.revision}})).status,502);
  assert.equal((await call('GET',{cookie,slot:2})).data.code,'third');
});
test('session changes when password changes; login attempts capped',async()=>{
  const cookie=(await login()).cookie;
  process.env.APP_PASSWORD='a-different-test-password';
  assert.equal((await call('GET',{cookie})).status,401);
  process.env.APP_PASSWORD=password;
  db.set(limiter,'15');
  assert.equal((await login()).status,429);
});
