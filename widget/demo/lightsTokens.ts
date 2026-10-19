// The host stand-in for /widget-demo/ (src/app/widget-demo): Truckee Lights' token names and values, kept outside src/ because
// TruckeeVibes' own UI must not use these names (AC-R1b-13). Rendered as the text of one <style> element.
// Truckee Lights' season tokens (Lights globals.css :root[data-theme] + events.css), so the demo looks like the host site.
export const TOKENS = `
:root[data-theme="halloween"]{--bg:#140A1F;--surface:#24143A;--surface-2:#2F1B4A;--line:#4a2f6e;--text:#F3ECDA;--muted:#B8A9CF;--accent:#8AE234;--on-accent:#140A1F;
  --accent-2:#FF7A1A;--on-accent-2:#140A1F;--focus:#8AE234;--radius:14px;--ev:#FF7A1A;--on-ev:#140A1F;--drive:#8FD3FF;--font-display:cursive}
:root[data-theme="christmas"]{--bg:#0B1626;--surface:#13233A;--surface-2:#1B2F4B;--line:#2c4466;--text:#F7F5EF;--muted:#AFC0D6;--accent:#F2C14E;--on-accent:#0B1626;
  --accent-2:#C62828;--on-accent-2:#FFFFFF;--focus:#F2C14E;--radius:16px;--ev:#E0393E;--on-ev:#FFFFFF;--drive:#7FD6A0;--font-display:serif}
:root[data-theme]{--body:var(--font-atkinson), system-ui, -apple-system, "Segoe UI", sans-serif; color-scheme:dark}
:root[data-theme] body{background:var(--bg); color:var(--text); font-family:var(--body); font-size:16px; line-height:1.5}
.tl-demo{max-width:720px; margin:0 auto; padding:30px 16px 92px; display:flex; flex-direction:column; gap:22px}
.tl-demo h1{margin:0; font-size:20px}
.tl-demo p{margin:0; color:var(--muted); font-size:14px}
.tl-demo ol{margin:0; padding-left:20px; color:var(--muted); font-size:13px; font-family:ui-monospace, monospace; overflow-wrap:anywhere}
`;
