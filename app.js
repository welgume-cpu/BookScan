import {fullQuad,validQuad,detectBook,rectify,quadDifference} from './crop.js';
import {createPdf} from './pdf.js';
const $=id=>document.getElementById(id);
const DB_NAME='bookscan_v1',STORE='spreads';
let db,stream=null,auto=false,busy=false,spreads=[],lastFrame=null,lastCaptured=null,lastAt=0,stableAt=0,motionSeen=false,initialReady=false,animation=0,frameClock=0,toastTimer,ocrRunning=false,ocrStopRequested=false,editorPage=null,searchTimer=null;
const sample=document.createElement('canvas');sample.width=64;sample.height=48;
const sampleCtx=sample.getContext('2d',{willReadFrequently:true});
const guide=$('guide'),video=$('video');
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4500)}
function status(msg,active=false){$('feedback').textContent=msg;$('statusBadge').textContent=msg;$('statusBadge').classList.toggle('active',active)}
function request(tx){return new Promise((res,rej)=>{tx.onsuccess=()=>res(tx.result);tx.onerror=()=>rej(tx.error)})}
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{req.result.createObjectStore(STORE,{keyPath:'id'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function dbAll(){return new Promise((res,rej)=>{const q=db.transaction(STORE,'readonly').objectStore(STORE).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})}
function dbPut(s){return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(s);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}
function dbDelete(id){return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}
async function persistSettings(){localStorage.setItem('bookscan_settings',JSON.stringify({title:$('bookTitle').value,direction:$('direction').value,split:$('split').value,margin:$('margin').value,stability:$('stability').value,quality:$('quality').value,cropMode:$('cropMode').value,fixedQuad}))}
function loadSettings(){try{const s=JSON.parse(localStorage.getItem('bookscan_settings')||'{}');for(const [key,value] of Object.entries(s)){const id=key==='title'?'bookTitle':key;if(key==='fixedQuad'){if(value&&validQuad(value))fixedQuad=value}else if($(id))$(id).value=value}}catch{}if(localStorage.getItem('bookscan_auto_v4')!=='1'){$('cropMode').value='auto';localStorage.setItem('bookscan_auto_v4','1');persistSettings()}updateOutputs()}
function updateOutputs(){$('splitValue').textContent=$('split').value+'%';$('marginValue').textContent=$('margin').value+'%';$('stabilityValue').textContent=(Number($('stability').value)/1000).toFixed(1)+' 秒';drawGuide()}
function canvasBlob(canvas,quality){return new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(Error('无法编码照片')),'image/jpeg',quality))}
async function imageFromBlob(blob){const bitmap=await createImageBitmap(blob);return bitmap}
function buildPage(bitmap,rect,quality){const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(rect.w));canvas.height=Math.max(1,Math.round(rect.h));canvas.getContext('2d').drawImage(bitmap,rect.x,rect.y,rect.w,rect.h,0,0,canvas.width,canvas.height);return canvasBlob(canvas,quality)}
let fixedQuad=null,liveQuad=null,edgeMatches=0,editQuad=null,editBitmap=null,editTarget=null,drag=-1;
async function splitImage(blob,override=null,centerOverride=null){const bitmap=await imageFromBlob(blob);try{const mode=$('cropMode').value,found=override||(mode==='fixed'?fixedQuad:mode==='auto'?detectBook(bitmap,bitmap.width,bitmap.height):null);if(!found&&mode!=='off')throw Error('未可靠识别书本四边，请让完整书本与深色背景清晰可见');const m=Number($('margin').value)/100;const q=found||[[m,m],[1-m,m],[1-m,1-m],[m,1-m]];const cropped=rectify(bitmap,q);const w=cropped.width,h=cropped.height,center=centerOverride??Number($('split').value)/100,split=w*center,quality=Number($('quality').value);const left=await buildPage(cropped,{x:0,y:0,w:split,h},quality),right=await buildPage(cropped,{x:split,y:0,w:w-split,h},quality);cropped.width=cropped.height=1;return {left,right,quad:q,center,cropReview:false,cropVersion:4}}finally{bitmap.close()}}
function paintCrop(){if(!editBitmap)return;const c=$('cropCanvas'),ctx=c.getContext('2d');ctx.drawImage(editBitmap,0,0,c.width,c.height);const pts=editQuad.map(([x,y])=>[x*c.width,y*c.height]);ctx.fillStyle='rgba(0,0,0,.55)';ctx.beginPath();ctx.rect(0,0,c.width,c.height);ctx.moveTo(...pts[0]);pts.slice(1).forEach(p=>ctx.lineTo(...p));ctx.closePath();ctx.fill('evenodd');ctx.strokeStyle='#48ffac';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(...pts[0]);pts.slice(1).forEach(p=>ctx.lineTo(...p));ctx.closePath();ctx.stroke();const t=Number($('cropSplit').value)/100,lerp=(a,b)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];ctx.strokeStyle='#ffdb55';ctx.beginPath();ctx.moveTo(...lerp(pts[0],pts[1]));ctx.lineTo(...lerp(pts[3],pts[2]));ctx.stroke();for(const [x,y] of pts){ctx.beginPath();ctx.arc(x,y,Math.max(8,c.width*.016),0,Math.PI*2);ctx.fillStyle='#48ffac';ctx.fill();ctx.strokeStyle='#123';ctx.stroke()}}
async function openCrop(spread=null){if(busy||ocrRunning)return;if(!spread&&!video.videoWidth){toast('请先开启摄像头');return}auto=false;$('toggleAuto').textContent='开启自动拍摄';try{editTarget=spread;editBitmap=spread?await imageFromBlob(spread.original):await createImageBitmap(captureCanvas());editQuad=(spread?.quad||fixedQuad||detectBook(editBitmap,editBitmap.width,editBitmap.height)||fullQuad()).map(p=>[...p]);$('cropSplit').value=Math.round((spread?.center??Number($('split').value)/100)*100);const c=$('cropCanvas'),scale=Math.min(1,1000/Math.max(editBitmap.width,editBitmap.height));c.width=Math.round(editBitmap.width*scale);c.height=Math.round(editBitmap.height*scale);$('cropTitle').textContent=spread?'修正已拍跨页':'校准固定机位裁边';$('cropDialog').showModal();paintCrop()}catch(e){toast('无法打开裁边：'+e.message)}}
function closeCrop(){if(editBitmap)editBitmap.close();editBitmap=null;editTarget=null;drag=-1}
function initCrop(){const c=$('cropCanvas');const point=e=>{const r=c.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))]};c.onpointerdown=e=>{const p=point(e);drag=editQuad.reduce((best,q,i)=>Math.hypot(q[0]-p[0],q[1]-p[1])<Math.hypot(editQuad[best][0]-p[0],editQuad[best][1]-p[1])?i:best,0);c.setPointerCapture(e.pointerId)};c.onpointermove=e=>{if(drag<0)return;const q=editQuad.map(p=>[...p]);q[drag]=point(e);if(validQuad(q)){editQuad=q;paintCrop()}};c.onpointerup=c.onpointercancel=()=>drag=-1;$('cropSplit').oninput=paintCrop;$('cropReset').onclick=()=>{editQuad=fullQuad();paintCrop()};$('cropDetect').onclick=()=>{const q=detectBook(editBitmap,editBitmap.width,editBitmap.height);if(q){editQuad=q;paintCrop()}else toast('未可靠识别，请手动拖动四角')};$('cropCancel').onclick=()=>$('cropDialog').close();$('cropDialog').onclose=closeCrop;$('calibrate').onclick=()=>openCrop();$('cropMode').onchange=()=>{liveQuad=null;edgeMatches=0;persistSettings();drawGuide()};$('cropSave').onclick=async()=>{if(!validQuad(editQuad)||busy)return;busy=true;try{const q=editQuad.map(p=>[...p]),center=Number($('cropSplit').value)/100;if(editTarget){const pages=await splitImage(editTarget.original,q,center),updated={...editTarget,...pages,cropReview:false,pending:false};delete updated.ocrLeft;delete updated.ocrRight;await dbPut(updated);spreads=spreads.map(s=>s.id===updated.id?updated:s);await render();updateOcrUI();runSearch();toast('裁边已更新，该组需重新 OCR')}else{fixedQuad=q;$('cropMode').value='fixed';$('split').value=Math.round(center*100);updateOutputs();await persistSettings();toast('固定裁边已保存，后续拍摄自动使用')}$('cropDialog').close()}catch(e){toast('裁边失败：'+e.message)}finally{busy=false}}}
function sorted(){return [...spreads].sort((a,b)=>a.order-b.order)}
async function saveSpread(original,pages){const order=spreads.length?Math.max(...spreads.map(s=>s.order))+1:1;const entry={id:crypto.randomUUID(),order,original,...pages,created:Date.now()};await dbPut(entry);spreads.push(entry);lastAt=performance.now();await render();updateOcrUI();return entry}
async function addSpread(original,imported=false,expected=null){if(busy||ocrRunning)return false;busy=true;try{let pages;try{pages=await splitImage(original);if(expected&&quadDifference(pages.quad,expected)>.035)throw Error('拍摄瞬间书本边界发生变化')}catch(e){if(!imported){status('未确认四边 · 请勿翻页，正在重试',auto);toast(e.message);return false}await saveSpread(original,{cropReview:true,pending:true,cropVersion:4});toast('原图已保留，但未通过自动裁边；未列入PDF');return false}await saveSpread(original,pages);status('已保存第 '+spreads.length+' 组 · 可以翻页',auto);toast(`已保存跨页 #${spreads.length}（2页）`);return true}catch(e){toast('拍摄保存失败：'+e.message);status('保存失败 · 请勿翻页');auto=false;$('toggleAuto').textContent='开启自动拍摄';return false}finally{busy=false}}
function captureCanvas(){if(!video.videoWidth)throw Error('摄像头未就绪');const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d',{alpha:false}).drawImage(video,0,0,c.width,c.height);return c}
let taking=false,retryAt=0;
async function captureNow(){if(busy||taking||ocrRunning||!video.videoWidth)return;taking=true;try{const frame=readFrame(),expected=$('cropMode').value==='auto'&&auto?liveQuad:null;const canvas=captureCanvas();const blob=await canvasBlob(canvas,.94);canvas.width=canvas.height=1;const ok=await addSpread(blob,false,expected);if(ok){lastCaptured=frame;initialReady=true;motionSeen=false;stableAt=performance.now()}else{retryAt=performance.now()+1200;edgeMatches=0}}catch(e){toast(e.message);retryAt=performance.now()+1200}finally{taking=false}}
function readFrame(){if(video.readyState<2)return null;sampleCtx.drawImage(video,0,0,64,48);const rgba=sampleCtx.getImageData(0,0,64,48).data;const out=new Uint8Array(64*48);for(let i=0;i<out.length;i++)out[i]=(rgba[i*4]*3+rgba[i*4+1]*6+rgba[i*4+2])/10;return out}
function difference(a,b){if(!a||!b)return 255;let total=0;for(let i=0;i<a.length;i+=2)total+=Math.abs(a[i]-b[i]);return total/(a.length/2)}
function drawGuide(){const w=guide.clientWidth,h=guide.clientHeight;if(!w||!h)return;const ratio=window.devicePixelRatio||1;guide.width=Math.round(w*ratio);guide.height=Math.round(h*ratio);const c=guide.getContext('2d');c.scale(ratio,ratio);const split=Number($('split').value)/100;const m=Number($('margin').value)/100;const rect=video.getBoundingClientRect(),wrap=$('cameraFrame').getBoundingClientRect();let x=0,y=0,vw=w,vh=h;if(video.videoWidth&&video.videoHeight){const scale=Math.min(w/video.videoWidth,h/video.videoHeight);vw=video.videoWidth*scale;vh=video.videoHeight*scale;x=(w-vw)/2;y=(h-vh)/2}const mode=$('cropMode').value,q=mode==='auto'?liveQuad:mode==='fixed'?fixedQuad:[[m,m],[1-m,m],[1-m,1-m],[m,1-m]];if(!q)return;const p=q.map(([a,b])=>[x+vw*a,y+vh*b]);c.strokeStyle=mode==='auto'&&edgeMatches<2?'#ffbd4a':'#4ef6b0';c.lineWidth=2;c.setLineDash([8,5]);c.beginPath();c.moveTo(...p[0]);p.slice(1).forEach(k=>c.lineTo(...k));c.closePath();c.stroke();c.strokeStyle='#ffd761';c.beginPath();const lerp=(a,b)=>[a[0]+(b[0]-a[0])*split,a[1]+(b[1]-a[1])*split];c.moveTo(...lerp(p[0],p[1]));c.lineTo(...lerp(p[3],p[2]));c.stroke();}
let lastDetect=0;
function tick(time){animation=requestAnimationFrame(tick);if(!stream||busy||taking||ocrRunning)return;
 if(time-lastDetect>420&&video.videoWidth&&$('cropMode').value==='auto'){
   lastDetect=time;const q=detectBook(video,video.videoWidth,video.videoHeight);
   edgeMatches=q?(quadDifference(q,liveQuad)<.020?edgeMatches+1:1):0;liveQuad=q;drawGuide();
   $('cropStatus').textContent=!q?'未确认四条边：请保持书本完整入镜、使用深色背景':edgeMatches<2?'黄色：正在确认边界':'绿色：边界已连续确认';
 }
 if(!auto||time-frameClock<95)return;frameClock=time;const current=readFrame();if(!current)return;const delta=difference(current,lastFrame);lastFrame=current;
 if(delta>5){motionSeen=true;stableAt=0;edgeMatches=0;status('检测到翻页 · 等待稳定',true);return}
 if(delta>2.8){stableAt=0;edgeMatches=0;status('正在稳定画面',true);return}
 if(!stableAt)stableAt=time;
 if(time-stableAt<Number($('stability').value)){status('书页静止检测中',true);return}
 if(time-lastAt<1300||time<retryAt)return;
 const changed=difference(current,lastCaptured);
 if((!initialReady||motionSeen)&&(!lastCaptured||changed>2.5)){
   if($('cropMode').value==='auto'&&(!liveQuad||edgeMatches<2)){status('等待可靠四边 · 请勿翻页',true);return}
   status('边界已确认 · 正在拍照',true);captureNow();
 }else status('等待翻页',true);
}
async function startCamera(){if(!navigator.mediaDevices?.getUserMedia){toast('需要 HTTPS 或 localhost 才能使用摄像头');return}try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:15,max:30}}});video.srcObject=stream;await video.play();$('emptyCamera').style.display='none';$('cameraRes').textContent=`${video.videoWidth}×${video.videoHeight}`;$('startCamera').disabled=true;$('stopCamera').disabled=false;$('capture').disabled=false;$('toggleAuto').disabled=false;lastFrame=null;lastCaptured=null;motionSeen=false;initialReady=false;stableAt=0;lastAt=0;status('摄像头已开启');drawGuide();cancelAnimationFrame(animation);animation=requestAnimationFrame(tick)}catch(e){toast('摄像头打开失败：'+e.message)}}
function stopCamera(){auto=false;liveQuad=null;edgeMatches=0;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;cancelAnimationFrame(animation);$('emptyCamera').style.display='';$('startCamera').disabled=false;$('stopCamera').disabled=true;$('capture').disabled=true;$('toggleAuto').disabled=true;$('toggleAuto').textContent='开启自动拍摄';status('未启动')}
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
function filename(){return ($('bookTitle').value.trim()||'BookScan').replace(/[\\/:*?"<>|]/g,'_').slice(0,80)}
function pageSequence(){const seq=[];for(const spread of sorted()){if(spread.pending||!spread.left||!spread.right)continue;const pair=$('direction').value==='rtl'?[spread.right,spread.left]:[spread.left,spread.right];seq.push(...pair)}return seq}
let galleryUrls=[];
async function render(){for(const url of galleryUrls)URL.revokeObjectURL(url);galleryUrls=[];const ss=sorted();const ready=ss.filter(s=>!s.pending&&!s.cropReview).length;$('spreadCount').textContent=ready;$('pageCount').textContent=ready*2;$('pageCountHeader').textContent=ready*2+' 页'+(ready<ss.length?' · '+(ss.length-ready)+' 组待处理':'');$('exportPdf').disabled=!ss.length||ss.some(s=>s.pending||s.cropReview);$('resplit').disabled=!ss.length;$('downloadBackup').disabled=!ss.length;$('gallery').replaceChildren();if(!ss.length){$('gallery').innerHTML='<div class="empty-gallery">尚无扫描页。开启摄像头或导入一张打开书本的跨页照片。</div>';return}
  const urls=galleryUrls;for(let s=0;s<ss.length;s++){const spread=ss[s];const pages=$('direction').value==='rtl'?[spread.right,spread.left]:[spread.left,spread.right];for(let j=0;j<2;j++){const idx=s*2+j;const card=document.createElement('div');card.className='page-card';const img=document.createElement('img');const url=URL.createObjectURL(pages[j]||spread.original);urls.push(url);img.loading='lazy';img.src=url;img.alt=`第 ${idx+1} 页`;const meta=document.createElement('div');meta.className='page-meta';meta.textContent=`第 ${idx+1} 页 · 第 ${s+1} 组${spread.cropReview?" · 未通过裁边，暂不可导出":""}`;const actions=document.createElement('div');actions.className='page-actions';const del=document.createElement('button');del.className='delete';del.textContent='删除这一组';del.onclick=async()=>{if(busy||ocrRunning){toast('请先停止当前处理，再删除页面');return}if(!confirm(`删除第 ${s+1} 组的两页吗？`))return;await dbDelete(spread.id);spreads=spreads.filter(x=>x.id!==spread.id);await render();updateOcrUI()};actions.append(del);const crop=document.createElement('button');crop.textContent='修正裁边';crop.onclick=()=>openCrop(spread);actions.append(crop);const edit=document.createElement('button');edit.textContent='文字/校对';edit.onclick=()=>openOcrEditor(spread.id,$('direction').value==='rtl'?(j===0?'R':'L'):(j===0?'L':'R'));actions.append(edit);card.id='page-'+(idx+1);card.dataset.number=String(idx+1);card.append(img,meta,actions);$('gallery').append(card)}}
}
async function exportPdf(){if(busy||ocrRunning)return;if(spreads.some(s=>s.pending||s.cropReview)){toast('有跨页未通过自动裁边，请先重新裁边全部');return}busy=true;const b=$('exportPdf');b.disabled=true;try{const pages=pageSequence();status(`正在生成 PDF（${pages.length}页）`);const blob=await createPdf(pages,(done,total)=>{b.textContent=`PDF 处理中 ${done}/${total}`});download(blob,filename()+'.pdf');toast(`PDF 已生成，共 ${pages.length} 页；请在 Safari 下载项或“文件”中查看`)}catch(e){toast('导出失败：'+e.message)}finally{b.textContent='生成并保存 PDF';b.disabled=false;busy=false;status(auto?'自动拍摄中':'准备就绪',auto)}}
async function processFiles(files){if(taking||busy||ocrRunning){toast('请先完成当前处理');return}auto=false;$('toggleAuto').textContent='开启自动拍摄';for(const file of files){try{await addSpread(file,true)}catch(e){toast('导入失败：'+e.message)}}}
async function resplitAll(){if(busy||ocrRunning||!spreads.length)return;if(!confirm('重新自动检测全部原图？成功的页将更新并清除对应 OCR，失败的原图及旧结果仍保留。'))return;auto=false;$('toggleAuto').textContent='开启自动拍摄';$('cropMode').value='auto';await persistSettings();busy=true;let ok=0,failed=[];try{let i=0;for(const spread of sorted()){let pages;try{pages=await splitImage(spread.original)}catch(e){const updated={...spread,cropReview:true};await dbPut(updated);Object.assign(spread,updated);failed.push(i+1)}if(pages){const updated={...spread,...pages,pending:false,cropReview:false};delete updated.ocrLeft;delete updated.ocrRight;await dbPut(updated);delete spread.ocrLeft;delete spread.ocrRight;Object.assign(spread,updated);ok++}status(`重新裁边 ${++i}/${spreads.length}`);await new Promise(r=>setTimeout(r,0))}toast(`成功 ${ok} 组；失败 ${failed.length} 组${failed.length?'：'+failed.join('、'):''}`)}catch(e){toast('重新裁边中断：'+e.message)}finally{await render();updateOcrUI();runSearch();busy=false;status(failed.length?`未通过裁边 ${failed.length} 组，原图已保留`:'准备就绪')}}
// Original photos are exported individually through the browser share/download manager.
async function backupOriginals(){if(!spreads.length)return;if(!confirm('将逐张下载跨页原图。iPad Safari 可能要求允许多个下载项目。继续吗？'))return;let i=0;for(const spread of sorted()){download(spread.original,`${filename()}_跨页_${String(++i).padStart(4,'0')}.jpg`);await new Promise(r=>setTimeout(r,250))}toast(`已请求下载 ${i} 张原图；请检查浏览器是否拦截批量下载`)}
async function undo(){if(busy||ocrRunning){toast('请先停止文字识别');return}const last=sorted().at(-1);if(!last)return;await dbDelete(last.id);spreads=spreads.filter(s=>s.id!==last.id);await render();updateOcrUI();toast('已撤销最后一组')}

// Search index lives alongside image blobs in the existing IndexedDB spread records.
// The OCR result is text-only and never leaves the device; OCR files arrive from a public CDN.
function pageRecords(){
  const result=[];
  for(const spread of sorted()){
    const order=$('direction').value==='rtl'?[['R','ocrRight','right'],['L','ocrLeft','left']]:[['L','ocrLeft','left'],['R','ocrRight','right']];
    for(const [side,key,blobKey] of order)result.push({spread,side,key,blobKey,number:result.length+1,text:spread.pending||spread.cropReview?null:spread[key]??null,blocked:spread.pending||spread.cropReview});
  }
  return result;
}
function updateOcrUI(){
  const pages=pageRecords(),done=pages.filter(p=>p.text!==null).length;
  $('ocrCoverage').textContent=`已识别 ${done} / ${pages.length} 页`;
  $('startOcr').disabled=!pages.some(p=>!p.blocked&&p.text===null)||ocrRunning;
  $('stopOcr').disabled=!ocrRunning;
  $('startOcr').textContent=ocrRunning?'正在识别…':done===pages.length&&pages.length?'已全部识别':'识别未处理书页';
}
function loadTesseract(){
  if(window.Tesseract?.createWorker)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const existing=document.querySelector('script[data-tesseract]');
    if(existing){existing.addEventListener('load',resolve,{once:true});existing.addEventListener('error',()=>reject(Error('OCR 引擎加载失败')),{once:true});return}
    const script=document.createElement('script');script.dataset.tesseract='true';
    script.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload=resolve;script.onerror=()=>{script.remove();reject(Error('无法下载 OCR 引擎，请检查网络'))};document.head.append(script)
  });
}
async function startOCR(){
  if(busy||ocrRunning||!db||!spreads.length)return;
  const pages=pageRecords().filter(p=>!p.blocked&&p.text===null);if(!pages.length)return;
  if(stream){stopCamera();toast('OCR 占用较多资源，已关闭摄像头；识别完可重新开启')}
  ocrRunning=true;ocrStopRequested=false;updateOcrUI();let worker;
  try{
    $('ocrProgress').textContent='正在加载 OCR 引擎及语言包。首次运行需联网，可能下载较大文件…';
    await loadTesseract();
    const languages=$('ocrLanguage').value.split('+');
    worker=await window.Tesseract.createWorker(languages,1,{logger:m=>{if(m.status==='recognizing text')$('ocrProgress').textContent=`正在识别：${Math.round((m.progress||0)*100)}%（当前页）`}});
    let completed=0;
    for(const page of pages){
      if(ocrStopRequested)break;
      $('ocrProgress').textContent=`识别第 ${page.number} 页 · 本次 ${completed+1}/${pages.length}`;
      const url=URL.createObjectURL(page.spread[page.blobKey]);
      try{
        const result=await worker.recognize(url);
        const text=String(result.data?.text??'');
        page.spread[page.key]=text;
        await dbPut(page.spread);completed++;
      }finally{URL.revokeObjectURL(url)}
      updateOcrUI();runSearch();
      // Yield to touch events and Safari's UI between pages.
      await new Promise(resolve=>setTimeout(resolve,35));
    }
    $('ocrProgress').textContent=ocrStopRequested?`已暂停：本次完成 ${completed} 页，可再次继续`:`OCR 完成：本次识别 ${completed} 页。可使用全书查找。`;
  }catch(error){$('ocrProgress').textContent='OCR 失败：'+error.message;toast('OCR 失败：'+error.message)}
  finally{if(worker)try{await worker.terminate()}catch{}ocrRunning=false;ocrStopRequested=false;updateOcrUI()}
}
function normalizedText(s){return (s||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,'')}
function makeSnippet(raw,query){
  // Build a compact preview preserving meaningful text while allowing split-line matches.
  const squashed=String(raw||'').replace(/\s+/g,' ');
  const pos=squashed.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start=pos<0?0:Math.max(0,pos-42),end=Math.min(squashed.length,(pos<0?0:pos)+query.length+85);
  return (start?'…':'')+squashed.slice(start,end)+(end<squashed.length?'…':'');
}
function appendHighlighted(parent,text,query){
  const lower=text.toLocaleLowerCase(),needle=query.toLocaleLowerCase();let from=0,at=needle?lower.indexOf(needle): -1;
  if(at<0){parent.textContent=text;return}
  while(at>=0){parent.append(document.createTextNode(text.slice(from,at)));const mark=document.createElement('mark');mark.textContent=text.slice(at,at+query.length);parent.append(mark);from=at+query.length;at=lower.indexOf(needle,from)}
  parent.append(document.createTextNode(text.slice(from)));
}
function runSearch(){
  const q=$('searchInput').value.trim(),target=$('searchResults');target.replaceChildren();
  if(!q){const t=document.createElement('p');t.className='muted';t.textContent='输入关键词，即可查找所有已 OCR 的书页。';target.append(t);return}
  const needle=normalizedText(q);if(!needle)return;
  const records=pageRecords();let count=0;
  for(const page of records){
    if(page.text===null||!normalizedText(page.text).includes(needle))continue;
    count++;const item=document.createElement('button');item.className='search-result';item.type='button';
    const title=document.createElement('strong');title.textContent=`第 ${page.number} 页（点击跳转）`;
    const excerpt=document.createElement('span');excerpt.className='excerpt';appendHighlighted(excerpt,makeSnippet(page.text,q),q);
    item.append(title,excerpt);item.onclick=()=>jumpToPage(page.number);target.append(item);
  }
  const summary=document.createElement('p');summary.className='muted';const done=records.filter(p=>p.text!==null).length;
  summary.textContent=`找到 ${count} 个命中页面；已检索 ${done}/${records.length} 页。${done<records.length?'未识别的页面不包含在结果中。':''}`;
  target.prepend(summary);
}
function jumpToPage(number){
  const card=document.getElementById('page-'+number);if(!card)return;
  document.querySelectorAll('.page-card.current-hit').forEach(el=>el.classList.remove('current-hit'));
  card.classList.add('current-hit');card.scrollIntoView({behavior:'smooth',block:'center'});
}
function openOcrEditor(spreadId,side){
  const page=pageRecords().find(p=>p.spread.id===spreadId&&p.side===side);
  if(!page||page.blocked){toast('请先通过裁边检查');return}editorPage={spreadId,side};$('ocrEditorTitle').textContent=`第 ${page.number} 页识别文本（可校对）`;
  $('ocrText').value=page.text??'';$('ocrEditor').hidden=false;
  $('ocrEditor').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function saveOcrEditor(){
  if(!editorPage)return;const page=pageRecords().find(p=>p.spread.id===editorPage.spreadId&&p.side===editorPage.side);
  if(!page)return;page.spread[page.key]=$('ocrText').value;try{await dbPut(page.spread);updateOcrUI();runSearch();toast('文字校对已保存到本机')}catch(error){toast('保存失败：'+error.message)}
}

async function init(){initCrop();loadSettings();try{db=await openDB();spreads=await dbAll();await render();updateOcrUI()}catch(e){toast('本机存储不可用：'+e.message)}$('startCamera').onclick=startCamera;$('stopCamera').onclick=stopCamera;$('capture').onclick=captureNow;$('toggleAuto').onclick=()=>{auto=!auto;$('toggleAuto').textContent=auto?'暂停自动拍摄':'开启自动拍摄';lastFrame=null;lastCaptured=null;stableAt=0;motionSeen=false;initialReady=false;lastAt=0;edgeMatches=0;retryAt=0;status(auto?'自动拍摄已开启':'自动拍摄已暂停',auto)};$('undo').onclick=undo;$('fileInput').onchange=async e=>{await processFiles([...e.target.files]);e.target.value=''};$('exportPdf').onclick=exportPdf;$('resplit').onclick=resplitAll;$('downloadBackup').onclick=backupOriginals;$('clearAll').onclick=async()=>{if(busy||ocrRunning){toast('请先停止当前处理');return}if(!spreads.length)return;if(!confirm('永久删除当前所有扫描记录和原始照片？建议先导出 PDF 与备份。'))return;for(const s of spreads)await dbDelete(s.id);spreads=[];await render();updateOcrUI();$('searchResults').replaceChildren();toast('当前书籍已清空')};for(const id of ['split','margin','stability','quality','bookTitle','direction'])$(id).addEventListener('change',async()=>{updateOutputs();await persistSettings();if(id==='direction'){await render();updateOcrUI();runSearch()}});$('startOcr').onclick=startOCR;$('stopOcr').onclick=()=>{ocrStopRequested=true;$('ocrProgress').textContent='停止请求已收到；当前页完成后退出'};$('searchButton').onclick=runSearch;$('searchInput').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,180)});$('ocrLanguage').addEventListener('change',updateOcrUI);$('closeEditor').onclick=()=>{$('ocrEditor').hidden=true;editorPage=null};$('saveOcrText').onclick=saveOcrEditor;window.addEventListener('resize',drawGuide);document.addEventListener('visibilitychange',()=>{if(document.hidden&&auto){auto=false;$('toggleAuto').textContent='开启自动拍摄';status('已暂停：页面进入后台')}});if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{})}
init();
