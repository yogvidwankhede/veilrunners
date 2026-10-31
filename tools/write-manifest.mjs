import fs from 'node:fs'; import path from 'node:path';
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..'); const A=path.join(ROOT,'assets');
const has=f=>fs.existsSync(path.join(A,f));
const MAP={walls:[{x:440,y:310,w:110,h:130},{x:650,y:310,w:110,h:130},{x:440,y:520,w:320,h:45},{x:200,y:260,w:45,h:210},{x:950,y:400,w:45,h:210},{x:480,y:140,w:240,h:35},{x:280,y:700,w:170,h:40}],
  bushes:[{x:100,y:380,w:95,h:200},{x:805,y:170,w:160,h:130},{x:770,y:670,w:135,h:115},{x:300,y:440,w:100,h:150}]};
const perim=[]; for(let i=0;i<22;i++){const a=i/22*Math.PI*2;perim.push({x:600+Math.cos(a)*720,y:450+Math.sin(a)*560,s:0.9+Math.random()*0.6,ry:Math.random()*6});}
const props={}; if(has('tree.glb'))props.tree={file:'tree.glb',override:'trees',at:perim};
if(has('torch.glb'))props.torch={file:'torch.glb',y:1.4,at:MAP.walls.filter(w=>w.w>100||w.h>100).map(w=>({x:w.x+w.w,y:w.y+w.h/2}))};
if(has('fern.glb'))props.fern={file:'fern.glb',override:'bushes',at:MAP.bushes.map(b=>({x:b.x+b.w/2,y:b.y+b.h/2}))};
if(has('ruin.glb'))props.ruin={file:'ruin.glb',at:[{x:300,y:300,s:1,ry:0.4},{x:900,y:650,s:1.1,ry:2.1},{x:520,y:260,s:0.8,ry:1}]};
const man={runner:has('runner.glb')?'runner.glb':null,relic:has('relic.glb')?'relic.glb':null,props};
fs.writeFileSync(path.join(A,'manifest.json'),JSON.stringify(man,null,2));
console.log('wrote assets/manifest.json');
