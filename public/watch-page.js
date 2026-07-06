// watch-page.js — public share page renderer (kept external so the served HTML
// stays template-literal-safe; loaded by /watch/:token).
(async () => {
  const token = document.currentScript?.dataset.token ||
    document.querySelector('script[data-token]').dataset.token;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r = await fetch('/api/share/' + token + '/data');
  if (!r.ok) return;
  const d = await r.json();

  document.getElementById('ti').textContent = d.title;
  document.getElementById('me').textContent =
    d.owner + ' · ' + d.channel + ' · ' +
    new Date(d.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  document.getElementById('cs').textContent = d.chart_score || 0;
  if (d.judge_count) {
    document.getElementById('jf').style.width = (d.avg_score * 10) + '%';
    document.getElementById('jl').textContent = 'JUDGES ' + d.avg_score.toFixed(1) + ' / 10';
  }
  const RX = { star: '⭐', fire: '🔥', clap: '👏', heart: '💜', wow: '🤩' };
  const counts = Object.fromEntries((d.reactions || []).map(x => [x.kind, x.n]));
  document.getElementById('rx').innerHTML = Object.entries(RX)
    .map(([k, e]) => `<span class="chip">${e} ${counts[k] || 0}</span>`).join('');

  const pill = c => {
    if (c.cast_name) {
      if (c.cast_tier === 'judge') return '<span class="pill pj">🤖 AI JUDGE</span>';
      if (c.cast_tier === 'regular') return '<span class="pill pc">🤖 AI CREW</span>';
      return '<span class="pill pf">🤖 AI FAN</span>';
    }
    return '';
  };
  document.getElementById('cm').innerHTML = (d.comments || []).map(c => {
    const judge = c.cast_tier === 'judge';
    const av = c.cast_name ? c.cast_emoji : (c.user_emoji || '⭐');
    const who = c.cast_name
      ? esc(c.cast_name) + (judge ? ' · ' + esc(c.specialty || 'judge') : '')
      : esc(c.user_name);
    return `<div class="cm ${judge ? 'judge' : ''}" ${c.parent_id ? 'style="margin-left:16px"' : ''}>
      <div class="av">${esc(av)}</div>
      <div><span class="who">${who}</span>${pill(c)}
      <div class="body">${esc(c.body)}</div></div></div>`;
  }).join('') || '<p style="color:#b678a8">The crowd is arriving… 🎪</p>';
})();
