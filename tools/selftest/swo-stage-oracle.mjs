export function stageOracle(model){
 const phases={pipeline_scan:[1],crc_step:[1],next_random:[1,2],pipeline_sort:[2],insertion_sort:[2],route_a:[3],branch_leaf_a:[3],route_b:[4],branch_leaf_b:[4],pipeline_pack:[5],encode_word:[5],pipeline_recursive:[6],recursive_mix:[6],pipeline_verify:[7],verify_block:[7],idle_phase:[8]};
 let current=null,previous=null,marker=null,checked=0;const mismatches=[],ambiguous=[],counts={};
 for(const e of model.events){
  if(e.kind==='gap'){current=null;previous=null;marker=null;continue;}
  if(e.kind==='itm'&&e.port===1&&(e.value>>>24)===0xa5){previous=current;current=e.value&255;marker=e;continue;}
  if(current===null||e.kind!=='pc'||!phases[e.fn])continue;
  const match=phases[e.fn].includes(current);
  // ITM/DWT arbitration can reorder events in the same delayed timestamp group.
  // Only exclude provably unordered boundary samples, never arbitrary wrong phases.
  if(!match&&previous!==null&&phases[e.fn].includes(previous)&&e.cycles!==null&&e.cycles===marker.cycles&&e.segment===marker.segment&&(e.timeQuality==='delayed'||marker.timeQuality==='delayed')){ambiguous.push({sample:e.sample,fn:e.fn,previous,stage:current,cycles:e.cycles});continue;}
  checked++;counts[current]=(counts[current]||0)+1;if(!match)mismatches.push({sample:e.sample,fn:e.fn,expected:phases[e.fn],stage:current});
 }
 return {checked,matched:checked-mismatches.length,accuracy:checked?(checked-mismatches.length)/checked:null,counts,mismatches:mismatches.slice(0,20),mismatchCount:mismatches.length,ambiguousCount:ambiguous.length,ambiguous:ambiguous.slice(0,20)};
}
