import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch(); const p = await b.newPage();
const files = process.argv.slice(2);
const args = files.map(f=>({f,d:'data:image/png;base64,'+readFileSync(f).toString('base64')}));
const out = await p.evaluate(async (args) => {
  const res=[];
  for(const {f,d} of args){
    const img=new Image(); img.src=d; await img.decode();
    const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
    const g=c.getContext('2d'); g.drawImage(img,0,0);
    const D=g.getImageData(0,0,img.width,img.height).data;
    const W=img.width,H=img.height;
    // For each column in 200..2600 skipping HUD zones, find first y from top where
    // the pixel is "sea" = blue-dominant and saturated dark (b>r, L<120) after y>H*0.15
    const ys=[]; const xs=[];
    for(let x=200;x<2600;x+=8){
      let found=-1;
      for(let y=Math.floor(H*0.12); y<H*0.75; y++){
        const i=(y*W+x)*4; const r=D[i],gg=D[i+1],bb=D[i+2];
        const L=0.2126*r+0.7152*gg+0.0722*bb;
        if(L<118 && bb>r+30){found=y;break;}
      }
      if(found>0){ys.push(found);xs.push(x);}
    }
    // linear fit
    const n=ys.length; const mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n;
    let sxy=0,sxx=0; for(let i=0;i<n;i++){sxy+=(xs[i]-mx)*(ys[i]-my);sxx+=(xs[i]-mx)**2;}
    const slope=sxy/sxx, ic=my-slope*mx;
    let sd=0,mn=1e9,mxd=-1e9,maxdev=0;
    for(let i=0;i<n;i++){const dv=ys[i]-(slope*xs[i]+ic); sd+=dv*dv; mn=Math.min(mn,dv);mxd=Math.max(mxd,dv);maxdev=Math.max(maxdev,Math.abs(dv));}
    res.push({f, n, range:Math.round(mxd-mn), stdev:+(Math.sqrt(sd/n)).toFixed(1), maxdev:Math.round(maxdev), meanY:Math.round(my)});
  }
  return res;
}, args);
console.log(JSON.stringify(out,null,1)); await b.close();
