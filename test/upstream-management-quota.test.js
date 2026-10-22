"use strict";
const { test }=require("node:test");
const assert=require("node:assert/strict");
const {Readable}=require("node:stream");
const management=require("../src/lib/proxy/management");
const {handleProxyApiRequest}=require("../src/lib/proxy/api");
const plans=require("../src/lib/provider-switch/plan-quota");
test("credential refresh has extended timeout and strips secrets from single/batch successes and failures",async t=>{
  let response={ok:true,status:200,data:{ok:true,access_token:"private",refresh_token:"private"}};let options;
  t.mock.method(management,"request",async (_method,_route,value)=>{options=value;return response;});
  const call=async()=>{const req=Readable.from([Buffer.from(JSON.stringify({method:"POST",path:"/credentials/refresh",body:{name:"one.json",auth_index:"42"},timeoutMs:300000}))]);req.method="POST";let payload;await handleProxyApiRequest(req,{writeHead(){},end:value=>{payload=JSON.parse(value);}},new URL("http://localhost/api/proxy/management-request"),{isAuthorizedLocalMutation:()=>true});return payload;};
  assert.deepEqual((await call()).value,{ok:true});assert.equal(options.timeoutMs,300000);assert.equal(options.body.auth_index,"42");
  response.data={ok:true,results:[{id:"one.json",success:false,error:"access_token=private"}],token:"private"};
  assert.deepEqual((await call()).value,{ok:true,results:[{id:"one.json",success:false,error:"Credential refresh failed"}]});
  response={ok:false,status:401,data:{error:"private token"}};assert.equal((await call()).error,"Credential refresh failed");
});
test("plugin quota legacy fallback is limited to missing routes and every reply is sanitized", async t => {
  const calls = [];
  let status = 404;
  t.mock.method(management, "request", async (_verb, route, options) => {
    calls.push({ route, options });
    return route.startsWith("/v8/") ? { ok:false, status, data:{ error:"private upstream response" } }
      : { ok:true, status:200, data:{ token:"private", groups:[{displayName:"Plan",buckets:[{remainingFraction:.5,access_token:"private"}]}],summary:[{label:"Credit",value:12,token:"private"}] } };
  });
  const call = async () => {
    const req=Readable.from([Buffer.from(JSON.stringify({ method:"POST",path:"/plugins/fixture/quota",body:{auth_index:"42"} }))]); req.method="POST";
    let payload; await handleProxyApiRequest(req,{writeHead(){},end:value=>{payload=JSON.parse(value);}},new URL("http://localhost/api/proxy/management-request"),{isAuthorizedLocalMutation:()=>true});return payload;
  };
  const result = await call();
  assert.equal(result.ok,true); assert.equal(JSON.stringify(result).includes("private"),false);
  assert.deepEqual(calls.map(row=>row.route),["/v8/management/plugins/fixture/quota","/v0/management/plugins/fixture/quota"]);
  assert.equal(calls[1].options.body.auth_index,"42");
  calls.length=0; status=403; assert.equal((await call()).error,"Plugin quota query failed"); assert.equal(calls.length,1);
});
test("Volcengine signed control-plane requests fall back only on unavailable plans",async()=>{
  const calls=[];const result=await plans.volc({baseUrl:"https://ark.cn-beijing.volces.com/api/v3",provider:{meta:{quotaCredentials:{accessKeyId:"AKfixture",secretAccessKey:"private-secret"}}},fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(calls.length===1?{ResponseMetadata:{Error:{Code:"PlanNotFound"}}}:{Result:{QuotaUsage:[{Level:"session",Percent:10,ResetTimestamp:1782057600},{Level:"weekly",Percent:20}]}}));}});
  assert.equal(result.tiers.length,2);assert.match(calls[0].url,/Action=GetAFPUsage/);assert.match(calls[1].url,/Action=GetCodingPlanUsage/);assert.equal(calls[0].options.body,"");assert.match(calls[0].options.headers.Authorization,/SignedHeaders=host;x-date;x-content-sha256;content-type/);assert.equal(JSON.stringify(calls).includes("private-secret"),false);
  let attempts=0;await assert.rejects(plans.volc({baseUrl:"https://ark.cn-beijing.volces.com",provider:{meta:{quotaCredentials:{accessKeyId:"AK",secretAccessKey:"secret"}}},fetchImpl:async()=>{attempts++;return new Response(JSON.stringify({ResponseMetadata:{Error:{Code:"SignatureDoesNotMatch"}}}));}}),/credentials|permissions/);assert.equal(attempts,1);
});
test("Zhipu pay-as-you-go falls back to available balance and keeps zero valid",async()=>{
  const calls=[];const result=await plans.zhipu({baseUrl:"https://open.bigmodel.cn/api/paas/v4",apiKey:"private",fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(calls.length===1?{success:false,msg:"Coding Plan 不存在"}:{success:true,data:{availableBalance:0,balance:10}}));}});
  assert.equal(result.balances[0].remaining,0);assert.equal(result.balances[0].isValid,true);assert.equal(result.balances[0].unit,"CNY");assert.match(calls[1].url,/query-customer-account-report/);assert.equal(calls[1].options.headers.Authorization,"private");
});
