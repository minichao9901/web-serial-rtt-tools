export function sampleRangeFromPixels(first,last,width,start,end){
  const point=x=>Math.min(end,Math.max(start,Math.floor(start+Math.max(0,Math.min(width,x))/Math.max(1,width)*(end-start+1))));
  const a=point(first),b=point(last);return {start:Math.min(a,b),end:Math.max(a,b)};
}

export function zoomRangeAroundCursor(range,total,cursor,zoomIn){
  const totalWidth=total.end-total.start+1,width=range.end-range.start+1;
  if(totalWidth<=1)return {...total};
  const nextWidth=zoomIn?Math.max(2,Math.ceil(width/2)):Math.min(totalWidth,width*2);
  if(nextWidth===width)return {...range};
  const anchor=Number.isInteger(cursor)&&cursor>=range.start&&cursor<=range.end?cursor:Math.round((range.start+range.end)/2);
  const start=Math.max(total.start,Math.min(total.end-nextWidth+1,anchor-Math.floor((nextWidth-1)/2)));
  return {start,end:start+nextWidth-1};
}
