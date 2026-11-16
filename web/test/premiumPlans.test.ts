import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
const read=(f:string)=>readFileSync(new URL(f,import.meta.url),'utf8');
const SURFACES=['../src/pages/TakeoffCanvas.jsx','../src/components/PlanNavigator.jsx','../src/components/WorkspaceChrome.jsx'];
// FLOOR360 keeps its Request Premium form (onPremium / data-premium-trigger); only upstream's pricing links are gone.
test('the app has no Premium plans button, menu item or pricing link',()=>{
  const src=SURFACES.map(read).join('\n');
  assert.equal(/Premium plans|openPremiumPricing/.test(src),false);
  assert.equal(/kentucky-ai\.com\/#pricing/.test(src),false);
  assert.equal(existsSync(new URL('../src/lib/premiumPlans.js',import.meta.url)),false);
  assert.equal(existsSync(new URL('../scripts/verify-premium-plans.mjs',import.meta.url)),false);
});
test('the app carries no in-app plans dialog',()=>{
  assert.equal(/premium-plans-dialog|PremiumPlans\b/.test(SURFACES.map(read).join('\n')),false);
});
test('Request Premium stays wired to the early-access form',()=>{
  for(const f of ['../src/components/PlanNavigator.jsx','../src/components/WorkspaceChrome.jsx']){
    const src=read(f);
    assert.match(src,/data-premium-trigger/,f);
    assert.match(src,/Request Premium/,f);
  }
  assert.match(read('../src/pages/TakeoffCanvas.jsx'),/onPremium=/);
  assert.equal(read('../index.html').includes('name="premium-interest"'),true);
});
