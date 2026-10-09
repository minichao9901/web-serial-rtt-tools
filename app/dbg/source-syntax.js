/** C/C++ 源码着色：只生成文本片段，渲染时使用 textContent，源码不会作为 HTML 执行。 */
const KEYWORDS = new Set(('alignas alignof asm auto break case catch class const constexpr consteval constinit continue default delete do else enum explicit export extern false for friend goto if inline mutable namespace new noexcept nullptr operator private protected public register requires return sizeof static static_assert struct switch template this thread_local throw true try typedef typename union using virtual volatile while _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local __attribute__ __asm__ __inline__ __volatile__').split(' '));
const TYPES = new Set(('bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t _Bool _Complex size_t ptrdiff_t intptr_t uintptr_t').split(' '));
const WORD = /[A-Za-z_]\w*/y;
const NUMBER = /(?:0[xX][\da-fA-F](?:[\da-fA-F']|\.(?=[\da-fA-F]))*(?:[pP][+-]?\d[\d']*)?|0[bB][01][01']*|(?:\d[\d']*(?:\.[\d']*)?|\.\d[\d']*)(?:[eE][+-]?\d[\d']*)?)[uUlLfF]*/y;
const RAW = /(?:u8|u|U|L)?R"([^ ()\\\t]{0,16})\(/y;
const QUOTE = /(?:u8|u|U|L)?["']/y;
const DIRECTIVE = /#[ \t]*[A-Za-z_]\w*/y;

const at = (re, text, pos) => { re.lastIndex = pos; return re.exec(text)?.[0]; };

/** 扫描整份文件以保留跨行状态；显示窗口从注释/原始字符串中间开始时也能正确着色。 */
export function sourceTokens(lines, file){
  if (!/\.(?:c|h|cc|hh|cpp|hpp|cxx|hxx|ino)$/i.test(file)) return null;
  let block = false, quote = '', rawEnd = '', lineComment = false;
  return lines.map(text => {
    const tokens = [];
    const put = (kind, value) => {
      if (!value) return;
      const last = tokens[tokens.length - 1];
      if (last?.kind === kind) last.text += value;
      else tokens.push({ kind, text: value });
    };
    let i = 0;
    while (i < text.length){
      if (lineComment){ put('comment', text.slice(i)); i = text.length; break; }
      if (block || rawEnd){
        const end = block ? '*/' : rawEnd;
        const found = text.indexOf(end, i), stop = found < 0 ? text.length : found + end.length;
        put(block ? 'comment' : 'string', text.slice(i, stop)); i = stop;
        if (found >= 0){ block = false; rawEnd = ''; }
        continue;
      }
      if (quote){
        const start = i;
        let continued = false;
        while (i < text.length){
          const ch = text[i++];
          if (ch === '\\'){
            if (i === text.length){ continued = true; break; }
            i++;
          } else if (ch === quote){ quote = ''; break; }
        }
        put('string', text.slice(start, i));
        if (!continued) quote = '';
        continue;
      }
      if (text.startsWith('//', i)){ lineComment = true; continue; }
      if (text.startsWith('/*', i)){ put('comment', '/*'); i += 2; block = true; continue; }
      const raw = at(RAW, text, i);
      if (raw){
        RAW.lastIndex = i; const delimiter = RAW.exec(text)[1];
        put('string', raw); i += raw.length; rawEnd = ')' + delimiter + '"'; continue;
      }
      const opening = at(QUOTE, text, i);
      if (opening){ put('string', opening); i += opening.length; quote = opening.at(-1); continue; }
      const directive = text[i] === '#' && /^\s*$/.test(text.slice(0, i)) ? at(DIRECTIVE, text, i) : null;
      if (directive){ put('directive', directive); i += directive.length; continue; }
      const number = at(NUMBER, text, i);
      if (number){ put('number', number); i += number.length; continue; }
      const word = at(WORD, text, i);
      if (word){
        const kind = TYPES.has(word) || /^(?:u?int(?:8|16|32|64)_t|int_fast\d+_t|uint_fast\d+_t)$/.test(word) ? 'type'
          : KEYWORDS.has(word) ? 'keyword' : /^\s*\(/.test(text.slice(i + word.length)) ? 'function' : '';
        put(kind, word); i += word.length; continue;
      }
      put('', text[i++]);
    }
    lineComment = lineComment && text.endsWith('\\');
    // 空物理行也会结束上一行的反斜杠续行字符串。
    if (!text.length) quote = '';
    return tokens;
  });
}
