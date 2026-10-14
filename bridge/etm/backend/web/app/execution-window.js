export function rangeFromPixels(first,last,width,start,end){
  const point=x=>Math.min(end,Math.max(start,Math.floor(start+Math.max(0,Math.min(width,x))/Math.max(1,width)*(end-start+1))));
  const a=point(first),b=point(last);return {start:Math.min(a,b),end:Math.max(a,b)};
}
export function wheelRange(range,total,fraction,zoomIn){
  const width=range.end-range.start+1,newWidth=Math.max(Math.min(2,total.end-total.start+1),Math.min(total.end-total.start+1,Math.round(width*(zoomIn ? 0.5 : 2))));
  let start=Math.round(range.start+width*fraction-newWidth*fraction);start=Math.max(total.start,Math.min(total.end-newWidth+1,start));return {start,end:start+newWidth-1};
}
