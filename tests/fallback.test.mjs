import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/chat.js';

process.env.GEMINI_API_KEY = 'primary-test-key';
process.env.GEMINI_API_KEY_BACKUP = 'backup-test-key';
process.env.APP_PASSWORD = 'test-password';

function makeReply(statusCode, data) {
  return { status: statusCode, headers: { get: () => null }, text: async () => JSON.stringify(data) };
}
function makeRequest(body) {
  const req = { method: 'POST', headers: {'x-app-password':'test-password'}, body };
  let code = 0, result = null;
  const res = {setHeader(){},status(n){code=n;return this;},json(x){result=x;return this;}};
  return {req,res,output:()=>({code,result})};
}
const ok = (m='gemini') => makeReply(200,{status:'completed',id:'interaction-1',steps:[{type:'model_output',content:[{type:'text',text:`Answer from ${m}`}]}]});
const quota = () => makeReply(429,{error:{message:'Too many requests'}});
const run = async (body, mockFetch) => {
  globalThis.fetch = mockFetch;
  const {req,res,output}=makeRequest({model:'auto',prompt:'Explain ABAP',...body});
  await handler(req,res);
  return output();
};

test('auto uses first model if successful', async()=>{
  const requests=[];
  const r=await run({},async(_url,opts)=>{requests.push(JSON.parse(opts.body).model);return ok();});
  assert.equal(r.code,200);
  assert.equal(r.result.model,'gemini-3.8-flash');
  assert.equal(r.result.fallbackUsed,false);
  assert.deepEqual(requests,['gemini-3.8-flash']);
});

test('429 switches models, never switches keys', async()=>{
  const requests=[];
  const r=await run({},async(_url,opts)=>{
    requests.push({key:opts.headers['x-goog-api-key'],model:JSON.parse(opts.body).model});
    return requests.length===1?quota():ok('fallback');
  });
  assert.equal(r.code,200);
  assert.equal(r.result.model,'gemini-4-hydrogen');
  assert.equal(r.result.fallbackUsed,true);
  assert.equal(requests.length,2);
  assert.deepEqual(requests.map(r=>r.key),['primary-test-key','primary-test-key']);
});

test('401 uses backup key and preserves model order',async()=>{
  const seen=[];
  const r=await run({},async(_url,opts)=>{
    seen.push(opts.headers['x-goog-api-key']);
    return seen.length===1?makeReply(401,{error:{message:'invalid key'}}):ok('backup');
  });
  assert.equal(r.code,200);
  assert.equal(r.result.keySlot,'backup');
  assert.deepEqual(seen,['primary-test-key','backup-test-key']);
});

test('429 across all models returns meaningful error',async()=>{
  const models=[];
  const r=await run({},async(_url,opts)=>{
    models.push(JSON.parse(opts.body).model);
    assert.equal(opts.headers['x-goog-api-key'],'primary-test-key');
    return quota();
  });
  assert.equal(r.code,429);
  assert.equal(models.length,5);
});

test('manual selection is first, then falls back',async()=>{
  const models=[];
  const r=await run({model:'gemini-3.1-flash-lite'},async(_url,opts)=>{
    models.push(JSON.parse(opts.body).model);
    return models.length===1?makeReply(404,{error:{message:'unavailable'}}):ok();
  });
  assert.equal(r.code,200);
  assert.deepEqual(models,['gemini-3.1-flash-lite','gemini-3.8-flash']);
});

test('when key changes context is reconstructed, interaction id is not reused',async()=>{
  const bodies=[];
  const r=await run({previousInteractionId:'interaction-old',previousKeySlot:'primary',history:[{role:'user',content:'Original program has 700 lines'},{role:'assistant',content:'I understood'}]},async(_url,opts)=>{
    bodies.push(JSON.parse(opts.body));
    return bodies.length===1?makeReply(403,{error:{message:'key access denied'}}):ok();
  });
  assert.equal(r.code,200);
  assert.equal(bodies[0].previous_interaction_id,'interaction-old');
  assert.equal(bodies[1].previous_interaction_id,undefined);
  assert.match(bodies[1].input,/Original program has 700 lines/);
});

test('incomplete answers are labeled incomplete',async()=>{
  const r=await run({},async()=>makeReply(200,{status:'incomplete',steps:[{type:'model_output',content:[{type:'text',text:'Partial ABAP program'}]}]}));
  assert.equal(r.code,200);
  assert.equal(r.result.incomplete,true);
});
