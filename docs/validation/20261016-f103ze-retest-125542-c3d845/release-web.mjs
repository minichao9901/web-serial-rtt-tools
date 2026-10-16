import {Cdp} from '../../../tools/selftest/cdp-lib.mjs';
const c=new Cdp();await c.connect();try{await c.eval(`if(window.__tools?.probeManager)await __tools.probeManager.releaseOthers(null,'实板验收交接');return true;`);}finally{c.close();}
