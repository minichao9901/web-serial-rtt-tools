import {Cdp,sleep} from '../../../tools/selftest/cdp-lib.mjs';
import {writeFileSync} from 'node:fs';
const c=new Cdp();await c.connect();try{
 const data=await c.eval(`const h=__tools.hid;document.querySelector('.tab[data-tab="rttcdc"]').click();await h.stop('档位核查');if(!h.dev.connected)await h._ensure();const rows=[];for(const hz of [60000000,45000000,60000000]){document.getElementById('h-clock').value=String(hz);const response=await h.dev.configure({clockHz:hz});const before=await h.dev.status();await h.start();await new Promise(r=>setTimeout(r,600));const after=await h.dev.status();rows.push({requested:hz,params:h.params(),response,before,after});await h.stop('档位核查');}return rows;`);
 writeFileSync(new URL('./clock-diag.json',import.meta.url),JSON.stringify(data,null,2));console.log(JSON.stringify(data));
}finally{c.close();}
