const fs = require('fs');
const file = 'f:/Projects/RouteGuard/routeguard-pay-agent/public/index.html';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  '.gov-meta, .policy-facts { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px; margin-top: 14px; }\\n      .gov-meta > div, .policy-facts > div { padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }\\n      .gov-meta b, .policy-facts b { display: block; margin-top: 4px; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }',
  '.gov-meta, .policy-facts { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; margin-top: 14px; }\\n      .gov-meta > div, .policy-facts > div { padding: 8px 12px; border: none; border-radius: 6px; background: rgba(255,255,255,.02); }\\n      .gov-meta span, .policy-facts span { color: var(--ink-faint); font: 650 8.5px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; }\\n      .gov-meta b, .policy-facts b { display: block; margin-top: 4px; font-family: var(--mono); font-size: 12px; color: var(--ink); overflow-wrap: anywhere; }'
);

content = content.replace(
  '.gov-form select, .gov-form input, .gov-form textarea, .queue-actions select { width: 100%; border: 1px solid var(--line-strong); border-radius: 7px; background: #0b121d; color: var(--text); padding: 10px; font: inherit; }',
  '.gov-form select, .gov-form input, .gov-form textarea, .queue-actions select { width: 100%; border: 1px solid transparent; border-radius: 6px; background: rgba(255,255,255,.04); color: var(--text); padding: 10px; font: inherit; outline: none; transition: all .15s ease; }\\n      .gov-form select:focus, .gov-form input:focus, .gov-form textarea:focus, .queue-actions select:focus { border-color: transparent; outline: 2px solid var(--blue); background: rgba(255,255,255,.06); }'
);

content = content.replace(
  '.summary-item { min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px; background: rgba(8,12,18,.35); }\\n      .summary-item .k { color: var(--ink-faint); font: 8px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase; }\\n      .summary-item .v { margin-top: 4px; overflow-wrap: anywhere; color: var(--ink); font-size: 11px; }\\n      .summary-item.mono .v { font-family: var(--mono); }',
  '.summary-item { min-width: 0; padding: 10px 14px; border: none; border-radius: 6px; background: rgba(255,255,255,.02); }\\n      .summary-item .k { color: var(--ink-faint); font: 650 8.5px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; }\\n      .summary-item .v { margin-top: 5px; overflow-wrap: anywhere; color: var(--ink); font-size: 12px; font-weight: 500; }\\n      .summary-item.mono .v { font-family: var(--mono); color: #fff; }'
);

content = content.replace(
  '.approval-field { min-width: 0; padding: 8px 9px; border: 1px solid rgba(255,255,255,.07); border-radius: 8px; background: rgba(8,12,18,.34); }\\n      .approval-field.wide { grid-column: span 2; }\\n      .approval-field .k { color: var(--ink-faint); font: 650 8px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase; }\\n      .approval-field .v { margin-top: 3px; color: var(--ink); font: 10px/1.4 var(--mono); word-break: break-all; }',
  '.approval-field { min-width: 0; padding: 10px 14px; border: none; border-radius: 6px; background: rgba(255,255,255,.02); }\\n      .approval-field.wide { grid-column: span 2; }\\n      .approval-field .k { color: var(--ink-faint); font: 650 8.5px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; }\\n      .approval-field .v { margin-top: 5px; color: #fff; font: 500 11px/1.4 var(--mono); word-break: break-all; }'
);

content = content.replace(
  '.live-primary { border-color: rgba(109,180,255,.7); background: linear-gradient(120deg, #3979df, #7058d9); color: #fff; cursor: pointer; font-weight: 750; box-shadow: 0 6px 18px rgba(57,121,223,.22); transition: transform .14s ease, box-shadow .14s ease, filter .14s ease; }\\n      .live-primary:hover:not(:disabled) { filter: brightness(1.12); box-shadow: 0 8px 24px rgba(112,88,217,.34); transform: translateY(-1px); }\\n      .live-primary:focus-visible { outline: 3px solid rgba(109,180,255,.42); outline-offset: 3px; }\\n      .live-primary:active:not(:disabled) { transform: translateY(1px); box-shadow: 0 3px 10px rgba(57,121,223,.2); }\\n      .live-primary.is-loading { cursor: progress; filter: saturate(.7); }\\n      .live-primary:disabled { border-color: var(--line); background: rgba(255,255,255,.07); color: var(--ink-faint); cursor: not-allowed; box-shadow: none; opacity: .7; transform: none; }\\n      .live-primary.is-loading:disabled { border-color: rgba(109,180,255,.45); background: linear-gradient(120deg, #315f9e, #594c9c); color: #fff; cursor: progress; opacity: .85; }',
  '.live-primary { border: 1px solid rgba(109,180,255,.2); background: #16263a; color: #9bcbff; cursor: pointer; font-weight: 650; box-shadow: 0 4px 12px rgba(0,0,0,.15); transition: all .16s ease; }\\n      .live-primary:hover:not(:disabled) { background: #1d334d; border-color: rgba(109,180,255,.4); color: #fff; box-shadow: 0 6px 16px rgba(109,180,255,.12); transform: translateY(-1px); }\\n      .live-primary:focus-visible { outline: 2px solid rgba(109,180,255,.42); outline-offset: 3px; }\\n      .live-primary:active:not(:disabled) { transform: translateY(1px); box-shadow: 0 2px 6px rgba(0,0,0,.2); }\\n      .live-primary.is-loading { cursor: progress; filter: saturate(.7); }\\n      .live-primary:disabled { border-color: var(--line); background: rgba(255,255,255,.03); color: var(--ink-faint); cursor: not-allowed; box-shadow: none; opacity: .7; transform: none; }\\n      .live-primary.is-loading:disabled { border-color: rgba(109,180,255,.2); background: #1a2a40; color: #6db4ff; cursor: progress; opacity: .85; }'
);

content = content.replace(
  '.technical-evidence.compact { display: inline-block; width: 100%; }\\n      .technical-evidence summary {\\n        cursor: pointer;\\n        display: inline-block;\\n        padding: 0;\\n        color: var(--ink-faint);\\n        font: 500 9.5px/1.4 var(--mono);\\n        letter-spacing: .02em;\\n        list-style: none;\\n      }',
  '.technical-evidence.compact { display: block; width: 100%; margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.05); }\\n      .technical-evidence.compact summary {\\n        cursor: pointer;\\n        display: inline-block;\\n        padding: 0 0 4px 0;\\n        color: var(--ink-faint);\\n        font: 500 9px/1.4 var(--mono);\\n        letter-spacing: .03em;\\n        text-transform: uppercase;\\n        list-style: none;\\n      }\\n      .technical-evidence summary {\\n        cursor: pointer;\\n        display: inline-block;\\n        padding: 0;\\n        color: var(--ink-faint);\\n        font: 500 9.5px/1.4 var(--mono);\\n        letter-spacing: .02em;\\n        list-style: none;\\n      }'
);

content = content.replace(
  '.archive-btn { color: var(--ink-dim); }',
  '.archive-btn { color: var(--ink-faint); font-weight: 500; border-color: transparent; background: transparent; transition: all .15s ease; }\\n      .archive-btn:hover { color: var(--ink); background: rgba(255,255,255,.05); border-color: transparent; }'
);

content = content.replace(
  '</h4><p class=\"muted\"></p><details><summary>View checkpoint evidence</summary><div class=\"weather-metrics\"></div>',
  '</h4><details><summary>View checkpoint evidence</summary><p class=\"muted\" style=\"margin-bottom:8px;\"></p><div class=\"weather-metrics\"></div>'
);

fs.writeFileSync(file, content);
console.log('Done');
