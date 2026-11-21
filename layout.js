// V5 local, conservative single/double page classifier. Scores are heuristics, NOT calibrated probabilities.
// For ambiguous landscape pages we keep the original and request a one-time confirmation.
export function classifyPagePixels(data,w,h){
 if(w<32||h<32)return {layout:'unknown',confidence:0,reason:'图像过小'};
 const aspect=w/h;
 if(aspect<=1.08)return {layout:'single',confidence:aspect<=.96?.95:.79,reason:'单页纵向轮廓'};
 // For double pages, look for a gutter shadow OR two text blocks separated by a blank central margin.
 const gray=new Uint8Array(w*h),hist=new Uint32Array(256);
 for(let i=0;i<gray.length;i++){
  const k=i*4,v=Math.round(data[k]*.299+data[k+1]*.587+data[k+2]*.114);gray[i]=v;hist[v]++;
 }
 let acc=0,paper=255;for(let i=0;i<256;i++){acc+=hist[i];if(acc>=w*h*.82){paper=i;break}}
 const inkThreshold=Math.min(155,paper-55);
 const bandInk=(lo,hi)=>{
  let ink=0,n=0;
  for(let y=Math.floor(h*.17);y<Math.floor(h*.83);y+=3){
   for(let x=Math.floor(w*lo);x<Math.floor(w*hi);x+=3){n++;if(gray[y*w+x]<inkThreshold)ink++}
  }
  return n?ink/n:0;
 };
 const left=bandInk(.13,.41),right=bandInk(.59,.87),center=bandInk(.485,.515);
 let gutterStrength=0,gutterX=null;
 const offset=Math.max(3,Math.round(w*.065));
 for(let f=.42;f<=.581;f+=.01){
  const x=Math.round(w*f);let valid=0,positive=0,sum=0;
  for(let y=Math.floor(h*.13);y<Math.floor(h*.87);y+=2){
   const v=gray[y*w+x],near=(gray[y*w+Math.max(0,x-offset)]+gray[y*w+Math.min(w-1,x+offset)])/2;
   const delta=near-v;sum+=delta;valid++;if(delta>16)positive++;
  }
  const strength=(positive/Math.max(1,valid))*(Math.max(0,sum/Math.max(1,valid))/22);
  if(strength>gutterStrength){gutterStrength=strength;gutterX=f}
 }
 const twoTextBlocks=paper>=170&&left>.018&&right>.018&&center<Math.min(left,right)*.38;
 const centralShadow=gutterStrength>.45;
 if(aspect>=1.27&&(centralShadow||twoTextBlocks)){
  return {layout:'double',confidence:centralShadow?.90:.80,reason:centralShadow?'检测到连续书脊阴影':'检测到左右文本区域与中央空白',gutter:gutterX};
 }
 return {layout:'unknown',confidence:.32,reason:'横向页面但没有足够可靠的双页证据'};
}
export function classifyLayout(image){
 const max=520,scale=Math.min(1,max/Math.max(image.width,image.height));
 const canvas=document.createElement('canvas');canvas.width=Math.max(32,Math.round(image.width*scale));canvas.height=Math.max(32,Math.round(image.height*scale));
 const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,canvas.width,canvas.height);
 const result=classifyPagePixels(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
 canvas.width=canvas.height=1;return result;
}
