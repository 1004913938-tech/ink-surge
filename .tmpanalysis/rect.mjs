import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch();
const p = await b.newPage();
const [,, X,Y,W,H, ...files] = process.argv;
const args = files.map(f=>({f,d:'data:image/png;base64,'+readFileSync(f).toString('base64')}));
const out = await p.evaluate(async ([args,R]) => {
  const [X,Y,W,H]=R.map(Number); const res=[];
  for (const {f,d} of args){
    const img=new Image(); img.src=d; await img.decode();
    const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
    const g=c.getContext('2d'); g.drawImage(img,0,0);
    const D=g.getImageData(X,Y,W,H).data;
    let s=0,n=0; const counts=new Map();
    for(let i=0;i<D.length;i+=4){const r=D[i],gg=D[i+1],bb=D[i+2];
      const mx=Math.max(r,gg,bb),mn=Math.min(r,gg,bb); s+=mx===0?0:(mx-mn)/mx;n++;
      counts.set(`${r},${gg},${bb}`,(counts.get(`${r},${gg},${bb}`)||0)+1);}
    const top=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>{
      const [r,gg,bb]=k.split(',').map(Number); const mx=Math.max(r,gg,bb),mn=Math.min(r,gg,bb);
      return `(${k}) sat ${(mx===0?0:(mx-mn)/mx).toFixed(2)} L${Math.round(0.2126*r+0.7152*gg+0.0722*bb)} ×${(100*v/n).toFixed(1)}%`;});
    res.push({f,uniq:counts.size,meanSat:(s/n).toFixed(3),top});
  }
  return res;
}, [args,[X,Y,W,H]]);
console.log(JSON.stringify(out,null,1)); await b.close();
