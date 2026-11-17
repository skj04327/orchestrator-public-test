// Never extract worker-controlled archives onto the host filesystem.
const block=512;
const text=(bytes,start,length)=>bytes.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
function octal(bytes,start,length){
  const value=text(bytes,start,length).trim();
  if(!/^[0-7]+$/.test(value))throw Error('Invalid tar number');
  const result=parseInt(value,8);
  if(!Number.isSafeInteger(result))throw Error('Invalid tar number');return result;
}
export function readDockerFile(bytes,name,limit){
  if(!Buffer.isBuffer(bytes)||!Number.isSafeInteger(limit)||limit<0||bytes.length>limit+4096||bytes.length<1536||bytes.length%block)
    throw Error('Invalid bounded Docker file');
  const h=bytes.subarray(0,block),stored=octal(h,148,8);
  const sum=h.reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0);
  if(sum!==stored||text(h,0,100)!==name||text(h,345,155)||![0,48].includes(h[156]))throw Error('Unsafe Docker archive entry');
  const size=octal(h,124,12),end=block+Math.ceil(size/block)*block;
  if(size>limit||end+1024>bytes.length||bytes.subarray(end).some(b=>b!==0))throw Error('Unsafe Docker file size or extra entry');
  return Buffer.from(bytes.subarray(block,block+size));
}
export function makeTarHeader(name,size){
  if(!/^[a-zA-Z0-9_.-]{1,90}$/.test(name)||!Number.isSafeInteger(size)||size<0||size>0o77777777777)throw Error('Unsafe input file');
  const h=Buffer.alloc(block);
  h.write(name);h.write('0000444\0',100);h.write('0000000\0',108);h.write('0000000\0',116);
  h.write(size.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);
  h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write('00',263);
  const checksum=h.reduce((s,b)=>s+b,0);h.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);
  return h;
}
export function makeTarFile(name,content){
  if(!Buffer.isBuffer(content))throw Error('Unsafe input file');
  return Buffer.concat([makeTarHeader(name,content.length),content,Buffer.alloc((block-content.length%block)%block+1024)]);
}
