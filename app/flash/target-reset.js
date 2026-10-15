import { sleep } from '../core/pace.js';

/** Send a genuine hardware pulse, even if the target SWD port is unresponsive.
 * SWJ_Pins.wait is a wait-until-pin-matches timeout, NOT a pulse duration. */
export async function pulseTargetReset(probe){
  const connected = await probe._ctrl(0x02, Uint8Array.of(1));
  if (connected[0] !== 1) throw new Error('探针未能启用 SWD 复位输出');
  // On release allow 50ms for the target RC network / another reset source.
  const pins = value => probe._ctrl(0x10, Uint8Array.of(value, 0x80, value ? 0x50 : 0, value ? 0xc3 : 0, 0, 0));
  let assertError;
  try {
    const response = await pins(0);
    if (response.length < 1 || (response[0] & 0x80)) throw new Error('探针未确认 nRESET 已拉低');
    await sleep(20);
  } catch (e){ assertError = e; }
  try {
    const response = await pins(0x80);
    if (response.length < 1 || !(response[0] & 0x80)) throw new Error('探针未确认 nRESET 已释放');
  } catch (e){
    if (assertError) throw new AggregateError([assertError, e], '复位输出失败，且无法确认已释放');
    throw e;
  }
  if (assertError) throw assertError;
  await sleep(150);
}
