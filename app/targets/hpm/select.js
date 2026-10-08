import { store } from '../../core/store.js';
import { HPM_BOARDS, DEFAULT_HPM_BOARD, hpmBoard } from './porting.js';
export function fillHpmSelect(select, selected = DEFAULT_HPM_BOARD, allowGeneric = false){
  if (!select) return;
  const options = HPM_BOARDS.map(board => new Option(board.name, board.id));
  if (allowGeneric) options.push(new Option('其它 RISC-V', 'riscv-other'));
  select.replaceChildren(...options);
  select.value = hpmBoard(selected) || (allowGeneric && selected === 'riscv-other') ? selected : DEFAULT_HPM_BOARD;
}

export function selectedHpmBoard(){
  for (const key of ['target.hpmBoard', 'rtt.rvChip', 'flash.chip']) {
    const id = store.get(key, ''); if (hpmBoard(id)) return id;
  }
  return DEFAULT_HPM_BOARD;
}
export function rememberHpmBoard(id){
  if (hpmBoard(id)) { store.set('target.hpmBoard', id); store.set('rtt.rvChip', id); }
}
