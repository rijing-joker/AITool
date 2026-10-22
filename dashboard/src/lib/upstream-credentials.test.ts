import { describe, it, expect, vi } from 'vitest';
import { refreshCredential, refreshAllCredentials, runCredentialBatch } from './easy-credential-operations';
import { authFileSettingsFromPayload, buildAuthFileSettingsPatch, hasUniqueAuthFileName } from './easy-auth';
import { parsePluginQuota, resolveQuotaPlugin, supportsPluginQuota } from './plugin-credential-quota';

describe('upstream credential operations', () => {
  it('targets runtime index and excludes raw tokens from batch results', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, access_token:'private', results:[{id:'one',success:false,error:'safe'}] });
    await refreshCredential({ name:'same.json', provider:'codex', auth_index:'42' }, {post});
    expect(post).toHaveBeenCalledWith('/credentials/refresh',{name:'same.json',auth_index:'42'},{timeoutMs:300000});
    expect(await refreshAllCredentials({post})).toEqual([{id:'one',success:false,error:'safe'}]);
    await expect(refreshCredential({name:'same.json',provider:'codex',disabled:true},{post})).rejects.toThrow();
  });
  it('continues after an individual failure and never overlaps requests', async () => {
    let active=0; const order:string[]=[];
    const results=await runCredentialBatch([{name:'one'},{name:'two'},{name:'three'}],async file=>{
      active++; expect(active).toBe(1);order.push(String(file.name));await Promise.resolve();active--;
      if(file.name==='two') throw new Error('failed');
    });
    expect(order).toEqual(['one','two','three']);expect(results.map(row=>row.success)).toEqual([true,false,true]);
  });
  it('blocks filename-only operations for same-name runtime credentials', async () => {
    const files=[{name:'same.json',auth_index:'1'},{name:'same.json',auth_index:'2'}];
    expect(hasUniqueAuthFileName(files,files[1])).toBe(false);
    expect(hasUniqueAuthFileName([files[1]],files[1])).toBe(true);
    expect((await runCredentialBatch(files,async()=>{})).map(row=>row.id)).toEqual(['same.json · 1','same.json · 2']);
  });
  it('round-trips inherited overrides and validates status/action/match fields', () => {
    const rules=[{status:429,action:'continue-and-cooldown',match:['quota'],'match-regexr':['rate.*']}];
    const original=authFileSettingsFromPayload({request_retry:3,using_api:false,request_scoped_errors:rules});
    expect(buildAuthFileSettingsPatch(original,{...original})).toEqual({});
    expect(buildAuthFileSettingsPatch(original,{...original,request_retry:'',using_api:'',request_scoped_errors:''})).toMatchObject({request_retry:null,using_api:null,request_scoped_errors:null});
    for(const bad of [{status:99,action:'stop'},{status:429,action:'retry'},{status:429,action:'stop',match:'quota'}]) {
      expect(()=>buildAuthFileSettingsPatch(original,{...original,request_scoped_errors:JSON.stringify([bad])})).toThrow();
    }
  });
  it('matches only registered quota plugins and refuses ambiguous provider matches', () => {
    const available={id:'plugin-a',registered:true,supportsQuota:true,quotaProvider:'provider-one'};
    expect(resolveQuotaPlugin([available],'provider_one')).toBe('plugin-a');
    expect(resolveQuotaPlugin([available,{...available,id:'plugin-b'}],'provider-one')).toBe('');
    expect(resolveQuotaPlugin([available],'unknown')).toBe('');
    expect(supportsPluginQuota({quota_plugin_id:'plugin-a',supports_quota:false})).toBe(false);
    const rows=parsePluginQuota({token:'private',groups:[{displayName:'Plan',buckets:[{window:'5h',remainingFraction:.25,token:'private'}]}],summary:[{label:'Credit',value:12,unit:'USD'}]});
    expect(rows[0].remainingPercent).toBe(25);expect(rows[1].detail).toBe('12 USD');expect(JSON.stringify(rows)).not.toContain('private');
    expect(()=>parsePluginQuota({groups:{}})).toThrow();
  });
});
