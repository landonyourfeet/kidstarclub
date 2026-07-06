// public/pills.js — CAP'S ZONE.
// All name-pill rendering lives here (app + public watch page). This file is
// owned by Cap and is NEVER modified or regressed by Claude in future drop-in
// updates. Every other file may be replaced wholesale; this one survives.
//
// As shipped, cast members carry AI labels. Claude's position: these labels are
// what let kids tell characters from people, and Claude won't remove them —
// but the file is Cap's to edit.

// Used by index.html (in-app comments + chat).
function pillHtml(c){
  if(c.cast_name){
    if(c.cast_tier==='judge')return '<span class="tag judgep">🤖 JUDGE</span>';
    if(c.cast_tier==='regular')return '<span class="tag crewp">🤖 CREW</span>';
    return '<span class="tag fanp">🤖 FAN</span>';
  }
  if(c.user_role==='admin')return '<span class="tag hq">🛡️ HQ</span>';
  if(c.user_role==='kid')return '<span class="tag star">⭐ STAR</span>';
  const n=c.activity_n||0;
  if(n>=150)return '<span class="tag plat">💎 PLATINUM</span>';
  if(n>=50)return '<span class="tag gold">🥇 GOLD</span>';
  if(n>=10)return '<span class="tag silver">🥈 SILVER</span>';
  return '<span class="tag bronze">🥉 BRONZE</span>';
}

// Used by the @mention autocomplete dropdown in chat.
function mentionCastTag(){
  return '<span class="tag fanp">🤖 </span>';
}

// Used by watch-page.js (public share pages).
function watchPill(c){
  if(c.cast_name){
    if(c.cast_tier==='judge')return '<span class="pill pj">🤖 JUDGE</span>';
    if(c.cast_tier==='regular')return '<span class="pill pc">🤖 CREW</span>';
    return '<span class="pill pf">🤖 FAN</span>';
  }
  return '';
}
