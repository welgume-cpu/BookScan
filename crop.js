// Normalized points in clockwise order: TL, TR, BR, BL.
export const fullQuad=()=>[[0,0],[1,0],[1,1],[0,1]];
export function validQuad(q){return q.length===4&&q.every(p=>p.every(v=>Number.isFinite(v)&&v>=0&&v<=1))&&q.every((p,i)=>{const b=q[(i+1)%4],c=q[(i+2)%4];return (b[0]-p[0])*(c[1]-b[1])-(b[1]-p[1])*(c[0]-b[0])>.008})}
// Automatic detection for a fully visible, open book on a contrasting background.
// Fit four independent boundary lines instead of selecting extreme bright pixels.
const median=a=>quantile(a,.5);
function quantile(a,p){if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*(s.length-1)))]}
function lineFit(pts,outward){
 if(pts.length<8)return null;
 const slopes=[];for(let i=0;i<pts.length;i+=3)for(let j=i+5;j<pts.length;j+=3){if(Math.abs(pts[j][0]-pts[i][0])>4)slopes.push((pts[j][1]-pts[i][1])/(pts[j][0]-pts[i][0]));}
 const a=median(slopes);if(!Number.isFinite(a)||Math.abs(a)>.85)return null;
 const intercepts=pts.map(([x,y])=>y-a*x),mid=median(intercepts),err=median(intercepts.map(v=>Math.abs(v-mid)));
 if(err>3.5)return null;
 // A small outward allowance retains the paper margin; no large rectangle fallback.
 const b=quantile(intercepts,outward<0?.18:.82)+outward*.7;
 return {a,b,err};
}
function intersect(v,h){const y=(h.a*v.b+h.b)/(1-h.a*v.a);return [v.a*y+v.b,y]}
function estimate(mask,w,h,lum){
 const n=w*h,dil=new Uint8Array(n),closed=new Uint8Array(n);
 for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;dil[i]=mask[i]||mask[i-1]||mask[i+1]||mask[i-w]||mask[i+w]}
 for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){const i=y*w+x;closed[i]=dil[i]&&dil[i-1]&&dil[i+1]&&dil[i-w]&&dil[i+w]}
 const queue=new Int32Array(n),components=[];
 for(let k=0;k<n;k++){if(!closed[k])continue;let head=0,tail=1;queue[0]=k;closed[k]=0;while(head<tail){const i=queue[head++],x=i%w;for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,i-w,i+w])if(j>=0&&j<n&&closed[j]){closed[j]=0;queue[tail++]=j}}if(tail>n*.035)components.push(queue.slice(0,tail))}
 components.sort((a,b)=>b.length-a.length);if(!components.length)return null;
 const pts=[components[0]]; // Join two substantial adjacent page components if the gutter is dark.
 if(components[1]&&components[1].length>components[0].length*.35){
  const bounds=p=>{let x0=w,x1=0,y0=h,y1=0;for(const i of p){const x=i%w,y=Math.floor(i/w);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)}return [x0,x1,y0,y1]};
  const a=bounds(components[0]),b=bounds(components[1]),overlap=Math.min(a[3],b[3])-Math.max(a[2],b[2]),gap=Math.max(a[0],b[0])-Math.min(a[1],b[1]);
  if(overlap>Math.min(a[3]-a[2],b[3]-b[2])*.65&&gap>-w*.10&&gap<w*.08)pts.push(components[1]);
 }
 let x0=w,y0=h,x1=0,y1=0,count=0;const l=new Int32Array(h).fill(w),r=new Int32Array(h).fill(-1),t=new Int32Array(w).fill(h),b=new Int32Array(w).fill(-1);
 for(const comp of pts)for(const i of comp){const x=i%w,y=Math.floor(i/w);count++;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);l[y]=Math.min(l[y],x);r[y]=Math.max(r[y],x);t[x]=Math.min(t[x],y);b[x]=Math.max(b[x],y)}
 const bw=x1-x0,bh=y1-y0;if(count<n*.13||bw<w*.33||bh<h*.30||x0<4||y0<4||x1>w-5||y1>h-5)return null;
 const lp=[],rp=[],tp=[],bp=[];
 for(let y=Math.ceil(y0+bh*.20);y<=y0+bh*.80;y++)if(r[y]-l[y]>bw*.45){lp.push([y,l[y]]);rp.push([y,r[y]])}
 for(let x=Math.ceil(x0+bw*.20);x<=x0+bw*.80;x++)if(b[x]-t[x]>bh*.45){tp.push([x,t[x]]);bp.push([x,b[x]])}
 const L=lineFit(lp,-1),R=lineFit(rp,1),T=lineFit(tp,-1),B=lineFit(bp,1);if(!L||!R||!T||!B)return null;
 const p=[intersect(L,T),intersect(R,T),intersect(R,B),intersect(L,B)];
 const q=p.map(([x,y])=>[x/(w-1),y/(h-1)]);if(!validQuad(q)||q.some(([x,y])=>x<.009||x>.991||y<.009||y>.991))return null;
 const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),width=(dist(p[0],p[1])+dist(p[2],p[3]))/2,height=(dist(p[0],p[3])+dist(p[1],p[2]))/2;
 if(width/height<.50||width/height>2.55||width*height<n*.16||width*height>n*.91||count/(width*height)<.44)return null;
 // Confirm actual paper/background contrast on EACH side, not just a bright bounding box.
 const get=(x,y)=>lum[Math.max(0,Math.min(h-1,Math.round(y)))*w+Math.max(0,Math.min(w-1,Math.round(x)))];
 const cx=p.reduce((s,a)=>s+a[0],0)/4,cy=p.reduce((s,a)=>s+a[1],0)/4;let score=0;
 for(let i=0;i<4;i++){
  const a=p[i],z=p[(i+1)%4],dx=z[0]-a[0],dy=z[1]-a[1],len=Math.hypot(dx,dy);let nx=-dy/len,ny=dx/len;
  if((cx-(a[0]+z[0])/2)*nx+(cy-(a[1]+z[1])/2)*ny<0){nx=-nx;ny=-ny}
  let hits=0;const ds=[];for(let j=2;j<=18;j++){const u=j/20,x=a[0]+dx*u,y=a[1]+dy*u;const delta=(get(x+nx*4,y+ny*4)+get(x+nx*7,y+ny*7))/2-(get(x-nx*4,y-ny*4)+get(x-nx*7,y-ny*7))/2;ds.push(delta);if(delta>13)hits++}
  if(hits<10||median(ds)<19)return null;score+=median(ds)+hits*2;
 }
 return {q,score:score-(L.err+R.err+T.err+B.err)*5};
}
export function detectPixels(data,w,h){
 if(w<32||h<32)return null;const n=w*h,lum=new Float32Array(n),border=[],hist=new Array(256).fill(0);
 for(let i=0;i<n;i++){const j=i*4,v=.299*data[j]+.587*data[j+1]+.114*data[j+2];lum[i]=v;hist[Math.round(v)]++;const x=i%w,y=Math.floor(i/w);if(x<4||y<4||x>=w-4||y>=h-4)border.push(v)}
 const bg=median(border);let acc=0,bright=255;for(let i=0;i<256;i++){acc+=hist[i];if(acc>=n*.84){bright=i;break}}
 let best=null;for(const fraction of bright-bg>=27?[.34,.50,.66]:[]){const threshold=bg+(bright-bg)*fraction,mask=new Uint8Array(n);for(let i=0;i<n;i++)mask[i]=lum[i]>=threshold?1:0;const candidate=estimate(mask,w,h,lum);if(candidate&&(!best||candidate.score>best.score))best=candidate}
 if(best)return best.q;
 // Fallback for colored/dark covers: compare each pixel's RGB color with the mat at the frame border.
 // Keep the same four-edge validation; do not crop to the entire camera frame on failure.
 const rb=[],gb=[],bb=[];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  if(x>=4&&x<w-4&&y>=4&&y<h-4)continue;
  const j=(y*w+x)*4;rb.push(data[j]);gb.push(data[j+1]);bb.push(data[j+2]);
 }
 const baseR=median(rb),baseG=median(gb),baseB=median(bb);
 const contrast=new Float32Array(n),chist=new Uint32Array(256);
 for(let i=0;i<n;i++){
  const j=i*4,v=Math.max(Math.abs(data[j]-baseR),Math.abs(data[j+1]-baseG),Math.abs(data[j+2]-baseB));
  contrast[i]=v;chist[Math.min(255,Math.round(v))]++;
 }
 let cumul=0,top=0;for(let i=0;i<256;i++){cumul+=chist[i];if(cumul>=n*.84){top=i;break}}
 if(top<34)return null;
 for(const fraction of [.35,.50,.65]){
  const threshold=Math.max(15,top*fraction),mask=new Uint8Array(n);
  for(let i=0;i<n;i++)mask[i]=contrast[i]>=threshold?1:0;
  const candidate=estimate(mask,w,h,contrast);
  if(candidate&&(!best||candidate.score>best.score))best=candidate;
 }
 return best?.q??null;
}

export function detectBook(image,w,h){const c=document.createElement('canvas'),scale=Math.min(1,440/Math.max(w,h));c.width=Math.round(w*scale);c.height=Math.round(h*scale);const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,c.width,c.height);return detectPixels(ctx.getImageData(0,0,c.width,c.height).data,c.width,c.height)}
export function quadDifference(a,b){return !a||!b?Infinity:Math.max(...a.map((p,i)=>Math.hypot(p[0]-b[i][0],p[1]-b[i][1])))}
export function homography(q){const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]=q;const dx1=x1-x2,dx2=x3-x2,dx3=x0-x1+x2-x3,dy1=y1-y2,dy2=y3-y2,dy3=y0-y1+y2-y3;const den=dx1*dy2-dx2*dy1;if(Math.abs(den)<1e-10)throw Error('四角范围无效');const g=(dx3*dy2-dx2*dy3)/den,h=(dx1*dy3-dx3*dy1)/den;return [x1-x0+g*x1,x3-x0+h*x3,x0,y1-y0+g*y1,y3-y0+h*y3,y0,g,h]}
export function rectify(image,q){if(!validQuad(q))throw Error('请按顺序调整四角，不可交叉');const w=image.width,h=image.height;const dist=(a,b)=>Math.hypot((a[0]-b[0])*w,(a[1]-b[1])*h);let ow=Math.round(Math.max(dist(q[0],q[1]),dist(q[3],q[2]))),oh=Math.round(Math.max(dist(q[0],q[3]),dist(q[1],q[2])));const scale=Math.min(1,3600/Math.max(ow,oh));ow=Math.max(1,Math.round(ow*scale));oh=Math.max(1,Math.round(oh*scale));const src=document.createElement('canvas');src.width=w;src.height=h;const sc=src.getContext('2d',{willReadFrequently:true});sc.drawImage(image,0,0);const a=sc.getImageData(0,0,w,h).data;const out=document.createElement('canvas');out.width=ow;out.height=oh;const ctx=out.getContext('2d');const im=ctx.createImageData(ow,oh),d=im.data;const [A,B,C,D,E,F,G,H]=homography(q);for(let y=0;y<oh;y++){const v=(y+.5)/oh;for(let x=0;x<ow;x++){const u=(x+.5)/ow,z=G*u+H*v+1;const sx=Math.max(0,Math.min(w-1,((A*u+B*v+C)/z)*w-.5)),sy=Math.max(0,Math.min(h-1,((D*u+E*v+F)/z)*h-.5));const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy,p=(iy*w+ix)*4,p1=(iy*w+Math.min(w-1,ix+1))*4,p2=(Math.min(h-1,iy+1)*w+ix)*4,p3=(Math.min(h-1,iy+1)*w+Math.min(w-1,ix+1))*4,k=(y*ow+x)*4;for(let c=0;c<3;c++)d[k+c]=(a[p+c]*(1-fx)+a[p1+c]*fx)*(1-fy)+(a[p2+c]*(1-fx)+a[p3+c]*fx)*fy;d[k+3]=255}}ctx.putImageData(im,0,0);src.width=src.height=1;return out}
