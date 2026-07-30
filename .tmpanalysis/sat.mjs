import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch();
const p = await b.newPage();
const files = process.argv.slice(2);
const args = [];
for (const f of files) args.push({ f, d: 'data:image/png;base64,' + readFileSync(f).toString('base64') });
const out = await p.evaluate(async (args) => {
  const res = [];
  for (const {f,d} of args) {
    const img = new Image(); img.src = d; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img,0,0);
    // sky crop 130-1230 x, 40-600 y (device px)
    const D = g.getImageData(130,40,1100,560).data;
    let s=0,n=0; const counts=new Map();
    for (let i=0;i<D.length;i+=4){
      const r=D[i],gg=D[i+1],bb=D[i+2];
      const mx=Math.max(r,gg,bb),mn=Math.min(r,gg,bb);
      s += mx===0?0:(mx-mn)/mx; n++;
      const k=`${r},${gg},${bb}`; counts.set(k,(counts.get(k)||0)+1);
    }
    const top=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>k+' ×'+(100*v/n).toFixed(1)+'%');
    res.push({f, meanSat:(s/n).toFixed(3), top});
  }
  return res;
}, args);
console.log(JSON.stringify(out,null,1));
await b.close();
