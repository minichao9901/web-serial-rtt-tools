/** Report secondary cleanup failures without replacing the first failed operation. */
export async function withCleanup(operation,cleanup,report=()=>{}){
  let primary=null;
  try{return await operation();}catch(e){primary=e;throw e;}
  finally{try{await cleanup();}catch(e){report(e);if(primary){(primary.cleanupErrors??=[]).push(e.message);}else throw e;}}
}
