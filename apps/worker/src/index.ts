import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Env, ModelRow, UserAuth } from './types';
import { calculateCredit, createApiKey, dateKey, errorBody, estimateTokens, id, monthStartIso, nowIso, sha256 } from './utils';

type Vars = { auth?: UserAuth };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', async (c, next) => {
  const allowed = String(c.env.CORS_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
  return cors({ origin: (origin) => (!origin || allowed.includes(origin) ? origin : allowed[0] || ''), allowHeaders: ['Authorization','Content-Type','Idempotency-Key'], exposeHeaders: ['X-Gateway-Request-Id','X-Credit-Used','X-Credit-Remaining','X-Input-Tokens','X-Output-Tokens'], credentials: true })(c, next);
});

app.get('/health', (c) => c.json({ ok: true, service: 'llm-credit-gateway', time: nowIso() }));

const admin = async (c: any, next: any) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || token !== c.env.ADMIN_TOKEN) return c.json(errorBody('Invalid admin token.', 'invalid_admin_token'), 401);
  await next();
};

const userAuth = async (c: any, next: any) => {
  const raw = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!raw) return c.json(errorBody('Missing API key.', 'invalid_api_key'), 401);
  const hash = await sha256(raw);
  const row = await c.env.DB.prepare(`
    SELECT k.id api_key_id, k.user_id, k.organization_id, k.status key_status, k.expires_at,
           u.name, u.status, u.credit_balance, u.daily_credit_limit, u.monthly_credit_limit
    FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? LIMIT 1
  `).bind(hash) as any;
  if (!row || row.key_status !== 'active') return c.json(errorBody('Invalid or revoked API key.', 'invalid_api_key'), 401);
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return c.json(errorBody('API key expired.', 'expired_api_key'), 401);
  if (row.status !== 'active') return c.json(errorBody('User is suspended.', 'user_suspended'), 403);
  c.set('auth', { apiKeyId: row.api_key_id, userId: row.user_id, organizationId: row.organization_id, name: row.name, status: row.status, creditBalance: row.credit_balance, dailyCreditLimit: row.daily_credit_limit, monthlyCreditLimit: row.monthly_credit_limit });
  c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').bind(nowIso(), row.api_key_id).run());
  await next();
};

app.use('/admin/*', admin);
app.use('/v1/*', userAuth);

app.get('/admin/summary', async (c) => {
  const org = c.env.DEFAULT_ORG_ID;
  const [users, totals, today, requests] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) count FROM users WHERE organization_id=? AND role=?').bind(org, 'user'),
    c.env.DB.prepare('SELECT COALESCE(SUM(credit_balance),0) balance FROM users WHERE organization_id=?').bind(org),
    c.env.DB.prepare('SELECT COALESCE(SUM(total_credit),0) credit, COALESCE(SUM(request_count),0) requests FROM usage_daily WHERE organization_id=? AND date=?').bind(org, dateKey()),
    c.env.DB.prepare('SELECT COUNT(*) count FROM usage_requests WHERE organization_id=?').bind(org),
  ]);
  return c.json({ users: (users.results?.[0] as any)?.count || 0, totalBalance: (totals.results?.[0] as any)?.balance || 0, todayCredit: (today.results?.[0] as any)?.credit || 0, todayRequests: (today.results?.[0] as any)?.requests || 0, totalRequests: (requests.results?.[0] as any)?.count || 0 });
});

app.get('/admin/users', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT u.*, (SELECT COUNT(*) FROM api_keys k WHERE k.user_id=u.id AND k.status='active') active_keys FROM users u WHERE organization_id=? ORDER BY created_at DESC`).bind(c.env.DEFAULT_ORG_ID).all();
  return c.json(rows.results);
});

const userSchema = z.object({ name: z.string().min(1), email: z.string().email().optional(), username: z.string().min(2).optional(), initialCredit: z.number().int().nonnegative().default(0), dailyCreditLimit: z.number().int().positive().nullable().optional(), monthlyCreditLimit: z.number().int().positive().nullable().optional() });
app.post('/admin/users', async (c) => {
  const parsed = userSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const u = parsed.data, uid = id('usr'), now = nowIso(), org = c.env.DEFAULT_ORG_ID;
  const statements = [c.env.DB.prepare(`INSERT INTO users (id,organization_id,name,email,username,role,status,credit_balance,daily_credit_limit,monthly_credit_limit,created_at,updated_at) VALUES (?,?,?,?,?,'user','active',?,?,?,?,?)`).bind(uid, org, u.name, u.email || null, u.username || null, u.initialCredit, u.dailyCreditLimit ?? null, u.monthlyCreditLimit ?? null, now, now)];
  if (u.initialCredit > 0) statements.push(c.env.DB.prepare(`INSERT INTO credit_ledger (id,organization_id,user_id,type,amount,balance_before,balance_after,description,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id('led'), org, uid, 'initial_grant', u.initialCredit, 0, u.initialCredit, 'Initial credit', 'admin', now));
  await c.env.DB.batch(statements);
  return c.json({ id: uid }, 201);
});

app.patch('/admin/users/:id', async (c) => {
  const schema = z.object({ name: z.string().min(1).optional(), status: z.enum(['active','suspended']).optional(), dailyCreditLimit: z.number().int().positive().nullable().optional(), monthlyCreditLimit: z.number().int().positive().nullable().optional() });
  const p = schema.safeParse(await c.req.json()); if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const current = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(c.req.param('id')) as any; if (!current) return c.json({ error: 'Not found' }, 404);
  const v = p.data; await c.env.DB.prepare('UPDATE users SET name=?,status=?,daily_credit_limit=?,monthly_credit_limit=?,updated_at=? WHERE id=?').bind(v.name ?? current.name, v.status ?? current.status, v.dailyCreditLimit === undefined ? current.daily_credit_limit : v.dailyCreditLimit, v.monthlyCreditLimit === undefined ? current.monthly_credit_limit : v.monthlyCreditLimit, nowIso(), current.id).run();
  return c.json({ ok: true });
});

app.post('/admin/users/:id/credits/adjust', async (c) => {
  const p = z.object({ amount: z.number().int().refine((n) => n !== 0), description: z.string().min(2) }).safeParse(await c.req.json());
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(c.req.param('id')) as any; if (!user) return c.json({ error: 'Not found' }, 404);
  const after = user.credit_balance + p.data.amount; if (after < 0) return c.json(errorBody('Adjustment would make balance negative.', 'insufficient_credit'), 400);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET credit_balance=?,updated_at=? WHERE id=? AND credit_balance=?').bind(after, now, user.id, user.credit_balance),
    c.env.DB.prepare(`INSERT INTO credit_ledger (id,organization_id,user_id,type,amount,balance_before,balance_after,description,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id('led'), user.organization_id, user.id, p.data.amount > 0 ? 'admin_topup' : 'admin_deduction', p.data.amount, user.credit_balance, after, p.data.description, 'admin', now),
  ]);
  return c.json({ balance: after });
});

app.get('/admin/users/:id/ledger', async (c) => c.json((await c.env.DB.prepare('SELECT * FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(c.req.param('id')).all()).results));
app.get('/admin/users/:id/keys', async (c) => c.json((await c.env.DB.prepare('SELECT id,name,key_prefix,status,last_used_at,expires_at,created_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC').bind(c.req.param('id')).all()).results));
app.post('/admin/users/:id/keys', async (c) => {
  const body = z.object({ name: z.string().default('Default key'), expiresAt: z.string().datetime().nullable().optional() }).parse(await c.req.json().catch(() => ({})));
  const user = await c.env.DB.prepare('SELECT id,organization_id FROM users WHERE id=?').bind(c.req.param('id')) as any; if (!user) return c.json({ error: 'Not found' }, 404);
  const raw = createApiKey(); await c.env.DB.prepare(`INSERT INTO api_keys (id,organization_id,user_id,name,key_prefix,key_hash,status,expires_at,created_at) VALUES (?,?,?,?,?,?,'active',?,?)`).bind(id('key'), user.organization_id, user.id, body.name, raw.slice(0, 18), await sha256(raw), body.expiresAt ?? null, nowIso()).run();
  return c.json({ apiKey: raw, warning: 'This key is shown only once.' }, 201);
});
app.delete('/admin/keys/:id', async (c) => { await c.env.DB.prepare(`UPDATE api_keys SET status='revoked',revoked_at=? WHERE id=?`).bind(nowIso(), c.req.param('id')).run(); return c.json({ ok: true }); });

app.get('/admin/models', async (c) => c.json((await c.env.DB.prepare('SELECT * FROM models WHERE organization_id=? ORDER BY public_name').bind(c.env.DEFAULT_ORG_ID).all()).results));
app.post('/admin/models', async (c) => {
  const p = z.object({ publicName:z.string().min(1), providerType:z.string().default('openai-compatible'), baseUrl:z.string().url(), secretBindingName:z.string().min(1), upstreamModel:z.string().min(1), inputPricePerMillion:z.number().int().nonnegative(), outputPricePerMillion:z.number().int().nonnegative(), cachedInputPricePerMillion:z.number().int().nonnegative().default(0), internalMarkupBps:z.number().int().min(0).max(100000).default(0), maxOutputTokens:z.number().int().positive().default(4096), supportsStreaming:z.boolean().default(true) }).safeParse(await c.req.json());
  if (!p.success) return c.json({ error:p.error.flatten() },400); const v=p.data, mid=id('mdl'), now=nowIso();
  await c.env.DB.prepare(`INSERT INTO models (id,organization_id,public_name,provider_type,base_url,secret_binding_name,upstream_model,input_price_per_million,output_price_per_million,cached_input_price_per_million,internal_markup_bps,max_output_tokens,supports_streaming,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`).bind(mid,c.env.DEFAULT_ORG_ID,v.publicName,v.providerType,v.baseUrl.replace(/\/$/,''),v.secretBindingName,v.upstreamModel,v.inputPricePerMillion,v.outputPricePerMillion,v.cachedInputPricePerMillion,v.internalMarkupBps,v.maxOutputTokens,v.supportsStreaming?1:0,now,now).run();
  return c.json({id:mid},201);
});
app.patch('/admin/models/:id', async (c) => { const v=await c.req.json<any>(); const m=await c.env.DB.prepare('SELECT * FROM models WHERE id=?').bind(c.req.param('id')) as any; if(!m)return c.json({error:'Not found'},404); await c.env.DB.prepare(`UPDATE models SET status=?,input_price_per_million=?,output_price_per_million=?,internal_markup_bps=?,max_output_tokens=?,updated_at=? WHERE id=?`).bind(v.status??m.status,v.inputPricePerMillion??m.input_price_per_million,v.outputPricePerMillion??m.output_price_per_million,v.internalMarkupBps??m.internal_markup_bps,v.maxOutputTokens??m.max_output_tokens,nowIso(),m.id).run(); return c.json({ok:true}); });

app.get('/admin/usage', async (c) => { const limit=Math.min(Number(c.req.query('limit')||100),500); return c.json((await c.env.DB.prepare(`SELECT r.*,u.name user_name,m.public_name FROM usage_requests r JOIN users u ON u.id=r.user_id JOIN models m ON m.id=r.model_id WHERE r.organization_id=? ORDER BY r.created_at DESC LIMIT ?`).bind(c.env.DEFAULT_ORG_ID,limit).all()).results); });

app.get('/v1/models', async (c) => { const a=c.get('auth')!; const rows=await c.env.DB.prepare(`SELECT m.public_name id FROM models m LEFT JOIN user_model_access x ON x.model_id=m.id AND x.user_id=? WHERE m.organization_id=? AND m.status='active' AND COALESCE(x.is_allowed,1)=1 ORDER BY m.public_name`).bind(a.userId,a.organizationId).all(); return c.json({object:'list',data:(rows.results as any[]).map(x=>({id:x.id,object:'model',owned_by:'llm-credit-gateway'}))}); });
app.get('/v1/me', (c) => { const a=c.get('auth')!; return c.json({id:a.userId,name:a.name,credit_balance:a.creditBalance,daily_credit_limit:a.dailyCreditLimit,monthly_credit_limit:a.monthlyCreditLimit}); });
app.get('/v1/credits', (c) => { const a=c.get('auth')!; return c.json({credit_balance:a.creditBalance,daily_credit_limit:a.dailyCreditLimit,monthly_credit_limit:a.monthlyCreditLimit}); });
app.get('/v1/usage', async (c) => { const a=c.get('auth')!; return c.json((await c.env.DB.prepare('SELECT id,status,input_tokens,output_tokens,total_tokens,actual_credit,http_status,latency_ms,created_at FROM usage_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(a.userId).all()).results); });

async function getModel(env:Env, auth:UserAuth, publicName:string):Promise<ModelRow|null>{ return env.DB.prepare(`SELECT m.* FROM models m LEFT JOIN user_model_access x ON x.model_id=m.id AND x.user_id=? WHERE m.organization_id=? AND m.public_name=? AND m.status='active' AND COALESCE(x.is_allowed,1)=1 LIMIT 1`).bind(auth.userId,auth.organizationId,publicName).first<ModelRow>(); }

app.post('/v1/chat/completions', async (c) => {
  const auth=c.get('auth')!; const payload=await c.req.json<any>().catch(()=>null); if(!payload?.model || !Array.isArray(payload.messages)) return c.json(errorBody('model and messages are required.','invalid_request'),400);
  const model=await getModel(c.env,auth,payload.model); if(!model) return c.json(errorBody('Model is disabled or not allowed.','model_not_allowed'),403);
  const stream=Boolean(payload.stream); if(stream && !model.supports_streaming) return c.json(errorBody('Streaming is not supported for this model.','stream_not_supported'),400);
  const maxOut=Math.min(Number(payload.max_tokens||payload.max_completion_tokens||model.max_output_tokens),model.max_output_tokens); payload.max_tokens=maxOut; payload.model=model.upstream_model;
  if(stream) payload.stream_options={...(payload.stream_options||{}),include_usage:true};
  const estInput=estimateTokens(payload.messages); const reserved=calculateCredit(estInput,maxOut,0,model.input_price_per_million,model.output_price_per_million,model.cached_input_price_per_million,model.internal_markup_bps);
  const daily=(await c.env.DB.prepare('SELECT COALESCE(SUM(total_credit),0) used FROM usage_daily WHERE user_id=? AND date=?').bind(auth.userId,dateKey()) as any)?.used||0;
  const monthly=(await c.env.DB.prepare('SELECT COALESCE(SUM(actual_credit),0) used FROM usage_requests WHERE user_id=? AND created_at>=? AND status=?').bind(auth.userId,monthStartIso(),'completed') as any)?.used||0;
  if(auth.dailyCreditLimit && daily+reserved>auth.dailyCreditLimit) return c.json(errorBody('Daily credit limit exceeded.','daily_limit_exceeded'),429);
  if(auth.monthlyCreditLimit && monthly+reserved>auth.monthlyCreditLimit) return c.json(errorBody('Monthly credit limit exceeded.','monthly_limit_exceeded'),429);
  const reqId=id('req'), reservationId=id('res'), now=nowIso(), expires=new Date(Date.now()+10*60_000).toISOString(), idem=c.req.header('Idempotency-Key')||null;
  if(idem){ const old=await c.env.DB.prepare('SELECT id,status,http_status FROM usage_requests WHERE user_id=? AND idempotency_key=?').bind(auth.userId,idem) as any; if(old)return c.json(errorBody(`Duplicate idempotency key; original request ${old.id} is ${old.status}.`,'duplicate_request'),409); }
  const debit=await c.env.DB.prepare('UPDATE users SET credit_balance=credit_balance-?,updated_at=? WHERE id=? AND credit_balance>=?').bind(reserved,now,auth.userId,reserved).run();
  if(Number(debit.meta.changes||0)!==1) return c.json(errorBody('Insufficient credit.','insufficient_credit','insufficient_quota'),402);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO usage_requests (id,organization_id,user_id,api_key_id,model_id,status,is_stream,idempotency_key,reserved_credit,input_price_snapshot,output_price_snapshot,cached_input_price_snapshot,markup_bps_snapshot,created_at) VALUES (?,?,?,?,?,'processing',?,?,?,?,?,?,?,?)`).bind(reqId,auth.organizationId,auth.userId,auth.apiKeyId,model.id,stream?1:0,idem,reserved,model.input_price_per_million,model.output_price_per_million,model.cached_input_price_per_million,model.internal_markup_bps,now),
      c.env.DB.prepare(`INSERT INTO credit_reservations (id,user_id,usage_request_id,amount,status,expires_at,created_at) VALUES (?,?,?,?,'reserved',?,?)`).bind(reservationId,auth.userId,reqId,reserved,expires,now)
    ]);
  } catch {
    await c.env.DB.prepare('UPDATE users SET credit_balance=credit_balance+?,updated_at=? WHERE id=?').bind(reserved,nowIso(),auth.userId).run();
    return c.json(errorBody('Could not create credit reservation.','reservation_failed'),500);
  }
  const secret=c.env[model.secret_binding_name]; if(typeof secret!=='string' || !secret){ await refund(c.env,auth,reqId,reservationId,reserved,'provider_secret_missing'); return c.json(errorBody('Provider is not configured.','provider_unavailable'),502); }
  const started=Date.now(); let upstream:Response;
  try { upstream=await fetch(`${model.base_url}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(payload)}); }
  catch { await refund(c.env,auth,reqId,reservationId,reserved,'provider_network_error'); return c.json(errorBody('Provider unavailable.','provider_unavailable'),502); }
  if(!upstream.ok){ const detail=await upstream.text(); await refund(c.env,auth,reqId,reservationId,reserved,`provider_${upstream.status}`); return new Response(detail,{status:upstream.status,headers:{'Content-Type':upstream.headers.get('Content-Type')||'application/json','X-Gateway-Request-Id':reqId}}); }
  if(stream && upstream.body){
    const {readable,writable}=new TransformStream(); const writer=writable.getWriter(); const reader=upstream.body.getReader(); const decoder=new TextDecoder(); let buffer=''; let usage:any=null;
    c.executionCtx.waitUntil((async()=>{ try{ while(true){ const {done,value}=await reader.read(); if(done)break; await writer.write(value); buffer+=decoder.decode(value,{stream:true}); const lines=buffer.split('\n'); buffer=lines.pop()||''; for(const line of lines){ if(!line.startsWith('data: '))continue; const d=line.slice(6).trim(); if(d==='[DONE]')continue; try{const j=JSON.parse(d); if(j.usage)usage=j.usage;}catch{} } } await writer.close(); await settle(c.env,auth,model,reqId,reservationId,reserved,usage||{},Date.now()-started,200,true); }catch(e){ await writer.abort(e); await settle(c.env,auth,model,reqId,reservationId,reserved,usage||{},Date.now()-started,200,true); } })());
    const h=new Headers(upstream.headers); h.set('X-Gateway-Request-Id',reqId); return new Response(readable,{status:upstream.status,headers:h});
  }
  const body=await upstream.json<any>(); const usage=body.usage||{}; const actual=await settle(c.env,auth,model,reqId,reservationId,reserved,usage,Date.now()-started,upstream.status,false); const remaining=(await c.env.DB.prepare('SELECT credit_balance FROM users WHERE id=?').bind(auth.userId) as any)?.credit_balance||0;
  const h=new Headers(upstream.headers); h.set('Content-Type','application/json'); h.set('X-Gateway-Request-Id',reqId); h.set('X-Credit-Used',String(actual)); h.set('X-Credit-Remaining',String(remaining)); h.set('X-Input-Tokens',String(usage.prompt_tokens||usage.input_tokens||0)); h.set('X-Output-Tokens',String(usage.completion_tokens||usage.output_tokens||0)); return new Response(JSON.stringify(body),{status:upstream.status,headers:h});
});

async function refund(env:Env,auth:UserAuth,reqId:string,resId:string,reserved:number,errorCode:string){const now=nowIso();await env.DB.batch([env.DB.prepare('UPDATE users SET credit_balance=credit_balance+?,updated_at=? WHERE id=?').bind(reserved,now,auth.userId),env.DB.prepare(`UPDATE credit_reservations SET status='released',settled_at=? WHERE id=?`).bind(now,resId),env.DB.prepare(`UPDATE usage_requests SET status='failed',error_code=?,completed_at=? WHERE id=?`).bind(errorCode,now,reqId)]);}
async function settle(env:Env,auth:UserAuth,model:ModelRow,reqId:string,resId:string,reserved:number,usage:any,latency:number,httpStatus:number,estimated:boolean){const input=Number(usage.prompt_tokens??usage.input_tokens??0),output=Number(usage.completion_tokens??usage.output_tokens??0),cached=Number(usage.prompt_tokens_details?.cached_tokens??usage.cached_input_tokens??0);let actual=(input||output)?calculateCredit(input,output,cached,model.input_price_per_million,model.output_price_per_million,model.cached_input_price_per_million,model.internal_markup_bps):reserved; actual=Math.min(actual,reserved); const refundAmount=reserved-actual,now=nowIso(); const current=await env.DB.prepare('SELECT credit_balance FROM users WHERE id=?').bind(auth.userId) as any; const before=Number(current?.credit_balance||0),after=before+refundAmount; await env.DB.batch([env.DB.prepare('UPDATE users SET credit_balance=credit_balance+?,updated_at=? WHERE id=?').bind(refundAmount,now,auth.userId),env.DB.prepare(`UPDATE credit_reservations SET status='settled',settled_at=? WHERE id=?`).bind(now,resId),env.DB.prepare(`UPDATE usage_requests SET status='completed',input_tokens=?,output_tokens=?,cached_input_tokens=?,total_tokens=?,actual_credit=?,http_status=?,latency_ms=?,error_code=?,completed_at=? WHERE id=?`).bind(input,output,cached,input+output,actual,httpStatus,latency,estimated&&!(input||output)?'estimated_usage':null,now,reqId),env.DB.prepare(`INSERT INTO credit_ledger (id,organization_id,user_id,type,amount,balance_before,balance_after,reference_type,reference_id,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id('led'),auth.organizationId,auth.userId,'usage_debit',-actual,before+reserved,after,'usage_request',reqId,'LLM usage',now),env.DB.prepare(`INSERT INTO usage_daily (date,organization_id,user_id,model_id,request_count,input_tokens,output_tokens,total_credit,error_count) VALUES (?,?,?,?,1,?,?,?,0) ON CONFLICT(date,user_id,model_id) DO UPDATE SET request_count=request_count+1,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,total_credit=total_credit+excluded.total_credit`).bind(dateKey(),auth.organizationId,auth.userId,model.id,input,output,actual)]); return actual;}

async function cleanup(env:Env){const expired=await env.DB.prepare(`SELECT r.id,r.user_id,r.usage_request_id,r.amount FROM credit_reservations r WHERE r.status='reserved' AND r.expires_at<? LIMIT 100`).bind(nowIso()).all<any>(); for(const r of expired.results||[]){await env.DB.batch([env.DB.prepare('UPDATE users SET credit_balance=credit_balance+? WHERE id=?').bind(r.amount,r.user_id),env.DB.prepare(`UPDATE credit_reservations SET status='expired',settled_at=? WHERE id=?`).bind(nowIso(),r.id),env.DB.prepare(`UPDATE usage_requests SET status='failed',error_code='reservation_expired',completed_at=? WHERE id=? AND status='processing'`).bind(nowIso(),r.usage_request_id)]);}}

export default { fetch: app.fetch, scheduled: (_controller:ScheduledController,env:Env,ctx:ExecutionContext)=>ctx.waitUntil(cleanup(env)) };
export { app };
