// Dependency-free image-only PDF writer. Input JPEG bytes are inserted as DCT streams.
const enc = new TextEncoder();
function concat(parts){const length=parts.reduce((a,b)=>a+b.length,0);const out=new Uint8Array(length);let n=0;for(const p of parts){out.set(p,n);n+=p.length}return out}
function jpegDimensions(bytes){let i=2;while(i<bytes.length){if(bytes[i]!==0xFF){i++;continue}while(bytes[i]===0xFF)i++;const marker=bytes[i++];if(marker===0xD9||marker===0xDA)break;if(marker===0x01||(marker>=0xD0&&marker<=0xD7))continue;const size=(bytes[i]<<8)|bytes[i+1];if(size<2)throw Error('Invalid JPEG marker');if([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker)){const height=(bytes[i+3]<<8)|bytes[i+4],width=(bytes[i+5]<<8)|bytes[i+6],channels=bytes[i+7];return {width,height,channels}}i+=size}throw Error('无法解析 JPEG 尺寸')}
export async function createPdf(jpegBlobs,onProgress=()=>{}){
  if(!jpegBlobs.length)throw Error('没有可导出的页面');
  const objects=[null];const add=()=>{objects.push(null);return objects.length-1};
  const catalog=add(),pages=add(),pageRefs=[];
  for(let idx=0;idx<jpegBlobs.length;idx++){
    const bytes=new Uint8Array(await jpegBlobs[idx].arrayBuffer()),dim=jpegDimensions(bytes);
    if(dim.channels!==3&&dim.channels!==1)throw Error('当前 PDF 导出仅支持灰度或RGB JPEG');
    const img=add(),content=add(),page=add();pageRefs.push(page);
    const colorSpace=dim.channels===1?'/DeviceGray':'/DeviceRGB';
    objects[img]=concat([enc.encode(`<< /Type /XObject /Subtype /Image /Width ${dim.width} /Height ${dim.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`),bytes,enc.encode('\nendstream')]);
    // Fit each original page on a PDF sheet in points, preserving aspect ratio.
    const w=595,h=Math.max(1,595*dim.height/dim.width);
    const contentBytes=enc.encode(`q\n${w.toFixed(3)} 0 0 ${h.toFixed(3)} 0 0 cm\n/Im0 Do\nQ\n`);
    objects[content]=concat([enc.encode(`<< /Length ${contentBytes.length} >>\nstream\n`),contentBytes,enc.encode('endstream')]);
    objects[page]=enc.encode(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${w.toFixed(3)} ${h.toFixed(3)}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    onProgress(idx+1,jpegBlobs.length);if(idx%8===7)await new Promise(r=>setTimeout(r,0));
  }
  objects[pages]=enc.encode(`<< /Type /Pages /Kids [${pageRefs.map(n=>`${n} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  objects[catalog]=enc.encode(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  const parts=[enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')],offsets=[0];let offset=parts[0].length;
  for(let i=1;i<objects.length;i++){offsets[i]=offset;const obj=concat([enc.encode(`${i} 0 obj\n`),objects[i],enc.encode('\nendobj\n')]);parts.push(obj);offset+=obj.length}
  const xref=offset;
  parts.push(enc.encode(`xref\n0 ${objects.length}\n0000000000 65535 f \n`));
  for(let i=1;i<objects.length;i++)parts.push(enc.encode(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`));
  parts.push(enc.encode(`trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Blob(parts,{type:'application/pdf'});
}
