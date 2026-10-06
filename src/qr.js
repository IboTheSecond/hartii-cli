import qrcode from './vendor/qrcode.mjs';
export function createReceiveQr(payload){
 if(typeof payload!=='string'||payload.length>2200||/[^\x20-\x7e]/.test(payload))throw new Error('Receive QR payload is too large or invalid.');
 const qr=qrcode(0,'M');qr.addData(payload,'Byte');qr.make();
 const count=qr.getModuleCount();const matrix=Array.from({length:count},(_,row)=>Array.from({length:count},(_,col)=>qr.isDark(row,col)));
 return {payload,matrix,svg:qr.createSvgTag({cellSize:8,margin:32,scalable:true})};
}
export function renderReceiveQr(matrix,{color=false}={}){
 const size=matrix.length,margin=4,width=size+margin*2;const dark=(row,col)=>row>=0&&col>=0&&row<size&&col<size&&matrix[row][col];const lines=[];
 for(let row=-margin;row<size+margin;row+=2){let line='';for(let col=-margin;col<size+margin;col++){const top=dark(row,col),bottom=dark(row+1,col);line+=top?(bottom?'█':'▀'):(bottom?'▄':' ');}lines.push(color?`\x1b[30;47m${line}\x1b[0m`:line);}
 return {text:lines.join('\n'),width};
}
