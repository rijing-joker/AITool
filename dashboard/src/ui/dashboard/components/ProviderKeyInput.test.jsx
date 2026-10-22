import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
import { ProviderKeyInput } from './ProviderKeyInput';
import { clearLocalApiAuthToken } from '../../../lib/local-api-auth';
import { copy } from '../../../lib/copy';
afterEach(()=>{vi.unstubAllGlobals();clearLocalApiAuthToken();});
it('saves only through the authenticated local endpoint and guards rapid repeated clicks',async()=>{
  let finish;let writes=0; const bodies=[];
  const fetchMock=vi.fn(async(url,options)=>{
    if(url==='/api/local-auth')return new Response(JSON.stringify({token:'local'}));
    if(options?.method==='PUT'){writes++;bodies.push(options);return new Promise(resolve=>{finish=()=>resolve(new Response(JSON.stringify({ok:true})));});}
    return new Response(JSON.stringify({ok:true,configured:false,source:'env'}));
  });vi.stubGlobal('fetch',fetchMock);
  render(<ProviderKeyInput provider="command-code" />);
  await screen.findByText(copy('limits.key.env'));
  const input=screen.getByLabelText(copy('limits.key.label'));expect(input).toHaveAttribute('autocapitalize','none');
  fireEvent.change(input,{target:{value:'fixture-private-key'}});const button=screen.getByRole('button',{name:copy('limits.key.save')});
  fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(writes).toBe(1));
  expect(bodies[0].headers['x-tokentracker-local-auth']).toBe('local');expect(JSON.parse(bodies[0].body)).toEqual({apiKey:'fixture-private-key'});
  finish();await waitFor(()=>expect(input).toHaveValue(''));
  expect(fetchMock.mock.calls.every(([url])=>String(url).startsWith('/api/'))).toBe(true);
});
