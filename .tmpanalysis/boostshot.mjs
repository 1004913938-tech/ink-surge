import { chromium } from 'playwright';
const b = await chromium.launch({headless:true, args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio']});
const c = await b.newContext({viewport:{width:1440,height:810}, deviceScaleFactor:2});
const p = await c.newPage();
await p.goto('http://localhost:5306/?harness=1&seed=2247',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__INKTIDE__?.ready===true,null,{timeout:90000});
const r = await p.evaluate(async ()=>{
  const H=window.__INKTIDE__; H.reset(); H.setPhase('racing');
  H.setControls({autopilot:true, throttle:1, drift:true});
  const h = await H.simulateUntil('s.boostTime > 0.2', 90, 1/60);
  H.setCameraPreset('chase'); await H.settle(1);
  return {h, st:H.stats()};
});
console.log(JSON.stringify(r));
await p.screenshot({path:'shots/pres2_r4/boostframe.png', animations:'disabled'});
await b.close();
