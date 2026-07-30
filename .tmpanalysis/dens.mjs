import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b=await chromium.launch(); const p=await b.newPage();
const specs = JSON.parse(process.argv[2]);
const args = specs.map(s=>({...s, d:'data:image/png;base64,'+readFileSync(s.f).toString('base64')}));
const out = await p.evaluate(async (args)=>{
  const res=[];
  for(const a of args){
    const img=new Image(); img.src=a.d; await img.decode();
    const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
    const g=c.getContext('2d'); g.drawImage(img,0,0);
    const D=g.getImageData(a.x,a.y,a.w,a.h).data;
    let ch=0,tot=0;
    for(let y=0;y<a.h;y++){
      for(let x=1;x<a.w;x++){
        const i=(y*a.w+x)*4, j=(y*a.w+x-1)*4;
        if(Math.abs(D[i]-D[j])+Math.abs(D[i+1]-D[j+1])+Math.abs(D[i+2]-D[j+2])>18) ch++;
        tot++;
      }
    }
    res.push({f:a.f, band:[a.x,a.y,a.w,a.h], per100px:+(100*ch/tot).toFixed(2)});
  }
  return res;
}, args);
console.log(JSON.stringify(out,null,1)); await b.close();
