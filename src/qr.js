import qrcode from './vendor/qrcode.mjs';
export function createReceiveQr(payload){
 if(typeof payload!=='string'||payload.length>2200||/[^\x20-\x7e]/.test(payload))throw new Error('Receive QR payload is too large or invalid.');
 const qr=qrcode(0,'M');qr.addData(payload,'Byte');qr.make();
 const count=qr.getModuleCount();const matrix=Array.from({length:count},(_,row)=>Array.from({length:count},(_,col)=>qr.isDark(row,col)));
 return {payload,matrix,svg:qr.createSvgTag({cellSize:8,margin:32,scalable:true})};
}
export function renderReceiveQr(matrix,{color=false,ascii=false}={}){
 if(ascii){
  const size=matrix.length,margin=2,lines=[];
  for(let row=-margin;row<size+margin;row++){let line='';for(let col=-margin;col<size+margin;col++)line+=(row>=0&&col>=0&&row<size&&col<size&&matrix[row][col])?'##':'  ';lines.push(color?`\x1b[30;47m${line}\x1b[0m`:line);}
  return {text:lines.join('\n'),width:(size+margin*2)*2};
 }
 const size=matrix.length,margin=4,width=size+margin*2;const dark=(row,col)=>row>=0&&col>=0&&row<size&&col<size&&matrix[row][col];const lines=[];
 for(let row=-margin;row<size+margin;row+=2){let line='';for(let col=-margin;col<size+margin;col++){const top=dark(row,col),bottom=dark(row+1,col);line+=top?(bottom?'█':'▀'):(bottom?'▄':' ');}lines.push(color?`\x1b[30;47m${line}\x1b[0m`:line);}
 return {text:lines.join('\n'),width};
}

/** Terminal size of a QR in cells. Unicode packs two module rows per cell row; ASCII uses two columns per module. */
export function qrDims(size,{ascii=false,quiet=4}={}){
 const modules=size+quiet*2;
 return ascii?{width:modules*2,height:modules}:{width:modules,height:Math.ceil(modules/2)};
}
/** Paints a QR into a tui Screen at (x,y). Dark-on-light in colour; in NO_COLOR the style inverts so it still scans on a dark terminal. */
export function drawQr(screen,x,y,matrix,{ascii=false,quiet=4}={}){
 const size=matrix.length;const dark=(r,c)=>r>=0&&c>=0&&r<size&&c<size&&matrix[r][c];
 const style={fg:[0,0,0],bg:[255,255,255],invertIfNoColor:true};
 if(ascii){
  for(let r=-quiet,j=0;r<size+quiet;r++,j++)for(let c=-quiet,i=0;c<size+quiet;c++,i++)screen.put(x+i*2,y+j,dark(r,c)?'##':'  ',style);
  return qrDims(size,{ascii,quiet});
 }
 for(let r=-quiet,j=0;r<size+quiet;r+=2,j++)for(let c=-quiet,i=0;c<size+quiet;c++,i++){
  const top=dark(r,c),bottom=dark(r+1,c);
  screen.put(x+i,y+j,top?(bottom?'█':'▀'):(bottom?'▄':' '),style);
 }
 return qrDims(size,{ascii,quiet});
}
