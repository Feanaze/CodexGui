/* 轻量 Markdown 渲染 + 语法高亮（无外部依赖，离线可用） */
(function (global) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  /* ------------------------------ 语法高亮 ------------------------------ */

  const KW_CLIKE = /\b(?:if|else|elif|for|while|do|switch|case|default|break|continue|return|goto|try|catch|finally|throw|new|delete|sizeof|typedef|struct|union|enum|class|interface|namespace|template|typename|using|public|private|protected|virtual|override|static|const|constexpr|consteval|inline|extern|volatile|mutable|explicit|friend|operator|this|self|nullptr|null|None|True|False|void|bool|int|char|short|long|float|double|unsigned|signed|auto|size_t|string|var|let|const|function|async|await|yield|import|export|from|as|def|lambda|pass|with|in|is|not|and|or|package|func|defer|go|chan|map|range|select|type|impl|trait|match|mod|pub|use|where|unsafe|mut|ref|union)\b/y;
  const KW_SHELL = /\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|export|local|readonly|declare|source|alias|set|unset|shift|exit|trap|echo|printf|cd|pwd|ls|cat|grep|rg|sed|awk|find|xargs|curl|wget|git|npm|npx|pnpm|yarn|node|python|pip|cmake|make|ninja|gcc|g\+\+|clang|msbuild|dotnet|docker|kubectl|sudo|chmod|chown|mkdir|rm|cp|mv|touch|sleep|kill|export)\b/y;

  const RULES = {
    c: [
      ['com', /\/\/[^\n]*/y],
      ['com', /\/\*[\s\S]*?\*\//y],
      ['str', /(?:u8|u|U|L)?R"\([\s\S]*?\)"/y],
      ['str', /(?:u8|u|U|L)?"(?:\\.|[^"\\\n])*"/y],
      ['str', /(?:u8|u|U|L)?'(?:\\.|[^'\\\n])*'/y],
      ['pre', /^\s*#\s*\w+/my],
      ['key', KW_CLIKE],
      ['num', /\b(?:0[xX][0-9a-fA-F']+|0[bB][01']+|\d[\d']*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]*)\b/y],
      ['typ', /\b(?:std|string|vector|map|set|pair|shared_ptr|unique_ptr|size_t|int32_t|int64_t|uint32_t|uint64_t|FILE|HWND|HANDLE|[A-Z][A-Za-z0-9_]{2,})\b/y],
      ['fun', /\b[A-Za-z_]\w*(?=\s*\()/y],
      [null, /\b[A-Za-z_]\w*\b/y],
      [null, /[{}()[\];,.<>=+\-*/%&|!?:~^]+/y],
      [null, /\s+/y],
    ],
    py: [
      ['com', /#[^\n]*/y],
      ['str', /"""[\s\S]*?"""|'''[\s\S]*?'''/y],
      ['str', /(?:[rbfu]{0,2})"(?:\\.|[^"\\\n])*"|(?:[rbfu]{0,2})'(?:\\.|[^'\\\n])*'/y],
      ['pre', /^\s*@\w+/my],
      ['key', KW_CLIKE],
      ['num', /\b\d[\d_]*(?:\.\d+)?\b/y],
      ['typ', /\b(?:self|cls|[A-Z][A-Za-z0-9_]{2,})\b/y],
      ['fun', /\b[A-Za-z_]\w*(?=\s*\()/y],
      [null, /\b[A-Za-z_]\w*\b/y],
      [null, /[{}()[\];,.<>=+\-*/%&|!?:~^]+/y],
      [null, /\s+/y],
    ],
    sh: [
      ['com', /#[^\n]*/y],
      ['str', /"(?:\\.|[^"\\])*"|'[^']*'/y],
      ['pre', /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$\([^)]*\)/y],
      ['key', KW_SHELL],
      ['typ', /(?:^|\s)--?[A-Za-z][\w-]*/y],
      ['num', /\b\d+(?:\.\d+)?\b/y],
      ['fun', /\b[A-Za-z_][\w-]*(?=\s*\()/y],
      [null, /[|&;<>(){}[\]=!*?~]+/y],
      [null, /[^\s|&;<>(){}[\]=!*?~]+/y],
      [null, /\s+/y],
    ],
    json: [
      ['com', /\/\/[^\n]*/y],
      ['key', /"(?:\\.|[^"\\])*"(?=\s*:)/y],
      ['str', /"(?:\\.|[^"\\])*"/y],
      ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
      ['key', /\b(?:true|false|null)\b/y],
      [null, /[{}\[\],:]+/y],
      [null, /\s+/y],
    ],
    html: [
      ['com', /<!--[\s\S]*?-->/y],
      ['key', /<\/?[A-Za-z][\w:.-]*/y],
      ['str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y],
      ['typ', /[A-Za-z-]+(?==)/y],
      ['key', /\/?>/y],
      [null, /[^\s<>"'=]+/y],
      [null, /\s+/y],
    ],
    css: [
      ['com', /\/\*[\s\S]*?\*\//y],
      ['str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y],
      ['pre', /@[\w-]+/y],
      ['key', /[A-Za-z-]+(?=\s*:)/y],
      ['num', /-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?\b/y],
      ['typ', /#[0-9a-fA-F]{3,8}\b/y],
      [null, /[{}();:,]+/y],
      [null, /[^\s{}();:,]+/y],
      [null, /\s+/y],
    ],
    diff: [
      ['ok', /^\+(?!\+\+)[^\n]*/my],
      ['del', /^-(?!--)[^\n]*/my],
      ['pre', /^@@[^\n]*/my],
      ['com', /^(?:diff|index|---|\+\+\+)[^\n]*/my],
      [null, /[^\n]+/y],
      [null, /\n/y],
    ],
    md: [
      ['com', /^>[^\n]*/my],
      ['key', /^#{1,6}[^\n]*/my],
      ['str', /`[^`\n]*`/y],
      ['typ', /\*\*[^*\n]+\*\*/y],
      [null, /[^\n]+/y],
      [null, /\n/y],
    ],
  };

  const ALIAS = {
    js: 'c', javascript: 'c', mjs: 'c', cjs: 'c', ts: 'c', typescript: 'c', jsx: 'c', tsx: 'c',
    json: 'json', jsonc: 'json', json5: 'json',
    c: 'c', h: 'c', hpp: 'c', hh: 'c', cpp: 'c', 'c++': 'c', cc: 'c', cxx: 'c', 'c#': 'c', cs: 'c',
    java: 'c', kotlin: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', swift: 'c', m: 'c', mm: 'c',
    py: 'py', python: 'py', py3: 'py', rb: 'py', ruby: 'py',
    sh: 'sh', shell: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ps1: 'sh', powershell: 'sh',
    pwsh: 'sh', bat: 'sh', cmd: 'sh', console: 'sh', terminal: 'sh', cmake: 'sh', make: 'sh',
    makefile: 'sh', dockerfile: 'sh', yaml: 'sh', yml: 'sh', toml: 'sh', ini: 'sh', conf: 'sh',
    html: 'html', xml: 'html', svg: 'html', vue: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    diff: 'diff', patch: 'diff',
  };

  function highlight(code, lang) {
    const family = ALIAS[(lang || '').toLowerCase()] || 'md';
    const rules = RULES[family] || RULES.md;
    let i = 0;
    const out = [];
    while (i < code.length) {
      let matched = false;
      for (const [cls, re] of rules) {
        re.lastIndex = i;
        const m = re.exec(code);
        if (m && m[0].length > 0) {
          const text = escapeHtml(m[0]);
          if (cls === 'ok') out.push('<span class="tok-add">' + text + '</span>');
          else if (cls === 'del') out.push('<span class="tok-del">' + text + '</span>');
          else out.push(cls ? '<span class="tok-' + cls + '">' + text + '</span>' : text);
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        out.push(escapeHtml(code[i]));
        i += 1;
      }
    }
    return out.join('');
  }

  /* ------------------------------ 行内元素 ------------------------------ */

  function inline(text) {
    let s = escapeHtml(text);
    const codes = [];
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t, body) => {
      codes.push(body.replace(/^ | $/g, ''));
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (_m, alt, url) => '<img src="' + url + '" alt="' + alt + '" loading="lazy">');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (_m, label, url) => '<a href="' + url + '" target="_blank" rel="noreferrer">' + label + '</a>');
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>()]+[^\s<>()，。；、])/g,
      (_m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noreferrer">' + url + '</a>');
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000C(\d+)\u0000/g, (_m, idx) => '<code class="inline">' + codes[Number(idx)] + '</code>');
    return s;
  }

  /* ------------------------------ 块级元素 ------------------------------ */

  const RE_BLANK = /^\s*$/;
  const RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RE_HR = /^\s{0,3}(?:(?:[-*_])\s*){3,}$/;
  const RE_QUOTE = /^\s{0,3}>\s?/;
  const RE_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

  function codeBlock(code, lang) {
    const label = lang || 'text';
    return '<div class="code-block">' +
      '<div class="code-head"><span class="lang">' + escapeHtml(label) + '</span>' +
      '<span class="spacer"></span>' +
      '<button class="copy" data-copy-code="1">' + icon('i-copy') + '复制</button></div>' +
      '<div class="code-body"><pre>' + highlight(code, lang) + '</pre></div>' +
      '</div>';
  }

  function icon(id) {
    return '<svg><use href="#' + id + '"></use></svg>';
  }

  function isBlockStart(line) {
    return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) ||
      RE_QUOTE.test(line) || RE_ITEM.test(line);
  }

  function splitRow(row) {
    return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
      .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function renderList(lines, start, ordered) {
    const html = [];
    let i = start;
    let index = 0;
    const tag = ordered ? 'ol' : 'ul';
    html.push('<' + tag + '>');
    while (i < lines.length) {
      const m = lines[i].match(RE_ITEM);
      if (!m) break;
      index += 1;
      const text = m[3];
      i += 1;
      const extra = [];
      while (i < lines.length && !RE_BLANK.test(lines[i]) &&
             !lines[i].match(RE_ITEM) && /^\s+\S/.test(lines[i])) {
        extra.push(lines[i].replace(/^\s{1,4}/, ''));
        i += 1;
      }
      if (i < lines.length && lines[i].match(RE_ITEM) && !RE_BLANK.test(lines[i])) {
        const nested = [];
        while (i < lines.length && lines[i].match(RE_ITEM)) {
          nested.push(lines[i]);
          i += 1;
        }
        if (nested.length) extra.push(nested.join('\n'));
      }

      const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
      let content;
      if (task) {
        const checked = task[1].toLowerCase() === 'x';
        content = '<label class="task"><input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ' +
          inline(task[2]) + '</label>';
      } else {
        content = inline(text);
      }
      if (extra.length) content += render(extra.join('\n'));
      html.push('<li value="' + index + '">' + content + '</li>');
    }
    html.push('</' + tag + '>');
    return { html: html.join(''), next: i };
  }

  function render(src) {
    if (src == null) return '';
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (RE_BLANK.test(line)) { i += 1; continue; }

      const fence = line.match(RE_FENCE);
      if (fence) {
        const marker = fence[2][0];
        const len = fence[2].length;
        const lang = (fence[3] || '').toLowerCase();
        const closing = new RegExp('^\\s*' + (marker === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
        const buf = [];
        i += 1;
        while (i < lines.length && !closing.test(lines[i])) { buf.push(lines[i]); i += 1; }
        if (i < lines.length) i += 1;
        out.push(codeBlock(buf.join('\n'), lang));
        continue;
      }

      const h = line.match(RE_HEADING);
      if (h) {
        const level = h[1].length;
        out.push('<h' + level + '>' + inline(h[2]) + '</h' + level + '>');
        i += 1;
        continue;
      }

      if (RE_HR.test(line)) { out.push('<hr>'); i += 1; continue; }

      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && (RE_QUOTE.test(lines[i]) || (!RE_BLANK.test(lines[i]) && buf.length))) {
          buf.push(lines[i].replace(RE_QUOTE, ''));
          i += 1;
        }
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) &&
          lines[i + 1].includes('-')) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && !RE_BLANK.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        let html = '<table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') +
          '</tr></thead><tbody>';
        html += rows.map((r) =>
          '<tr>' + head.map((_c, idx) => '<td>' + inline(r[idx] || '') + '</td>').join('') + '</tr>').join('');
        html += '</tbody></table>';
        out.push(html);
        continue;
      }

      const item = line.match(RE_ITEM);
      if (item) {
        const ordered = /^\d/.test(item[2]);
        const res = renderList(lines, i, ordered);
        out.push(res.html);
        i = res.next;
        continue;
      }

      const buf = [];
      while (i < lines.length && !RE_BLANK.test(lines[i]) && !isBlockStart(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (!buf.length) { i += 1; continue; }
      out.push('<p>' + inline(buf.join('\n')) + '</p>');
    }
    return out.join('\n');
  }

  global.MD = { render, inline, highlight, escapeHtml };
})(window);
